// root/sound.h
//
// Minimal SPU core for the renderer: boots the SPU + CD drive and owns the
// SPU RAM bump allocator every audio module shares. Actual playback lives
// in the sibling modules - sfx.c (stage-driven looping ambients, voices
// 0..7) and music.c (VAB/SEQ sequencer, voices 8..23) - which reserve
// their waveform slices through sound_spu_reserve() so the debug overlay
// sees one authoritative budget.
//
// (v1 of this module also owned a hardcoded WIND.VAG ambient on voice 0;
// that moved to sfx.c when sounds became stage-authored - wind is now just
// a sound entity placed in stage-gen like any other.)
#pragma once

#include <stdint.h>
#include <psxcd.h>

// Call once, from init(), AFTER ResetGraph()/InitGeom() (CdInit and SpuInit
// both require the reset to have happened). Boots the SPU + CD and sets
// sensible master/CD volumes. Loads nothing itself - sfx.c/music.c do their
// own CD loads afterwards.
void sound_init(void);

// 1 if CdInit() succeeded at boot. sfx.c/music.c check this before
// attempting CD reads so a missing disc degrades to silence, not a hang.
int sound_cd_ready(void);

// How many CdInit() attempts boot took (1 = first try worked, up to
// SOUND_CD_INIT_TRIES = every try failed). Overlay diagnostic: emulators
// always succeed instantly, a real drive may need the retries - and if
// CD=FAIL after all tries, EVERY audio load is dead on arrival, which is
// the "works in DuckStation, silent on hardware" signature.
int sound_cd_init_attempts(void);

// CD-load failure steps, recorded by sfx.c/music.c at the FIRST point a
// load dies and shown on the debug overlay (SFXERR=/MUSERR=). The step
// pinpoints WHERE hardware diverges from emulation:
//   NOCD     - CdInit failed: nothing below ever ran
//   SEARCH   - CdSearchFile: ISO directory lookup failed (path/format/
//              directory-sector read problem)
//   SIZE     - file found but its size failed sanity bounds
//   READ     - CdRead/CdReadSync error: found + sized, sectors won't read
//   MAGIC    - read "succeeded" but the header magic is wrong (garbage
//              data - wrong sector mode / XA-form mismatch territory)
//   PARSE    - magic ok, header fields failed sanity checks (VAB/SEQ)
//   SPUALLOC - SPU RAM budget exhausted
//   VOICE    - hardware voice pool exhausted
// music.c adds 10 to the step when the SEQ (not the VAB) is the file that
// failed, so e.g. MUSERR=12 = SEQ not found, MUSERR=2 = VAB not found.
#define SND_ERR_NONE      0
#define SND_ERR_NOCD      1
#define SND_ERR_SEARCH    2
#define SND_ERR_SIZE      3
#define SND_ERR_READ      4
#define SND_ERR_MAGIC     5
#define SND_ERR_PARSE     6
#define SND_ERR_SPUALLOC  7
#define SND_ERR_VOICE     8
#define SND_ERR_SEQ_BASE  10 // music.c: added to the step for SEQ failures

// Hardened blocking CD read (up to 4 attempts: 2x double speed then 2x
// normal speed). Shared by sfx.c/music.c so every audio CD read gets the
// same retry/speed-fallback tier. sound_cd_retries() = total failed
// attempts that were retried (page-2 diagnostic; >0 with working audio
// means the retry tier is what saved it).
int sound_cd_read(const CdlLOC *loc, int sectors, uint32_t *dst);
int sound_cd_retries(void);

// Boot-time PVD probe (raw read of ISO sector 16 through sound_cd_read,
// bypassing libpsxcd's parser): 0 = not run, 1 = OK, 2 = read error,
// 3 = contents not a volume descriptor. Page-2 diagnostic.
int sound_pvd_status(void);

// libpsxcd's CdIsoError() from the last CdSearchFile: 0=okay, 1=seek,
// 2=read, 3=not-ISO9660, 4=lid open. Page-2 diagnostic - names WHERE
// inside the SDK parser a hardware-only search failure happened.
int sound_cd_iso_error(void);

// Embedded-audio fallback (tier 2). py_convert_sounds.py bakes every
// shipped audio file into the EXE (generated/sound_embed.*, same
// .incbin-blob pattern as textures); when a CD load fails at ANY step,
// sfx.c/music.c fall back to the embedded copy so audio works even with
// the whole CD subsystem down - while the ERR codes still report what
// the CD path did, so one burn both plays sound AND diagnoses.
//   sound_embed_find  - blob bytes + size for a cdPath ("\\WIND.VAG;1"),
//                       or NULL if not baked
//   sound_embed_count - total files baked into this EXE (0 = embedding
//                       disabled/regenerate needed)
const uint8_t *sound_embed_find(const char *cdPath, uint32_t *size);
int sound_embed_count(void);

// SPU RAM allocator, shared by every audio module.
//   sound_spu_reserve - claim `bytes` of SPU RAM (8-byte aligned); returns
//                       the start byte address, or 0 if it won't fit. A
//                       caller that gets 0 must skip its upload.
//   sound_spu_release - give back the MOST RECENT `bytes` reserved (LIFO
//                       rewind of the bump cursor; same rounding as reserve).
//                       Correct stage teardown = release in reverse order of
//                       reserve. A real free list can replace this later
//                       without changing callers.
uint32_t sound_spu_reserve(uint32_t bytes);
void     sound_spu_release(uint32_t bytes);

// SPU RAM accounting, in bytes. As sound effects are added they each reserve a
// slice of the 512 KB SPU RAM through the module's bump allocator; these report
// how much is spoken for vs. still free, so the debug overlay can show the
// budget filling up before an upload silently fails to fit.
//   sound_spu_used     - bytes of waveform data resident in SPU RAM
//   sound_spu_capacity - total bytes available to waveforms (512 KB minus the
//                        reserved capture area)
//   sound_spu_free     - capacity minus used
uint32_t sound_spu_used(void);
uint32_t sound_spu_capacity(void);
uint32_t sound_spu_free(void);
