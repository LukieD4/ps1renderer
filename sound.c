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

#include <string.h>

#include "sound.h"
#include "generated/sound_embed_table.h"

// ------------------------------------------------------------
// Embedded-audio lookup (tier-2 fallback, see sound.h)
// ------------------------------------------------------------

const uint8_t *sound_embed_find(const char *cdPath, uint32_t *size)
{
    unsigned int i;
    for (i = 0; i < sndEmbedEntryCount; i++)
    {
        if (strcmp(sndEmbedTable[i].cdPath, cdPath) == 0)
        {
            *size = sndEmbedTable[i].length;
            return snd_embed_start + sndEmbedTable[i].offset;
        }
    }
    return 0;
}

int sound_embed_count(void)
{
    return (int)sndEmbedEntryCount;
}

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

// CdInit() attempts made at boot (overlay diagnostic - see sound.h). A
// real drive fresh out of the BIOS boot can need a moment the emulated
// one never does, so sound_init() now retries instead of giving up on
// the first failure.
#define SOUND_CD_INIT_TRIES 3
static int cd_init_attempts = 0;

// Boot-time raw read of the ISO9660 volume descriptor sector (see the
// probe in sound_init): 0 = not run (CdInit failed), 1 = OK, 2 = read
// error, 3 = read succeeded but contents aren't a PVD.
static int pvd_status = 0;

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
    // silence rather than hang. Retried a few times: on real hardware the
    // drive can still be settling right after boot (especially via softmod
    // boot chains like FreePSXBoot) where an emulator's virtual drive is
    // ready instantly - a first-try-only CdInit is one plausible cause of
    // "audio silent on hardware, fine in DuckStation". The attempt count
    // is reported on the debug overlay (CD=OK(n)/FAIL(n)).
    for (cd_init_attempts = 1; cd_init_attempts <= SOUND_CD_INIT_TRIES; cd_init_attempts++)
    {
        if (CdInit())
        {
            cd_ready = 1;
            break;
        }
    }
    if (!cd_ready)
        cd_init_attempts = SOUND_CD_INIT_TRIES; // clamp the ++ overshoot for display

    // PVD probe: one raw read of sector 16 (the ISO9660 Primary Volume
    // Descriptor) through OUR read path, independent of libpsxcd's ISO
    // parser. Run once at boot, shown on debug page 2. Discriminates the
    // hardware CdSearchFile failure (ERR=2 on the first burn's photo):
    //   PVD=OK  + ISOERR!=0 -> raw reads fine, the SDK PARSER is what
    //                          fails (its internal seek/read/lid logic)
    //   PVD=RD  -> raw data reads themselves fail at runtime
    //   PVD=MAG -> reads "succeed" but return garbage (sector mode)
    if (cd_ready)
    {
        static uint32_t pvd_buf[2048 / 4];
        CdlLOC loc;
        CdIntToPos(16, &loc);
        if (!sound_cd_read(&loc, 1, pvd_buf))
            pvd_status = 2; // read failed even with retries/speed fallback
        else
        {
            const uint8_t *b = (const uint8_t *)pvd_buf;
            pvd_status = (b[0] == 0x01 &&
                          b[1] == 'C' && b[2] == 'D' && b[3] == '0' &&
                          b[4] == '0' && b[5] == '1') ? 1 : 3;
        }
    }
}

int sound_cd_ready(void)
{
    return cd_ready;
}

int sound_cd_init_attempts(void)
{
    return cd_init_attempts;
}

// ------------------------------------------------------------
// Hardened blocking CD read (shared by sfx.c / music.c)
// ------------------------------------------------------------

// Total individual read attempts that FAILED and were retried (overlay
// diagnostic, debug page 2). Nonzero on hardware with a clean result =
// marginal media/laser rescued by the retry tier.
static int cd_retry_count = 0;

// Blocking read of `sectors` 2048-byte sectors at `loc` into `dst`
// (32-bit aligned). Up to 4 attempts: two at double speed, then two at
// normal speed - a weak laser on CD-R media that flunks 2x reads will
// often pass at 1x, and an emulator never needs any of this (attempt 1
// always lands). Returns 1 on success.
int sound_cd_read(const CdlLOC *loc, int sectors, uint32_t *dst)
{
    int attempt;
    for (attempt = 0; attempt < 4; attempt++)
    {
        CdControl(CdlSetloc, (const uint8_t *)loc, 0);
        CdRead(sectors, dst, (attempt < 2) ? CdlModeSpeed : 0);
        if (CdReadSync(0, 0) >= 0)
            return 1;
        cd_retry_count++;
    }
    return 0;
}

int sound_cd_retries(void)
{
    return cd_retry_count;
}

int sound_pvd_status(void)
{
    return pvd_status;
}

// libpsxcd's internal ISO-parser status from the most recent
// CdSearchFile/CdOpenDir call (CdlIsoError in psxcd.h): 0=okay, 1=seek
// error, 2=read error, 3=not ISO9660, 4=lid open. Combined with the PVD
// probe this names the exact spot the hardware-only ERR=2 comes from.
int sound_cd_iso_error(void)
{
    return CdIsoError();
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
