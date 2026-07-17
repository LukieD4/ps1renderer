// root/sound.c
//
// SPU sound layer, v1: a looping ambient (wind) loaded from the CD.
//
// WHY CD-LOADED AND NOT BAKED INTO THE EXE
// ----------------------------------------
// Both work on real hardware (the EXE lives on the disc too). We load from the
// CD so the ~99 KB sample doesn't permanently sit in the 2 MB main RAM or
// inflate template.exe, and because this is the same psxcd path XA streaming
// will reuse later. The sample still ends up in the 512 KB SPU RAM regardless -
// SPU-ADPCM always plays from there; the CD only carries the bytes from disc
// to main RAM before the DMA into SPU RAM.
//
// PLAYBACK PATH
// -------------
//   CdSearchFile("\WIND.VAG;1") -> CdRead sectors into a main-RAM buffer
//   -> parse the 48-byte VAG header -> SpuWrite the body into SPU RAM
//   -> set one voice's start addr / pitch / volume / ADSR -> SpuSetKey on.
// The loop is entirely data-driven: the encoder wrote a loop-start flag (0x04)
// on the first body block and a loop-end flag (0x03) on the last, so the SPU
// latches the repeat address and jumps back on its own - no loop-address
// register write needed here.

#include <stdint.h>
#include <string.h>

#include <psxspu.h>
#include <psxcd.h>
#include <psxetc.h>

#include "sound.h"

// ------------------------------------------------------------
// Tunables
// ------------------------------------------------------------

// SPU RAM budget. The SPU has 512 KB (0x80000) total. The first 0x1000 bytes
// (4 KB) are reserved for the CD/voice capture buffers (see the SPU RAM map in
// PS1AUDIO_SEMANTICS.txt), and the reverb work area lives at the very top - so
// we allocate waveforms from 0x1010 upward. (If reverb is ever enabled, lower
// SPU_RAM_TOTAL by the reverb area size to keep this honest.)
#define SPU_RAM_TOTAL   0x80000         // 512 KB
#define SPU_ALLOC_BASE  0x1010          // first byte we hand out (above capture)

// Bump-allocator cursor into SPU RAM. sound_spu_reserve() advances it; every
// waveform (wind now, music banks and barks/caws via their own modules)
// claims its slice through the allocator instead of hardcoding an address,
// so total SPU RAM usage stays packed and countable - which is what
// sound_spu_used()/free() report to the debug overlay.
static uint32_t spu_alloc_top = SPU_ALLOC_BASE;

// Reserve `bytes` of SPU RAM (rounded up to the SPU's 8-byte address unit) and
// return the start byte address, or 0 if it wouldn't fit the budget. A caller
// that gets 0 should skip its upload rather than overwrite another sample.
// Public (sound.h) so sibling audio modules share the one budget.
uint32_t sound_spu_reserve(uint32_t bytes)
{
    uint32_t aligned = (bytes + 7u) & ~7u;
    if (spu_alloc_top + aligned > SPU_RAM_TOTAL)
        return 0;
    uint32_t addr = spu_alloc_top;
    spu_alloc_top += aligned;
    return addr;
}

// LIFO rewind: give back the most recent reservation (same rounding). Enough
// for scene teardown as long as modules release in reverse load order; can be
// replaced by a real free list later without touching callers.
void sound_spu_release(uint32_t bytes)
{
    uint32_t aligned = (bytes + 7u) & ~7u;
    if (aligned > spu_alloc_top - SPU_ALLOC_BASE)
        aligned = spu_alloc_top - SPU_ALLOC_BASE; // clamp: never below base
    spu_alloc_top -= aligned;
}

// SPU RAM byte address the wind waveform was placed at, returned by
// sound_spu_reserve() in sound_init() and reused by sound_wind_start() to
// point the voice at it.
static uint32_t wind_addr = 0;

// Voice (0..23) reserved for the wind loop. One-shots (barks/caws) will get
// their own voices in a later tier; keeping wind on a fixed channel means its
// volume can be nudged live without a voice-allocation table yet.
// Voice map: 0 = wind, 1..7 = future SFX, 8..23 = music (music.h).
#define WIND_CH         0

// Default ambient volume per channel, 0..0x3fff. Deliberately below full so it
// sits under the SFX that come later. sound_wind_set_volume() overrides this.
#define WIND_VOL        0x2000

// Upper bound on the VAG we'll load, rounded up to whole 2048-byte sectors.
// WIND.VAG is ~99 KB today; 128 KB leaves headroom. uint32_t array so the
// buffer is 32-bit aligned, which CdRead() requires.
#define SOUND_MAX_VAG_BYTES  (128 * 1024)
static uint32_t sound_vagbuf[SOUND_MAX_VAG_BYTES / 4];

// Our own "is the wind keyed on" flag (the SPU has no cheap read-back for it).
static int wind_playing = 0;

// Cached pitch register value parsed from the VAG header, so start/stop don't
// re-parse. Set in sound_init().
static uint16_t wind_pitch = 0;

// Whether the load actually succeeded - guards start/stop against a missing or
// oversized file so a bad disc just plays silence instead of keying a voice
// pointed at garbage SPU RAM.
static int wind_loaded = 0;

// Whether the loaded VAG actually contains loop flags (a loop-end block).
// A one-shot VAG (no loop) would play once and stop; surfacing this on screen
// (debug_text) makes "it went quiet after a few seconds" self-diagnosing.
static int wind_looped = 0;


// ------------------------------------------------------------
// Init: boot SPU + CD, load the VAG, upload to SPU RAM
// ------------------------------------------------------------
void sound_init(void)
{
    wind_playing = 0;
    wind_loaded  = 0;

    // SPU up first. SpuInit() resets the SPU, clears its RAM and sets the
    // transfer machinery up; must run after ResetGraph() (done in init()).
    SpuInit();

    // Master volume open, and route CD audio through the SPU at unity too -
    // harmless for pure voice playback now, and already correct for when XA
    // streaming (which mixes through these same CD volume registers) lands.
    SpuSetCommonMasterVolume(0x3fff, 0x3fff);
    SpuSetCommonCDVolume(0x3fff, 0x3fff);

    // CD up. CdInit() also requires the prior ResetGraph(); returns 0 on a
    // drive error (e.g. no disc) - bail to silence rather than hang.
    if (!CdInit())
        return;

    // Locate WIND.VAG in the ISO root. Leading backslash + ;1 version is the
    // psxcd convention; names are case-insensitive 8.3 (see iso.xml).
    CdlFILE file;
    if (!CdSearchFile(&file, "\\WIND.VAG;1"))
        return;

    if (file.size <= 48 || file.size > SOUND_MAX_VAG_BYTES)
        return; // too small to be a real VAG, or won't fit our load buffer

    // Read the whole file as whole 2048-byte sectors at double speed. CdRead
    // starts from the location set by CdlSetloc; CdReadSync(0,...) blocks until
    // every sector has landed (or returns <0 on a read error).
    int sectors = (file.size + 2047) / 2048;
    CdControl(CdlSetloc, (const uint8_t *)&file.pos, 0);
    CdRead(sectors, sound_vagbuf, CdlModeSpeed);
    if (CdReadSync(0, 0) < 0)
        return;

    const uint8_t *bytes = (const uint8_t *)sound_vagbuf;

    // Sanity-check the magic before trusting the header.
    if (!(bytes[0] == 'V' && bytes[1] == 'A' && bytes[2] == 'G' && bytes[3] == 'p'))
        return;

    // Sampling frequency is a BIG-ENDIAN field at offset 0x10 (the VAG header
    // is big-endian even though the console is little-endian - see the
    // semantics doc). Byte-swap by hand, then convert Hz -> SPU pitch register
    // via getSPUSampleRate() ( = (rate<<12)/44100; 22050 -> 0x800 ).
    uint32_t freq = ((uint32_t)bytes[0x10] << 24) |
                    ((uint32_t)bytes[0x11] << 16) |
                    ((uint32_t)bytes[0x12] <<  8) |
                    ((uint32_t)bytes[0x13]);
    if (freq == 0) freq = 22050; // defensive: never divide the pitch to 0
    wind_pitch = getSPUSampleRate(freq);

    // Body = everything after the 48-byte header. DMA it into SPU RAM at our
    // reserved address, then wait for the transfer to finish before any voice
    // could try to read it.
    const uint32_t *body = (const uint32_t *)(bytes + 48);
    uint32_t body_bytes  = (uint32_t)file.size - 48;

    // Reserve this waveform's slice of SPU RAM through the bump allocator, so
    // its footprint is counted and future sounds slot in after it. A 0 return
    // means the budget is exhausted - skip the upload rather than clobber RAM.
    wind_addr = sound_spu_reserve(body_bytes);
    if (wind_addr == 0)
        return;

    SpuSetTransferStartAddr(wind_addr);
    SpuWrite(body, body_bytes);
    SpuIsTransferCompleted(SPU_TRANSFER_WAIT);

    // Scan the body's per-block flag bytes (offset 1 of each 16-byte block)
    // for a loop-end marker so debug_text can report LOOP=Y/N. Match on the
    // loop-end+repeat BITS (0x03) rather than the exact value: a sample whose
    // loop starts on its final block carries the combined flag 0x07
    // (start+end+repeat), which is still a musical loop. Purely diagnostic -
    // the SPU loops off these same flags on its own.
    wind_looped = 0;
    for (uint32_t off = 0; off + 16 <= body_bytes; off += 16)
    {
        if ((((const uint8_t *)body)[off + 1] & 0x03) == 0x03)
        {
            wind_looped = 1;
            break;
        }
    }

    wind_loaded = 1;
}


// ------------------------------------------------------------
// Playback
// ------------------------------------------------------------
void sound_wind_start(void)
{
    if (!wind_loaded)
        return;

    SpuSetVoiceStartAddr(WIND_CH, wind_addr);
    SpuSetVoicePitch(WIND_CH, wind_pitch);
    SpuSetVoiceVolume(WIND_CH, WIND_VOL, WIND_VOL);

    // Envelope: reach full and HOLD there for a continuous ambient.
    //
    // We DON'T use SpuSetVoiceADSR() here: that macro hardcodes (1 << 14) in
    // ADSR2, which is the SUSTAIN DIRECTION = DECREASE bit. With a sustain rate
    // of 0 (fastest) that makes a held note decay to silence within a few ms of
    // key-on - i.e. no audible sound - which is wrong for a looping ambient.
    // It's meant for pitched instrument notes that are supposed to fade.
    //
    // Instead we write the registers directly for a sustain-INCREASE hold that
    // pins the level at max:
    //   ADSR1 = 0x100f -> ar=0x10 (smooth ~tens-of-ms attack, no click),
    //                     dr=0x00, sustain level sl=0x0f (max)
    //   ADSR2 = 0x000e -> sustain direction = increase (bit14 = 0, level rushes
    //                     to max and clamps), sustain rate 0, release rr=0x0e
    //                     (short fade when keyed off in sound_wind_stop)
    SPU_CH_ADSR1(WIND_CH) = 0x100f;
    SPU_CH_ADSR2(WIND_CH) = 0x000e;

    SpuSetKey(1, 1 << WIND_CH);
    wind_playing = 1;
}

void sound_wind_stop(void)
{
    if (!wind_loaded)
        return;

    // Key off -> enters the release phase (rr above) then goes silent. The
    // loop keeps running in SPU RAM; a later start() just keys it on again.
    SpuSetKey(0, 1 << WIND_CH);
    wind_playing = 0;
}

void sound_wind_toggle(void)
{
    if (wind_playing)
        sound_wind_stop();
    else
        sound_wind_start();
}

int sound_wind_playing(void)
{
    return wind_playing;
}

int sound_wind_loaded(void)
{
    return wind_loaded;
}

int sound_wind_is_looped(void)
{
    return wind_looped;
}

// ------------------------------------------------------------
// SPU RAM accounting (for the debug overlay)
// ------------------------------------------------------------
uint32_t sound_spu_used(void)
{
    return spu_alloc_top - SPU_ALLOC_BASE;
}

uint32_t sound_spu_capacity(void)
{
    return SPU_RAM_TOTAL - SPU_ALLOC_BASE;
}

uint32_t sound_spu_free(void)
{
    return sound_spu_capacity() - sound_spu_used();
}

void sound_wind_set_volume(int left, int right)
{
    if (left  < 0) left  = 0; if (left  > 0x3fff) left  = 0x3fff;
    if (right < 0) right = 0; if (right > 0x3fff) right = 0x3fff;
    SpuSetVoiceVolume(WIND_CH, (int16_t)left, (int16_t)right);
}
