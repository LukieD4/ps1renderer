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

// Call once, from init(), AFTER ResetGraph()/InitGeom() (CdInit and SpuInit
// both require the reset to have happened). Boots the SPU + CD and sets
// sensible master/CD volumes. Loads nothing itself - sfx.c/music.c do their
// own CD loads afterwards.
void sound_init(void);

// 1 if CdInit() succeeded at boot. sfx.c/music.c check this before
// attempting CD reads so a missing disc degrades to silence, not a hang.
int sound_cd_ready(void);

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
