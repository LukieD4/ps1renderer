// root/music.c
//
// VAB + SEQ music player, v1. See music.h for the module contract and the
// scene-asset roadmap. Format references: PS1AUDIO_SEMANTICS.txt §6-7 and
// psx-spx; the OST Studio exporter (suite/tools/audio-ost) writes exactly
// this layout.
//
// PIPELINE
//   music_load:
//     SONG.VAB -> CdRead in 32 KB chunks -> parse VH tables (main RAM)
//              -> stream VB waveform bytes into SPU RAM via sound_spu_reserve
//     SONG.SEQ -> CdRead whole (scores are a few KB) -> kept in main RAM
//   music_tick (once per frame):
//     fixed-point tick accumulator -> consume due MIDI-ish events ->
//     key voices on/off, batched into single SpuSetKey calls.
//
// WHY A FIXED-POINT ACCUMULATOR
//   ticks/second = ppq * 1,000,000 / usPerQuarter (from the SEQ header, or a
//   mid-song FF 51). Per elapsed VBLANK we add (ticks/second << 12) scaled
//   by the REAL vblank rate (NTSC is 59.94 Hz, not 60 - see
//   MUSIC_VSYNC_CHZ) and consume whole ticks, so tempo stays exact over
//   minutes even though ticks-per-frame is fractional.
//
// PARITY WITH THE DAW (suite/tools/audio-ost)
//   - fine pitch: the tone's fine-pitch byte (1/128 semitone) carries the
//     fractional part of the sample-rate compensation; without it a 16 kHz
//     sample plays up to 50 cents off the browser preview.
//   - pan: equal-power law (quarter-sine table), matching the Web Audio
//     StereoPanner the DAW previews with - NOT a linear pan.
//   - the DAW bakes track volume/transpose/mute into the SEQ at export, and
//     quantizes its preview envelopes through the same ADSR register
//     mapping, so both ends compute the same result by construction.
//
// LOOPING
//   The exporter marks the loop with NRPN CC 99 (0x63): value 20 = start,
//   value 30 = end (§7). At the start marker we checkpoint the parser
//   (offset, running status, pending delta); at the end marker - or end of
//   track - we restore it. Voices in release keep ringing across the seam,
//   which is exactly the behavior the DAW previews.

#include <stdint.h>
#include <string.h>

#include <psxspu.h>
#include <psxcd.h>
#include <psxgpu.h>   // VSync(-1): read the vblank counter without waiting

#include "sound.h"
#include "music.h"

// ------------------------------------------------------------
// Tunables / limits
// ------------------------------------------------------------

// Real vblank rate in CENTIHERTZ: NTSC fields at 59.94 Hz (60/1.001), PAL at
// 50.00. Using 60 flat would run music 0.1% slow (~2 s drift per half hour).
#define MUSIC_VSYNC_CHZ  (MUSIC_VSYNC_HZ == 60 ? 5994 : 5000)

// CD bounce buffer for streaming the VAB into SPU RAM. The whole VH
// (32 + 2048 + 512*progs + 512 bytes) must fit one chunk, which caps
// programs at 57; MUSIC_MAX_PROGRAMS keeps us comfortably inside.
#define CHUNK_BYTES         (32 * 1024)
#define CHUNK_SECTORS       (CHUNK_BYTES / 2048)
#define MUSIC_MAX_PROGRAMS  48
#define MUSIC_MAX_VAGS      64

// Whole SEQ kept resident; OST Studio scores are typically 1-4 KB.
#define MAX_SEQ_BYTES       (16 * 1024)

// uint32_t arrays so CdRead gets the 32-bit alignment it requires.
static uint32_t chunk_buf[CHUNK_BYTES / 4];
static uint32_t seq_buf[MAX_SEQ_BYTES / 4];

// ------------------------------------------------------------
// Bank state (parsed VH + SPU addresses)
// ------------------------------------------------------------

typedef struct {
    uint32_t spu_addr;   // waveform start in SPU RAM (0 = program silent)
    uint16_t adsr1, adsr2;
    uint8_t  center;     // center note, 44100-referenced (exporter compensates rate)
    uint8_t  fine;       // fine pitch, 1/128 semitone (fractional compensation)
    uint8_t  mvol;       // program master volume 0..127
    uint8_t  pan;        // program pan 0..127 (64 = center)
} Program;

static Program  progs[MUSIC_MAX_PROGRAMS];
static int      prog_count = 0;
static uint32_t bank_spu_bytes = 0;  // VB bytes resident in SPU RAM
static int      loaded = 0;

// ------------------------------------------------------------
// Sequencer state
// ------------------------------------------------------------

static const uint8_t *seq_ev = 0;    // event stream (past the 15-byte header)
static uint32_t seq_len = 0;         // event stream length in bytes
static uint32_t seq_ppq = 480;

static uint32_t pos = 0;             // parse offset into seq_ev
static uint8_t  running = 0;         // MIDI running status
static int32_t  wait_ticks = 0;      // delta ticks until the next event
static uint32_t acc = 0;             // 20.12 fixed-point tick accumulator
static uint32_t tick_inc = 0;        // ticks<<12 advanced per vblank
static int      playing = 0;
static int      ended = 0;
static int      last_vsync = 0;      // VSync(-1) reading at the previous tick

// loop checkpoint (NRPN start marker)
static int      loop_valid = 0;
static uint32_t loop_pos = 0;
static uint8_t  loop_running = 0;

// per-MIDI-channel selected program
static uint8_t  ch_prog[16];

// master music volume (per side), see music_set_volume()
static int      mus_vol_l = 0x3000, mus_vol_r = 0x3000;

// ------------------------------------------------------------
// Voice pool
// ------------------------------------------------------------

typedef struct {
    uint8_t  active;     // slot owns a sounding (or releasing) note
    uint8_t  released;   // keyed off, ringing out
    uint8_t  ch, note;   // for note-off matching
    uint8_t  vel;        // kept to re-apply volume live
    uint8_t  prog;
    uint32_t age;        // note-on order, for stealing
} MVoice;

static MVoice   voices[MUSIC_VOICE_COUNT];
static uint32_t voice_age = 0;

// 2^(n/12) in 4.12 fixed point; pitch register 0x1000 = native 44100 Hz.
static const uint16_t semitab[12] = {
    4096, 4340, 4598, 4871, 5161, 5468, 5793, 6137, 6502, 6889, 7298, 7732
};

// 2^(-f/1536) in 1.15 fixed point, f = fine-pitch byte (1/128 semitone).
// Applied as a downward correction: a higher effective center note means
// this sample must play slightly LOWER for a given written note.
static const uint16_t finetab[128] = {
    32768, 32753, 32738, 32724, 32709, 32694, 32679, 32665,
    32650, 32635, 32620, 32606, 32591, 32576, 32562, 32547,
    32532, 32518, 32503, 32488, 32474, 32459, 32444, 32430,
    32415, 32400, 32386, 32371, 32357, 32342, 32327, 32313,
    32298, 32284, 32269, 32255, 32240, 32225, 32211, 32196,
    32182, 32167, 32153, 32138, 32124, 32109, 32095, 32080,
    32066, 32051, 32037, 32022, 32008, 31994, 31979, 31965,
    31950, 31936, 31921, 31907, 31893, 31878, 31864, 31850,
    31835, 31821, 31806, 31792, 31778, 31763, 31749, 31735,
    31720, 31706, 31692, 31678, 31663, 31649, 31635, 31620,
    31606, 31592, 31578, 31563, 31549, 31535, 31521, 31506,
    31492, 31478, 31464, 31450, 31435, 31421, 31407, 31393,
    31379, 31365, 31350, 31336, 31322, 31308, 31294, 31280,
    31266, 31252, 31237, 31223, 31209, 31195, 31181, 31167,
    31153, 31139, 31125, 31111, 31097, 31083, 31069, 31055,
    31041, 31027, 31013, 30999, 30985, 30971, 30957, 30943
};

// Equal-power pan: sin(i/127 * pi/2) in 1.15 fixed point. Matches the Web
// Audio StereoPanner the DAW previews with (center ~= 0.707 per side), so a
// panned instrument sits at the same relative level in-game as in the tool.
static const uint16_t pantab[128] = {
        0,   405,   810,  1216,  1620,  2025,  2429,  2833,
     3237,  3640,  4042,  4444,  4845,  5246,  5646,  6044,
     6442,  6839,  7235,  7630,  8023,  8415,  8806,  9196,
     9584,  9971, 10357, 10740, 11122, 11503, 11881, 12258,
    12633, 13006, 13377, 13746, 14113, 14477, 14840, 15200,
    15558, 15913, 16266, 16617, 16965, 17310, 17653, 17993,
    18331, 18665, 18997, 19325, 19651, 19974, 20294, 20610,
    20924, 21234, 21541, 21845, 22145, 22442, 22736, 23026,
    23313, 23596, 23875, 24151, 24423, 24691, 24956, 25216,
    25473, 25726, 25975, 26220, 26461, 26698, 26931, 27160,
    27385, 27605, 27821, 28033, 28241, 28444, 28643, 28838,
    29028, 29214, 29395, 29572, 29744, 29912, 30075, 30234,
    30388, 30537, 30682, 30822, 30957, 31087, 31213, 31334,
    31450, 31561, 31668, 31770, 31866, 31958, 32045, 32127,
    32205, 32277, 32344, 32407, 32464, 32517, 32564, 32607,
    32644, 32677, 32704, 32727, 32744, 32757, 32764, 32767
};

static uint16_t pitch_for(int note, int center, int fine)
{
    int d = note - center;
    int oct = d / 12, semi = d % 12;
    if (semi < 0) { semi += 12; oct--; }
    uint32_t p = semitab[semi];
    if (oct >= 0) p <<= oct; else p >>= -oct;
    p = (p * finetab[fine & 0x7f]) >> 15;   // fractional center-note correction
    if (p > 0x3fff) p = 0x3fff;   // SPU pitch register ceiling (+2 octaves)
    if (p < 1)      p = 1;
    return (uint16_t)p;
}

// velocity(0..127) x program volume(0..127) x master, equal-power pan split.
static void voice_volume(const Program *pg, int vel, int16_t *l, int16_t *r)
{
    // 0..0x3fff base
    uint32_t v = ((uint32_t)vel * pg->mvol * 0x3fff) / (127 * 127);
    int pan = pg->pan > 127 ? 127 : pg->pan;
    uint32_t vl = (v * pantab[127 - pan]) >> 15;
    uint32_t vr = (v * pantab[pan]) >> 15;
    *l = (int16_t)((vl * mus_vol_l) >> 14);
    *r = (int16_t)((vr * mus_vol_r) >> 14);
}

// ------------------------------------------------------------
// CD helpers
// ------------------------------------------------------------

// Read `sectors` sectors starting `sector_off` sectors into `file` (blocking).
static int cd_read_at(const CdlFILE *file, int sector_off, int sectors, uint32_t *dst)
{
    CdlLOC loc;
    CdIntToPos(CdPosToInt((CdlLOC *)&file->pos) + sector_off, &loc);
    CdControl(CdlSetloc, (const uint8_t *)&loc, 0);
    CdRead(sectors, dst, CdlModeSpeed);
    return CdReadSync(0, 0) >= 0;
}

// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------

static int load_vab(const char *path)
{
    CdlFILE file;
    if (!CdSearchFile(&file, (char *)path))
        return 0;

    int total_sectors = (int)((file.size + 2047) / 2048);
    int first = total_sectors < CHUNK_SECTORS ? total_sectors : CHUNK_SECTORS;
    if (!cd_read_at(&file, 0, first, chunk_buf))
        return 0;

    const uint8_t *vh = (const uint8_t *)chunk_buf;

    // magic: bytes "pBAV" (the 32-bit ID "VABp", little-endian on disc)
    if (!(vh[0] == 'p' && vh[1] == 'B' && vh[2] == 'A' && vh[3] == 'V'))
        return 0;

    prog_count = vh[0x12] | (vh[0x13] << 8);
    int vag_count = vh[0x16] | (vh[0x17] << 8);
    if (prog_count <= 0 || prog_count > MUSIC_MAX_PROGRAMS) return 0;
    if (vag_count  <= 0 || vag_count  > MUSIC_MAX_VAGS)     return 0;

    uint32_t vh_size = 0x20 + 2048 + (uint32_t)prog_count * 512 + 512;
    if (vh_size > (uint32_t)first * 2048) return 0; // VH must fit the first chunk

    // VAG pointer table: entry 0 is a dummy; vag n's size = tbl[n] << 3.
    const uint8_t *vt = vh + 0x20 + 2048 + (uint32_t)prog_count * 512;
    uint32_t vag_size[MUSIC_MAX_VAGS + 1];
    uint32_t vb_size = 0;
    int n;
    for (n = 1; n <= vag_count; n++) {
        vag_size[n] = (uint32_t)(vt[n * 2] | (vt[n * 2 + 1] << 8)) << 3;
        vb_size += vag_size[n];
    }
    if (vb_size == 0 || vh_size + vb_size > file.size + 2047) return 0;

    // Reserve SPU RAM through sound.c's allocator (counted in the overlay).
    uint32_t base = sound_spu_reserve(vb_size);
    if (base == 0) return 0;
    bank_spu_bytes = vb_size;

    // Per-vag SPU addresses by prefix sum.
    uint32_t vag_addr[MUSIC_MAX_VAGS + 1];
    uint32_t at = base;
    for (n = 1; n <= vag_count; n++) { vag_addr[n] = at; at += vag_size[n]; }

    // Programs: our exporter writes one tone per used program; take tone 0.
    const uint8_t *pa = vh + 0x20;
    const uint8_t *ta = vh + 0x20 + 2048;
    int p;
    for (p = 0; p < prog_count; p++) {
        const uint8_t *pr = pa + p * 16;
        const uint8_t *tn = ta + (p * 16) * 32;    // tone 0 of program p
        int vag = tn[22] | (tn[23] << 8);          // 1-based reference
        Program *pg = &progs[p];
        if (pr[0] == 0 || vag < 1 || vag > vag_count) {
            pg->spu_addr = 0;                      // toneless program = silent
            continue;
        }
        pg->spu_addr = vag_addr[vag];
        pg->center   = tn[4];
        pg->fine     = tn[5] & 0x7f;
        pg->adsr1    = (uint16_t)(tn[16] | (tn[17] << 8));
        pg->adsr2    = (uint16_t)(tn[18] | (tn[19] << 8));
        pg->mvol     = pr[1];
        pg->pan      = pr[4];
    }

    // Stream the VB into SPU RAM: whatever of it sits in the current chunk,
    // then refill the bounce buffer sector by sector until done.
    uint32_t written = 0;
    uint32_t chunk_base = 0;                        // file offset of chunk_buf[0]
    uint32_t chunk_bytes = (uint32_t)first * 2048;
    while (written < vb_size) {
        uint32_t src_off = vh_size + written;       // file offset of next VB byte
        if (src_off >= chunk_base + chunk_bytes) {  // need the next chunk
            int sec = (int)(src_off / 2048);
            int nsec = total_sectors - sec;
            if (nsec > CHUNK_SECTORS) nsec = CHUNK_SECTORS;
            if (nsec <= 0 || !cd_read_at(&file, sec, nsec, chunk_buf))
                return 0;
            chunk_base = (uint32_t)sec * 2048;
            chunk_bytes = (uint32_t)nsec * 2048;
        }
        uint32_t avail = chunk_base + chunk_bytes - src_off;
        uint32_t n_up = vb_size - written;
        if (n_up > avail) n_up = avail;

        SpuSetTransferStartAddr(base + written);
        SpuWrite((const uint32_t *)((const uint8_t *)chunk_buf + (src_off - chunk_base)), n_up);
        SpuIsTransferCompleted(SPU_TRANSFER_WAIT);
        written += n_up;
    }
    return 1;
}

// ticks/second -> accumulator increment per vblank, against the REAL
// centihertz vblank rate (59.94 NTSC / 50.00 PAL).
static uint32_t inc_for(uint32_t tps)
{
    return (uint32_t)(((uint64_t)tps << 12) * 100u / MUSIC_VSYNC_CHZ);
}

static int load_seq(const char *path)
{
    CdlFILE file;
    if (!CdSearchFile(&file, (char *)path))
        return 0;
    if (file.size < 16 || file.size > MAX_SEQ_BYTES)
        return 0;
    if (!cd_read_at(&file, 0, (int)((file.size + 2047) / 2048), seq_buf))
        return 0;

    const uint8_t *s = (const uint8_t *)seq_buf;
    if (!(s[0] == 'p' && s[1] == 'Q' && s[2] == 'E' && s[3] == 'S'))
        return 0;

    seq_ppq = ((uint32_t)s[8] << 8) | s[9];                    // BE u16
    uint32_t uspq = ((uint32_t)s[10] << 16) | ((uint32_t)s[11] << 8) | s[12];
    if (!seq_ppq) seq_ppq = 480;
    if (!uspq) uspq = 500000;

    tick_inc = inc_for((uint32_t)(((uint64_t)seq_ppq * 1000000u) / uspq));

    seq_ev = s + 15;                                           // past header
    seq_len = (uint32_t)file.size - 15;
    return 1;
}

int music_load(const char *vab_path, const char *seq_path)
{
    music_stop();
    loaded = 0;
    bank_spu_bytes = 0;
    prog_count = 0;
    if (!load_vab(vab_path)) return 0;
    if (!load_seq(seq_path)) return 0;
    loaded = 1;
    return 1;
}

void music_unload(void)
{
    music_stop();
    if (bank_spu_bytes) sound_spu_release(bank_spu_bytes);
    bank_spu_bytes = 0;
    loaded = 0;
}

// ------------------------------------------------------------
// Sequencer
// ------------------------------------------------------------

static uint32_t read_vlq(void)
{
    uint32_t v = 0;
    uint8_t b;
    do {
        if (pos >= seq_len) { ended = 1; return 0; }
        b = seq_ev[pos++];
        v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
}

static int alloc_voice(void)
{
    int i, best = 0;
    uint32_t best_age = 0xffffffffu;
    for (i = 0; i < MUSIC_VOICE_COUNT; i++)
        if (!voices[i].active) return i;
    // steal: prefer the oldest released voice, else the oldest outright
    for (i = 0; i < MUSIC_VOICE_COUNT; i++)
        if (voices[i].released && voices[i].age < best_age) { best = i; best_age = voices[i].age; }
    if (best_age == 0xffffffffu)
        for (i = 0; i < MUSIC_VOICE_COUNT; i++)
            if (voices[i].age < best_age) { best = i; best_age = voices[i].age; }
    return best;
}

static void note_on(int ch, int note, int vel, uint32_t *on_mask)
{
    const Program *pg;
    int prog = ch_prog[ch];
    if (prog >= prog_count) return;
    pg = &progs[prog];
    if (!pg->spu_addr) return;

    int i = alloc_voice();
    int hw = MUSIC_VOICE_FIRST + i;
    int16_t l, r;
    voice_volume(pg, vel, &l, &r);

    SpuSetVoiceStartAddr(hw, pg->spu_addr);
    SpuSetVoicePitch(hw, pitch_for(note, pg->center, pg->fine));
    SpuSetVoiceVolume(hw, l, r);
    SPU_CH_ADSR1(hw) = pg->adsr1;
    SPU_CH_ADSR2(hw) = pg->adsr2;

    voices[i].active = 1; voices[i].released = 0;
    voices[i].ch = (uint8_t)ch; voices[i].note = (uint8_t)note;
    voices[i].vel = (uint8_t)vel; voices[i].prog = (uint8_t)prog;
    voices[i].age = voice_age++;
    *on_mask |= 1u << hw;
}

static void note_off(int ch, int note, uint32_t *off_mask)
{
    int i;
    for (i = 0; i < MUSIC_VOICE_COUNT; i++) {
        if (voices[i].active && !voices[i].released &&
            voices[i].ch == ch && voices[i].note == note) {
            voices[i].released = 1;
            *off_mask |= 1u << (MUSIC_VOICE_FIRST + i);
            return;
        }
    }
}

static void all_music_off(void)
{
    uint32_t mask = 0;
    int i;
    for (i = 0; i < MUSIC_VOICE_COUNT; i++) {
        if (voices[i].active) mask |= 1u << (MUSIC_VOICE_FIRST + i);
        voices[i].active = 0; voices[i].released = 0;
    }
    if (mask) SpuSetKey(0, mask);
}

static void rewind_to_start(void)
{
    pos = 0; running = 0; ended = 0; acc = 0;
    memset(ch_prog, 0, sizeof(ch_prog));
    wait_ticks = (int32_t)read_vlq();  // prefetch the first delta
}

// Consume ONE event at the current position (delta already elapsed), then
// prefetch the next delta into wait_ticks.
static void process_event(uint32_t *on_mask, uint32_t *off_mask)
{
    if (pos >= seq_len) { ended = 1; return; }

    uint8_t b = seq_ev[pos];
    if (b & 0x80) { running = b; pos++; }
    uint8_t st = running;
    uint8_t type = st & 0xf0, ch = st & 0x0f;

    if (st == 0xff) {                        // meta
        uint8_t mt = seq_ev[pos++];
        if (mt == 0x51) {                    // tempo: 3 bytes, NO length (SEQ quirk)
            uint32_t uspq = ((uint32_t)seq_ev[pos] << 16) |
                            ((uint32_t)seq_ev[pos + 1] << 8) | seq_ev[pos + 2];
            pos += 3;
            if (uspq)
                tick_inc = inc_for((uint32_t)(((uint64_t)seq_ppq * 1000000u) / uspq));
        } else if (mt == 0x2f) {             // end of track (followed by 0x00)
            pos++;
            ended = 1;
            return;
        } else {                             // unknown meta: SMF-style skip
            uint32_t len = read_vlq();
            pos += len;
        }
    } else if (type == 0x90) {
        uint8_t note = seq_ev[pos++], vel = seq_ev[pos++];
        if (vel) note_on(ch, note, vel, on_mask);
        else     note_off(ch, note, off_mask);
    } else if (type == 0x80) {
        uint8_t note = seq_ev[pos++]; pos++;
        note_off(ch, note, off_mask);
    } else if (type == 0xc0) {
        ch_prog[ch] = seq_ev[pos++] & 0x7f;
    } else if (type == 0xb0) {
        uint8_t cc = seq_ev[pos++], val = seq_ev[pos++];
        if (cc == 0x63) {                    // NRPN MSB: loop markers (§7)
            if (val == 20) {                 // loop start: checkpoint parser
                loop_valid = 1;
                loop_pos = pos;
                loop_running = running;
            } else if (val == 30 && loop_valid) { // loop end: jump back
                pos = loop_pos;
                running = loop_running;
            }
        }
        // other CCs (bank select etc.): payload already consumed
    } else if (type == 0xd0) {
        pos++;
    } else if (type == 0xa0 || type == 0xe0) {
        pos += 2;
    } else {
        pos++;                               // unknown: best-effort advance
    }

    wait_ticks = (int32_t)read_vlq();
}

void music_play(void)
{
    if (!loaded) return;
    all_music_off();
    loop_valid = 0;
    rewind_to_start();
    last_vsync = VSync(-1);
    playing = 1;
}

void music_stop(void)
{
    playing = 0;
    all_music_off();
}

int music_playing(void) { return playing; }

void music_tick(void)
{
    if (!playing || !loaded) return;

    uint32_t on_mask = 0, off_mask = 0;

    // Tempo is anchored to REAL vblanks, not to how often this function gets
    // called: a double-buffered renderer that presents every other vblank
    // calls us at ~30 Hz even though vblank is 60 Hz, and assuming one
    // vblank per call would halve the music speed. VSync(-1) reads the
    // vblank counter without waiting; we advance the accumulator by however
    // many vblanks actually elapsed since the last tick. Clamped so a long
    // hitch (CD seek, debugger pause) slews instead of machine-gunning a
    // burst of events.
    int now_v = VSync(-1);
    int dv = now_v - last_vsync;
    last_vsync = now_v;
    if (dv < 1) dv = 1;
    if (dv > MUSIC_VSYNC_HZ / 4) dv = MUSIC_VSYNC_HZ / 4;   // >250 ms hitch: slew

    acc += tick_inc * (uint32_t)dv;
    int steps = (int)(acc >> 12);
    acc &= 0x0fff;

    while (steps > 0 && !ended) {
        if (wait_ticks > 0) {
            int take = wait_ticks < steps ? wait_ticks : steps;
            wait_ticks -= take;
            steps -= take;
        }
        // guard: a degenerate zero-length loop must not spin forever
        int safety = 4096;
        while (wait_ticks == 0 && !ended && safety--)
            process_event(&on_mask, &off_mask);
        if (safety <= 0) { ended = 1; }
    }

    if (ended) {
        if (loop_valid) {                    // EOT with a start marker but no
            pos = loop_pos;                  // end marker: loop the whole tail
            running = loop_running;
            ended = 0;
            wait_ticks = (int32_t)read_vlq();
        } else {
            playing = 0;                     // one-shot song: let releases ring
        }
    }

    // batch the hardware key changes: offs first, then ons
    if (off_mask) SpuSetKey(0, off_mask);
    if (on_mask)  SpuSetKey(1, on_mask);
}

// ------------------------------------------------------------
// Volume / diagnostics
// ------------------------------------------------------------

void music_set_volume(int left, int right)
{
    if (left  < 0) left  = 0;
    if (left  > 0x3fff) left  = 0x3fff;
    if (right < 0) right = 0;
    if (right > 0x3fff) right = 0x3fff;
    mus_vol_l = left; mus_vol_r = right;

    // push onto voices already sounding
    int i;
    for (i = 0; i < MUSIC_VOICE_COUNT; i++) {
        if (!voices[i].active) continue;
        const Program *pg = &progs[voices[i].prog];
        int16_t l, r;
        voice_volume(pg, voices[i].vel, &l, &r);
        SpuSetVoiceVolume(MUSIC_VOICE_FIRST + i, l, r);
    }
}

int music_voices_active(void)
{
    int i, n = 0;
    for (i = 0; i < MUSIC_VOICE_COUNT; i++)
        if (voices[i].active && !voices[i].released) n++;
    return n;
}

uint32_t music_spu_used(void) { return bank_spu_bytes; }
int music_loaded(void) { return loaded; }
