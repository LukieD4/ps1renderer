// root/sfx.c
//
// Stage-driven sound effects layer (see sfx.h for scope and voice map).
//
// The CD -> VAG-parse -> SPU-upload path here is the generalized version of
// what sound.c v1 did for its single hardcoded WIND.VAG:
//
//   CdSearchFile(def->cdPath) -> CdRead sectors into a main-RAM buffer
//   -> parse the 48-byte VAG header -> SpuWrite the body into SPU RAM
//   -> set one voice's start addr / pitch / volume / ADSR -> SpuSetKey on.
//
// Loops stay entirely data-driven: the encoder writes loop-start/loop-end
// flags into the ADPCM blocks themselves, so the SPU repeats on its own.
//
// PLAYTHROUGH-END DETECTION (for ONCE/INTERVAL modes and muteAfterPlay):
// the SPU has no cheap "voice finished" read-back, so completion is a
// frame countdown computed at load time from the sample's real length:
//   samples = (body_bytes / 16) * 28    (SPU-ADPCM: 16-byte block = 28 samples)
//   rate    = (pitch * 44100) >> 12     (inverse of getSPUSampleRate())
//   frames  = samples * fps / rate      (+ a small pad for the release tail;
//                                        fps = 60 NTSC / 50 PAL, read from the
//                                        GPU video mode at load like music.c)
// ticked once per displayed frame by sfx_tick(), same VSync cadence as
// music_tick(). A looping VAG played in ONCE mode is keyed off by this
// timer at the end of its first pass, so mode always wins over the flags
// baked into the sample.

#include <stdint.h>
#include <string.h>

#include <psxspu.h>
#include <psxcd.h>
#include <psxetc.h>
#include <psxgpu.h>   // GetVideoMode(): PAL/NTSC frame rate for playFrames

#include "sound.h"
#include "sfx.h"

// ------------------------------------------------------------
// Load buffer
// ------------------------------------------------------------

// Upper bound on any single VAG we'll load, rounded up to whole 2048-byte
// sectors (WIND.VAG is ~99 KB; 128 KB leaves headroom). One shared buffer,
// reused per sound during the load loop - only the SPU-resident copy
// persists, so main RAM cost stays one buffer regardless of sound count.
// uint32_t array so the buffer is 32-bit aligned, which CdRead() requires.
#define SFX_MAX_VAG_BYTES  (128 * 1024)
static uint32_t sfx_vagbuf[SFX_MAX_VAG_BYTES / 4];

// Extra frames added to the computed playthrough length so the key-off
// lands after the audible tail, not on top of its final samples.
#define SFX_END_PAD_FRAMES 10

// ------------------------------------------------------------
// Per-stage sound slots
// ------------------------------------------------------------

typedef struct
{
    const STAGE_SOUND *def; // the baked stage data this slot was loaded from

    // Waveform (filled by sfx_load_vag / dedupe)
    uint32_t spu_addr;      // SPU RAM byte address of the waveform body
    uint32_t body_bytes;    // body size actually reserved/uploaded
    uint16_t pitch;         // SPU pitch register value from the VAG header
    uint8_t  looped;        // diagnostic: body carries a loop-end flag
    uint8_t  loaded;        // waveform is resident and voice is assigned
    uint8_t  owns_spu;      // 1 = this slot reserved its SPU slice (0 = deduped, shares an earlier slot's upload)
    int      voice;         // hardware voice (SFX_VOICE_FIRST..+COUNT-1), -1 if none

    // Playback state (driven by sfx_tick)
    uint32_t playFrames;    // frames one playthrough lasts (0 = unknown -> treated as loop-like, never "finishes")
    uint32_t framesLeft;    // countdown while keyed on (playthrough-completion timer)
    uint32_t startIn;       // stage-authored Delay: frames until this sound's FIRST activity (0 = already begun)
    uint32_t nextFireIn;    // INTERVAL: frames until the next key-on (0 = none scheduled)
    uint8_t  active;        // our own "voice is keyed on" flag (no SPU read-back)
    uint8_t  muted;         // muteAfterPlay latched: silent until stage reload
} SFX_SLOT;

static SFX_SLOT slots[SFX_MAX_STAGE_SOUNDS];
static unsigned int slotCount = 0;      // sounds the active stage authored (clamped)
static unsigned int loadedCount = 0;    // of those, how many are resident + voiced
static unsigned int unresolvedCount = 0;

// FIRST failure step of this stage's load pass (SND_ERR_* from sound.h,
// SND_ERR_NONE while everything resolved). Overlay diagnostic: UNRES>0
// says a sound didn't load, this says WHERE its load died - which is the
// difference between "file missing from the ISO" (SEARCH), "drive can't
// read it" (READ) and "read garbage" (MAGIC) when hardware disagrees
// with the emulator. First failure only: with a shared root cause every
// slot fails the same way, and the first is the untainted one.
static uint8_t firstErr = SND_ERR_NONE;

// How many of this stage's loaded sounds came off the CD vs. out of the
// EXE's embedded copy (tier-2 fallback). Overlay shows SRC=C<n>/E<m>:
// on a healthy disc E is 0; E>0 with audio playing means the CD path
// failed (see ERR=) and the embed tier rescued it.
static unsigned int srcCdCount  = 0;
static unsigned int srcEmbCount = 0;

static void sfx_record_err(uint8_t step)
{
    if (firstErr == SND_ERR_NONE)
        firstErr = step;
}
static unsigned int mutedCount = 0;     // latched by muteAfterPlay
static unsigned int musicCount = 0;     // mode==MUSIC entries (excluded from the sfx counts)
static int stagePlaying = 0;            // master ambience on/off flag

// The active stage's authored music entity (first mode==MUSIC sound
// with autoplay set - autoplay is the ENABLE toggle for music, so a
// stage can author several tracks and tick the one it wants) -
// recorded by sfx_stage_load(), consumed via sfx_stage_music() by the
// (future) stage-transition system; main.c reads stage 0's directly at
// boot to pick music_load()'s VAB/SEQ pair.
static const STAGE_SOUND *stageMusic = 0;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

// LCG random (numerical-recipes constants) - quality is irrelevant here,
// it only jitters bird-caw timing. Free-runs every tick so the sequence
// also depends on how long the stage has been up.
static uint32_t rng_state = 0x1234ABCD;

static uint32_t sfx_rand(void)
{
    rng_state = rng_state * 1664525u + 1013904223u;
    return rng_state >> 8; // drop the weakest (low) bits
}

// Uniform-ish pick in [lo, hi] (frames). Safe for lo == hi.
static uint32_t sfx_rand_range(uint32_t lo, uint32_t hi)
{
    if (hi <= lo)
        return lo;
    return lo + (sfx_rand() % (hi - lo + 1u));
}

// Integer square root (largest r with r*r <= v). ~16 iterations of the
// classic binary method; called at most SFX_MAX_STAGE_SOUNDS times per
// frame, so no need for anything cleverer.
static uint32_t sfx_isqrt(uint32_t v)
{
    uint32_t r = 0;
    uint32_t bit = 1u << 30;
    while (bit > v)
        bit >>= 2;
    while (bit)
    {
        if (v >= r + bit)
        {
            v -= r + bit;
            r = (r >> 1) + bit;
        }
        else
        {
            r >>= 1;
        }
        bit >>= 2;
    }
    return r;
}

// ------------------------------------------------------------
// Generic VAG loader (the old sound.c wind loader, parameterized)
// ------------------------------------------------------------

// sfx_load_vag (below) fetches `cdPath`'s VAG - tier 1 the disc, tier 2
// the EXE-embedded copy - reserves SPU RAM through sound.c's shared
// allocator, uploads the body, and fills `slot`'s waveform fields (not
// its voice - the caller assigns that). Returns 1 on success. On any
// failure the slot is left not-loaded and NO SPU RAM stays reserved, so
// the caller can just count it unresolved and move on.

// Tier-1 CD fetch: search + size bounds + hardened read (retries and a
// speed fallback via sound_cd_read) into sfx_vagbuf. Returns the bytes,
// or NULL with the failing step recorded for the overlay's SFXERR=.
static const uint8_t *sfx_cd_fetch(const char *cdPath, uint32_t *size)
{
    if (!sound_cd_ready())
    {
        sfx_record_err(SND_ERR_NOCD);
        return 0; // CdInit failed at boot - CD tier is down entirely
    }

    CdlFILE file;
    if (!CdSearchFile(&file, cdPath))
    {
        sfx_record_err(SND_ERR_SEARCH);
        return 0; // not found (typo'd sample name, iso.xml entry missing, or hardware directory-parse failure)
    }

    if (file.size <= 48 || file.size > SFX_MAX_VAG_BYTES)
    {
        sfx_record_err(SND_ERR_SIZE);
        return 0; // too small to be a real VAG, or won't fit our load buffer
    }

    if (!sound_cd_read(&file.pos, (int)((file.size + 2047) / 2048), sfx_vagbuf))
    {
        sfx_record_err(SND_ERR_READ);
        return 0; // every retry at both speeds failed
    }

    *size = (uint32_t)file.size;
    return (const uint8_t *)sfx_vagbuf;
}

static int sfx_load_vag(const char *cdPath, SFX_SLOT *slot)
{
    // Tier 1: the disc. On ANY failure - including a read that
    // "succeeds" but returns garbage (magic mismatch) - fall through to
    // tier 2, the copy baked into the EXE, so a hostile CD path costs
    // sound nothing while the recorded ERR step still diagnoses it.
    uint32_t fsize = 0;
    const uint8_t *bytes = sfx_cd_fetch(cdPath, &fsize);
    uint8_t fromEmbed = 0;

    if (bytes &&
        !(bytes[0] == 'V' && bytes[1] == 'A' && bytes[2] == 'G' && bytes[3] == 'p'))
    {
        sfx_record_err(SND_ERR_MAGIC);
        bytes = 0; // CD copy is garbage - try the embedded one
    }

    if (!bytes)
    {
        bytes = sound_embed_find(cdPath, &fsize);
        if (!bytes || fsize <= 48 ||
            !(bytes[0] == 'V' && bytes[1] == 'A' && bytes[2] == 'G' && bytes[3] == 'p'))
            return 0; // not baked in either (or embed data bad) - truly unresolved
        fromEmbed = 1;
    }

    // Sampling frequency is a BIG-ENDIAN field at offset 0x10 (the VAG
    // header is big-endian even though the console is little-endian - see
    // PS1AUDIO_SEMANTICS). Byte-swap by hand, then Hz -> SPU pitch via
    // getSPUSampleRate() ( = (rate<<12)/44100; 22050 -> 0x800 ).
    uint32_t freq = ((uint32_t)bytes[0x10] << 24) |
                    ((uint32_t)bytes[0x11] << 16) |
                    ((uint32_t)bytes[0x12] <<  8) |
                    ((uint32_t)bytes[0x13]);
    if (freq == 0) freq = 22050; // defensive: never divide the pitch to 0
    slot->pitch = getSPUSampleRate(freq);

    // Body = everything after the 48-byte header.
    const uint32_t *body = (const uint32_t *)(bytes + 48);
    uint32_t body_bytes  = fsize - 48;

    // Reserve this waveform's slice through the shared bump allocator so
    // it's counted in the debug overlay's SPU RAM budget. 0 = budget
    // exhausted - skip rather than clobber another sample.
    slot->spu_addr = sound_spu_reserve(body_bytes);
    if (slot->spu_addr == 0)
    {
        sfx_record_err(SND_ERR_SPUALLOC);
        return 0;
    }

    SpuSetTransferStartAddr(slot->spu_addr);
    SpuWrite(body, body_bytes);
    SpuIsTransferCompleted(SPU_TRANSFER_WAIT);

    // Scan the body's per-block flag bytes (offset 1 of each 16-byte
    // block) to decide whether this sample HARDWARE-loops MUSICALLY -
    // i.e. whether Loop mode can trust the SPU or must software-loop it
    // (see sfx_tick). This must be POSITIONAL, not a bare "any loop-end
    // bits anywhere" match, because one-shot encodes (our CAW/BARK
    // exports) end with a single all-zero TERMINATOR block flagged 0x07:
    // loop-start+end+repeat on the same silent final block, which parks
    // the voice looping 16 bytes of silence forever - loop FLAGS with no
    // musical loop. (A bare bit-match here marked those "looped", which
    // disabled the software loop and made Loop mode play once: the
    // CAW1 bug.) A real musical loop - like WIND.VAG, start flag on
    // block 1, end flag on the last audible block - has its loop-START
    // strictly BEFORE its loop-end, so that's what we require.
    {
        const uint8_t *b = (const uint8_t *)body;
        int32_t firstStart = -1; // first block with the loop-start bit (0x04)
        int32_t firstEnd   = -1; // first block with loop-end+repeat bits (0x03)
        int32_t block      = 0;

        for (uint32_t off = 0; off + 16 <= body_bytes; off += 16, block++)
        {
            uint8_t flags = b[off + 1];
            if ((flags & 0x04) && firstStart < 0)
                firstStart = block;
            if (((flags & 0x03) == 0x03) && firstEnd < 0)
                firstEnd = block;
        }

        slot->looped = (firstStart >= 0 && firstEnd > firstStart);
    }

    // One-playthrough length in frames, for the ONCE/INTERVAL countdown
    // (see this file's header comment for the math). freq is straight
    // from the header, already defaulted above if it was 0. The tick
    // cadence is the DISPLAYED frame rate, so use the real video mode
    // (60 NTSC / 50 PAL) - a flat 60 ran PAL countdowns ~20% long.
    {
        uint32_t samples = (body_bytes / 16u) * 28u;
        uint32_t fps = (GetVideoMode() == MODE_PAL) ? 50u : 60u;
        slot->playFrames = (samples * fps) / freq + SFX_END_PAD_FRAMES;
    }

    slot->body_bytes = body_bytes;
    slot->owns_spu   = 1;

    if (fromEmbed)
        srcEmbCount++;
    else
        srcCdCount++;
    return 1;
}

// ------------------------------------------------------------
// Voice control
// ------------------------------------------------------------

// Key `slot`'s voice on at its stage-authored base volume. Same envelope
// as the old wind: reach full and HOLD (sustain-INCREASE, level pinned at
// max). We DON'T use SpuSetVoiceADSR() - that macro hardcodes the
// sustain-DECREASE bit in ADSR2, which decays a held note to silence
// within milliseconds (meant for pitched instrument notes - see the
// sound.c v1 comment where this was first diagnosed).
//   ADSR1 = 0x100f -> ar=0x10 (smooth ~tens-of-ms attack, no click),
//                     dr=0x00, sustain level sl=0x0f (max)
//   ADSR2 = 0x000e -> sustain direction = increase (bit14 = 0), sustain
//                     rate 0, release rr=0x0e (short fade on key-off)
static void sfx_key_on(SFX_SLOT *slot)
{
    if (!slot->loaded || slot->voice < 0)
        return;

    SpuSetVoiceStartAddr(slot->voice, slot->spu_addr);
    SpuSetVoicePitch(slot->voice, slot->pitch);

    // Base volume; directional slots get overwritten by sfx_tick()'s
    // falloff/pan pass on the very next frame anyway.
    SpuSetVoiceVolume(slot->voice, (int16_t)slot->def->volume, (int16_t)slot->def->volume);

    SPU_CH_ADSR1(slot->voice) = 0x100f;
    SPU_CH_ADSR2(slot->voice) = 0x000e;

    SpuSetKey(1, 1 << slot->voice);
    slot->active = 1;
    slot->framesLeft = slot->playFrames; // meaningful for ONCE/INTERVAL; LOOP ignores it
}

static void sfx_key_off(SFX_SLOT *slot)
{
    if (slot->loaded && slot->voice >= 0)
        SpuSetKey(0, 1 << slot->voice); // release phase (rr in ADSR2) then silence
    slot->active = 0;
}

// ------------------------------------------------------------
// Stage load / unload
// ------------------------------------------------------------

void sfx_stage_unload(void)
{
    // Key everything off first so no voice is left reading SPU RAM we're
    // about to hand back.
    for (unsigned int i = 0; i < slotCount; i++)
        sfx_key_off(&slots[i]);

    // Release in REVERSE load order - the LIFO contract of
    // sound_spu_release() (it rewinds a bump cursor, not a free list).
    // Deduped slots never reserved anything, so they release nothing.
    for (int i = (int)slotCount - 1; i >= 0; i--)
    {
        if (slots[i].owns_spu)
            sound_spu_release(slots[i].body_bytes);
    }

    memset(slots, 0, sizeof(slots));
    slotCount = 0;
    loadedCount = 0;
    unresolvedCount = 0;
    firstErr = SND_ERR_NONE;
    srcCdCount = 0;
    srcEmbCount = 0;
    mutedCount = 0;
    musicCount = 0;
    stageMusic = 0;
    stagePlaying = 0;
}

// Begin one slot's mode behavior, AFTER its Delay has elapsed: loop and
// ONCE key straight on; INTERVAL schedules its first random fire (a
// random initial wait, not an immediate fire, so a flock of interval
// sounds doesn't all shout the moment the delay ends).
static void sfx_begin(SFX_SLOT *slot)
{
    if (slot->def->mode == SFX_MODE_INTERVAL)
    {
        slot->nextFireIn = sfx_rand_range(slot->def->intervalMinFrames,
                                          slot->def->intervalMaxFrames);
        if (slot->nextFireIn == 0)
            slot->nextFireIn = 1; // fire on the next tick, not never
    }
    else
    {
        sfx_key_on(slot);
    }
}

// (Re-)arm every loaded, non-muted autoplay slot: its stage-authored
// Delay counts down first (in sfx_tick), then sfx_begin() runs its mode.
// Shared by stage load and the START toggle's re-start (which therefore
// also replays the delay - a re-started ambience rebuilds identically to
// a fresh stage load).
void sfx_stage_start(void)
{
    int any = 0;
    for (unsigned int i = 0; i < slotCount; i++)
    {
        SFX_SLOT *slot = &slots[i];
        if (!slot->loaded || slot->muted || !slot->def->autoplay)
            continue;

        slot->startIn = slot->def->delayFrames;
        if (slot->startIn == 0)
            sfx_begin(slot);

        any = 1;
    }
    stagePlaying = any;
}

void sfx_stage_load(const STAGE_DEF *stage)
{
    sfx_stage_unload();

    if (stage == 0 || stage->sounds == 0 || stage->soundCount == 0)
        return; // stage authors no sounds - silence, nothing to diagnose

    unsigned int count = stage->soundCount < SFX_MAX_STAGE_SOUNDS
                       ? stage->soundCount : SFX_MAX_STAGE_SOUNDS;

    int nextVoice = SFX_VOICE_FIRST;

    for (unsigned int i = 0; i < count; i++)
    {
        SFX_SLOT *slot = &slots[i];
        slot->def   = &stage->sounds[i];
        slot->voice = -1;

        // Music entities aren't sfx voices at all: record the first
        // ENABLED one (autoplay is music's enable toggle - unticked
        // tracks are authored-but-disabled and never win the slot) for
        // sfx_stage_music() (its cdPath/cdPath2 name the VAB/SEQ pair
        // music.c plays) and leave the slot inert - no .VAG lookup
        // (there is none to find), no voice, not counted unresolved.
        if (slot->def->mode == SFX_MODE_MUSIC)
        {
            if (stageMusic == 0 && slot->def->autoplay)
                stageMusic = slot->def;
            musicCount++;
            continue;
        }

        // Dedupe: if an earlier slot already uploaded this exact CD path,
        // share its waveform instead of spending SPU RAM and a CD read on
        // a second identical copy. Each emitter still gets its OWN voice
        // (independent timing/volume, and directional needs per-emitter
        // pan/attenuation anyway).
        for (unsigned int j = 0; j < i; j++)
        {
            if (slots[j].loaded && strcmp(slots[j].def->cdPath, slot->def->cdPath) == 0)
            {
                slot->spu_addr   = slots[j].spu_addr;
                slot->body_bytes = slots[j].body_bytes;
                slot->pitch      = slots[j].pitch;
                slot->looped     = slots[j].looped;
                slot->playFrames = slots[j].playFrames;
                slot->owns_spu   = 0;
                slot->loaded     = 1;
                break;
            }
        }

        if (!slot->loaded && !sfx_load_vag(slot->def->cdPath, slot))
        {
            unresolvedCount++;
            continue;
        }

        // Pin a voice. Can't run out today (SFX_MAX_STAGE_SOUNDS ==
        // SFX_VOICE_COUNT), but the check keeps this honest if the caps
        // ever diverge - a voiceless sound counts as unresolved, visible
        // on the overlay, instead of silently aliasing another voice.
        if (nextVoice >= SFX_VOICE_FIRST + SFX_VOICE_COUNT)
        {
            sfx_record_err(SND_ERR_VOICE);
            slot->loaded = 0;
            unresolvedCount++;
            continue;
        }

        slot->voice  = nextVoice++;
        slot->loaded = 1;
        loadedCount++;
    }

    slotCount = count;

    sfx_stage_start();
}

// ------------------------------------------------------------
// Per-frame tick: timers + directional volume pass
// ------------------------------------------------------------

// Recompute one directional slot's L/R volume from the camera. Horizontal
// (X/Z) only - the stages are ground-plane scenes and vertical distance
// barely reads as audio anyway.
//
//   attenuation: linear inside def->radius (world units, baked *1024 like
//     positions). radius 0 = no falloff, pan only.
//   pan: the emitter offset is rotated into VIEW space by the camera's
//     yaw; viewX/dist is then the sine of the azimuth, mapped to a simple
//     "attenuate the far ear" law (center = full on both, hard side =
//     silent far ear). If pan ever feels MIRRORED on hardware, flip the
//     sign where noted - the isin/icos convention here was derived from
//     update_camera_matrix()'s transpose, not yet verified by ear, same
//     empirical-tuning caveat as main.c's OT_Z_SHIFT.
static void sfx_update_directional(SFX_SLOT *slot, const VECTOR *camPos, int camYaw)
{
    int32_t dx = slot->def->pos.vx - camPos->vx;
    int32_t dz = slot->def->pos.vz - camPos->vz;

    // Clamp components so dx*dx + dz*dz can't overflow 32 bits
    // (29000^2 * 2 < 2^31). Anything that far away is inaudible or
    // fully-far-panned regardless, so the clamp never changes the result.
    if (dx >  29000) dx =  29000;
    if (dx < -29000) dx = -29000;
    if (dz >  29000) dz =  29000;
    if (dz < -29000) dz = -29000;

    uint32_t dist = sfx_isqrt((uint32_t)(dx * dx) + (uint32_t)(dz * dz));

    // Distance attenuation
    int32_t vol = slot->def->volume;
    if (slot->def->radius > 0)
    {
        if (dist >= slot->def->radius)
            vol = 0;
        else
            vol = (vol * (int32_t)(slot->def->radius - dist)) / (int32_t)slot->def->radius;
    }

    // Pan (skip when effectively at the listener - direction is undefined
    // and the division below would blow up on a tiny denominator)
    int32_t left = vol, right = vol;
    if (dist > 64 && vol > 0)
    {
        int32_t s = isin(camYaw);
        int32_t c = icos(camYaw);

        // World -> view rotation, transpose of RotMatrix's yaw block
        // (matches update_camera_matrix()); >>12 back to world units.
        int32_t viewX = (dx * c - dz * s) >> 12; // flip this sign if pan is mirrored

        // sine of azimuth in 4096 fixed point, clamped for safety
        int32_t pan = (viewX << 12) / (int32_t)dist;
        if (pan >  4096) pan =  4096;
        if (pan < -4096) pan = -4096;

        // Attenuate the far ear only: center keeps full volume on both.
        if (pan > 0)      left  = (vol * (4096 - pan)) >> 12; // emitter to the right
        else if (pan < 0) right = (vol * (4096 + pan)) >> 12; // emitter to the left
    }

    SpuSetVoiceVolume(slot->voice, (int16_t)left, (int16_t)right);
}

void sfx_tick(const VECTOR *camPos, int camYaw)
{
    sfx_rand(); // free-run the RNG so interval picks depend on elapsed time

    if (!stagePlaying)
        return;

    for (unsigned int i = 0; i < slotCount; i++)
    {
        SFX_SLOT *slot = &slots[i];
        if (!slot->loaded || slot->muted)
            continue;

        // ---- Stage-authored Delay: nothing happens for this sound
        // until it elapses, in every mode ----
        if (slot->startIn > 0)
        {
            slot->startIn--;
            if (slot->startIn == 0)
                sfx_begin(slot);
        }
        else
        {
            // ---- Completion / re-fire timers. Needed by ONCE and
            // INTERVAL always, and by LOOP when the VAG carries no
            // hardware loop flags - Loop mode GUARANTEES looping by
            // re-keying such samples from the top each playthrough
            // (software loop), instead of trusting the encode (a
            // flag-less VAG would otherwise play once and go quiet -
            // the CAW1-on-loop bug). playFrames 0 means the length
            // couldn't be computed - treat as endless rather than
            // cutting audio off. ----
            int needsTimer = (slot->def->mode != SFX_MODE_LOOP) || !slot->looped;

            if (needsTimer && slot->playFrames > 0)
            {
                if (slot->active)
                {
                    if (slot->framesLeft > 0)
                        slot->framesLeft--;

                    if (slot->framesLeft == 0)
                    {
                        // Playthrough complete.
                        if (slot->def->mode == SFX_MODE_LOOP)
                        {
                            // Software loop: retrigger from the start
                            // (also resets framesLeft). No key-off in
                            // between - re-keying restarts the ADSR
                            // attack, which smooths the seam. Loop mode
                            // ignores muteAfterPlay, same as the
                            // hardware-looped case (a loop never
                            // "finishes").
                            sfx_key_on(slot);
                        }
                        else
                        {
                            sfx_key_off(slot);

                            if (slot->def->muteAfterPlay)
                            {
                                slot->muted = 1; // silent until stage reload (or a future trigger re-arm)
                                mutedCount++;
                                continue;
                            }

                            if (slot->def->mode == SFX_MODE_INTERVAL)
                            {
                                slot->nextFireIn = sfx_rand_range(slot->def->intervalMinFrames,
                                                                  slot->def->intervalMaxFrames);
                                if (slot->nextFireIn == 0)
                                    slot->nextFireIn = 1;
                            }
                            // ONCE without muteAfterPlay: stays silent
                            // until the START toggle (sfx_stage_start)
                            // replays it.
                        }
                    }
                }
                else if (slot->def->mode == SFX_MODE_INTERVAL && slot->nextFireIn > 0)
                {
                    slot->nextFireIn--;
                    if (slot->nextFireIn == 0)
                        sfx_key_on(slot);
                }
            }
        }

        // ---- Directional volume/pan, every frame while audible ----
        if (slot->active && slot->def->directional)
            sfx_update_directional(slot, camPos, camYaw);
    }
}

// ------------------------------------------------------------
// Playback (master ambience switch)
// ------------------------------------------------------------

void sfx_stage_stop(void)
{
    for (unsigned int i = 0; i < slotCount; i++)
    {
        sfx_key_off(&slots[i]);
        slots[i].nextFireIn = 0; // cancel pending interval fires
        slots[i].startIn = 0;    // cancel pending delayed starts
    }
    stagePlaying = 0;
}

void sfx_stage_toggle(void)
{
    if (stagePlaying)
        sfx_stage_stop();
    else
        sfx_stage_start();
}

int sfx_stage_playing(void)
{
    return stagePlaying;
}

// ------------------------------------------------------------
// Diagnostics (debug overlay)
// ------------------------------------------------------------

int sfx_stage_sound_count(void)
{
    // Music entities are stage-level markers, not sfx voices - excluded
    // so the overlay's LOADED=n/m can actually reach n == m.
    return (int)(slotCount - musicCount);
}

const STAGE_SOUND *sfx_stage_music(void)
{
    return stageMusic;
}

int sfx_stage_loaded_count(void)
{
    return (int)loadedCount;
}

int sfx_stage_unresolved_count(void)
{
    return (int)unresolvedCount;
}

int sfx_stage_muted_count(void)
{
    return (int)mutedCount;
}

int sfx_stage_first_error(void)
{
    return (int)firstErr;
}

int sfx_stage_src_cd_count(void)
{
    return (int)srcCdCount;
}

int sfx_stage_src_emb_count(void)
{
    return (int)srcEmbCount;
}
