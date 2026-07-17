// root/sound.c
//
// SPU core: boot the SPU + CD drive, own the shared SPU RAM bump allocator.
//
// This module's v1 also loaded and played a single hardcoded WIND.VAG
// ambient (the loader's full CD -> VAG-parse -> SPU-upload path now lives,
// generalized, in sfx.c's sfx_load_vag() - see that file's header for the
// playback-path notes that used to live here). What remains here is only
// what every audio module shares: hardware bring-up and the RAM budget.

#include <stdint.h>

#include <psxspu.h>
#include <psxcd.h>
#include <psxetc.h>

#include "sound.h"

// ------------------------------------------------------------
// SPU RAM allocator
// ------------------------------------------------------------

// SPU RAM budget. The SPU has 512 KB (0x80000) total. The first 0x1000 bytes
// (4 KB) are reserved for the CD/voice capture buffers (see the SPU RAM map in
// PS1AUDIO_SEMANTICS.txt), and the reverb work area lives at the very top - so
// we allocate waveforms from 0x1010 upward. (If reverb is ever enabled, lower
// SPU_RAM_TOTAL by the reverb area size to keep this honest.)
#define SPU_RAM_TOTAL   0x80000         // 512 KB
#define SPU_ALLOC_BASE  0x1010          // first byte we hand out (above capture)

// Bump-allocator cursor into SPU RAM. sound_spu_reserve() advances it; every
// waveform (stage sfx and music banks, via their own modules) claims its
// slice through the allocator instead of hardcoding an address, so total
// SPU RAM usage stays packed and countable - which is what
// sound_spu_used()/free() report to the debug overlay.
static uint32_t spu_alloc_top = SPU_ALLOC_BASE;

// Whether CdInit() succeeded - checked by sfx.c/music.c before CD reads so
// a missing/broken disc degrades to silence rather than hanging a read.
static int cd_ready = 0;

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
// for stage teardown as long as modules release in reverse load order; can be
// replaced by a real free list later without touching callers.
void sound_spu_release(uint32_t bytes)
{
    uint32_t aligned = (bytes + 7u) & ~7u;
    if (aligned > spu_alloc_top - SPU_ALLOC_BASE)
        aligned = spu_alloc_top - SPU_ALLOC_BASE; // clamp: never below base
    spu_alloc_top -= aligned;
}

// ------------------------------------------------------------
// Init: boot SPU + CD
// ------------------------------------------------------------

void sound_init(void)
{
    cd_ready = 0;

    // SPU up first. SpuInit() resets the SPU, clears its RAM and sets the
    // transfer machinery up; must run after ResetGraph() (done in init()).
    SpuInit();

    // Master volume open, and route CD audio through the SPU at unity too -
    // harmless for pure voice playback now, and already correct for when XA
    // streaming (which mixes through these same CD volume registers) lands.
    SpuSetCommonMasterVolume(0x3fff, 0x3fff);
    SpuSetCommonCDVolume(0x3fff, 0x3fff);

    // CD up. CdInit() also requires the prior ResetGraph(); returns 0 on a
    // drive error (e.g. no disc) - record it so the loader modules bail to
    // silence rather than hang.
    if (CdInit())
        cd_ready = 1;
}

int sound_cd_ready(void)
{
    return cd_ready;
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
