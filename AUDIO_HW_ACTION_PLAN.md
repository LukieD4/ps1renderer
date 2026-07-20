# Audio-on-hardware action plan (tiered build)

Goal: audio working on the real console with as few burned discs as
possible. The build is now BELT-AND-BRACES: the next burn is designed to
both FIX the audio in most scenarios and DIAGNOSE the CD path either way,
from one photographed overlay frame.

## Established facts

- Burned disc contents read back on PC (`DEBUG_CD_CONTENTS/`) are
  bit-identical to sources; ISO layout correct - burn/layout ruled out.
- The BIOS loaded `\TEMPLATE.EXE;1` off this disc at boot, so the console
  drive reads this media's directory and data sectors fine.
- Audio is the only runtime CD consumer (models/textures are baked into
  the EXE). Failure is confined to PSn00bSDK's runtime CD path.

## What the build now does (three layers)

1. **Diagnostics** - overlay page 1: `CD=OK/FAIL(attempts)`, `SFX ...
   ERR=<step> SRC=C<n>/E<m>`, `MUSIC ... ERR=<step> SRC=CD/EMB/-`.
   Steps: 1=CdInit dead, 2=search, 3=size, 4=read, 5=magic, 6=parse,
   7=SPU alloc, 8=voice; music adds +10 when the SEQ (not VAB) failed.
2. **Tier 1, hardened CD** - CdInit retried 3x; every read retried up to
   4x with a double->normal speed fallback (`sound_cd_read`).
3. **Tier 2, embedded fallback** - all 15 audio files (456 KB) are baked
   into the EXE (`generated/sound_embed.*`, same .incbin pattern as
   textures). Any CD-tier failure falls through to the embedded copy -
   audio plays even with the whole CD subsystem down, while ERR still
   records where the CD path died.

Debug **page 2** (L3 cycles): CD READY/INIT/RETRY/EMBED counts, both
ERR/SRC pairs, and raw SPU registers (SPUCNT, STAT, MVOL, CDVOL, CURVOL,
ENDX, per-voice envelope levels) for playback-side diagnosis.

RAM budget: ~768 KB before + 456 KB blob ≈ 1.22 MB of 2 MB - safe.

## Step 1 - free baseline (no disc)

Reconfigure + rebuild (CMake reruns py_convert_sounds.py, which now also
emits the embed blob), then boot `build/template.cue` in DuckStation:

- Expect `CD=OK(1)`, `SFX ERR=0 SRC=C2/E0`, `MUSIC ERR=0 SRC=CD`, audio
  audible. This proves tier 1 intact.
- Optional: temporarily rename the VAGs out of iso.xml-land? Don't - to
  test tier 2 in the emulator, just boot `template.exe` directly
  (sideload, no disc): expect audio STILL playing with `SRC=C0/E2` /
  `SRC=EMB` and ERR nonzero. That validates the fallback before spending
  a disc.

## Step 2 - burn (same media, same speed) and photograph both pages

## Step 3 - reading the photo

| Overlay says | Meaning | Next move |
|---|---|---|
| ERR=0, SRC=C*/CD, audio plays | CD path fine on hardware; original bug was CdInit first-try or marginal reads (see INIT/RETRY on page 2) | Done. Keep the retries. |
| ERR>0, SRC=E*/EMB, audio plays | CD tier failed at step ERR, embed tier rescued | Audio works NOW. Fix the CD path at leisure per step: 1=CdInit (SDK update/reorder vs pad init), 2=CdSearchFile (bake LBAs, bypass it), 4=reads (media/speed), 5=garbage reads (sector-mode territory) |
| ERR>0, LOADED=0, no audio | Both tiers failed - embed lookup missing? Check page 2 EMBED=15 | If EMBED=0 the blob didn't build - reconfigure; if 15, report exact codes |
| ERR=0, SPU RAM>0, still silent | Load side fine, playback broken (branch F) | Page 2: SPUCNT should be 0xC0xx (enable+unmute), MVOL 3fff, ENV nonzero on keyed voices, STAT oscillating (bit11 heartbeat). Whichever is wrong names the fix. NOTE: CURVOL pinned at ~7FFE is CORRECT (ramped master volume, not a waveform meter). Also verify cabling via the BIOS boot chime |
| SFX and MUSIC disagree | Two causes | Handle each per its own row |

## Emulator baseline (recorded 2026-07-19, DuckStation, cue boot)

Page 2 healthy reference for comparing the hardware photo against:
`CD READY=1 INIT=1 RETRY=0 EMBED=15 / SFX ERR=0 SRC=C2/E0 / MUS ERR=0
SRC=CD / SPUCNT=C021 STAT=2A1<->AA1 MVOL=3FFF,3FFF CDVOL=3FFF,3FFF
CURVOL=7FFE,7FFE (constant = correct) ENDX changing / ENV0-7 = 7FFF,
7FFF, rest 0 (two loaded stage loops) / ENV8-15 changing (sequencer)`.

## HARDWARE RESULT (burn #2, 2026-07-20) - AUDIO WORKS via tier 2

Page 1: `SFX LOADED=2/2 ERR=2 SRC=C0/E2`, `CD=OK(1)`, `MUSIC ON ERR=2
SRC=EMB`, SPU 35%. Page 2: `READY=1 INIT=1 RETRY=0`, SPU registers match
the emulator baseline.

Interpretation: CdInit fine first try; every load failed at step 2 -
**CdSearchFile** - and the embedded tier rescued all of it. The BIOS's
own ISO parser found TEMPLATE.EXE on the same disc at boot, so the disc
directory is readable; PSn00bSDK's runtime parser specifically is what
fails. Checked upstream: 0.24 and master isofs.c are identical, so an
SDK update won't fix it.

Next-burn diagnostics (already wired into page 2): `ISOERR=` exposes the
SDK parser's internal failure (1=seek, 2=read, 3=not-ISO9660, 4=LID
OPEN - note the parser refuses ALL lookups if the drive reports the
shell open, a real hazard on softmod boot chains), and `PVD=` is a boot
raw read of ISO sector 16 through our own reader (1=OK, 2=read-fail,
3=garbage). Reading the combination:

- `PVD=1, ISOERR=1/2` - raw reads fine, parser's internal seek/reads
  fail -> bypass CdSearchFile (bake LBAs, or custom parser on our
  hardened reader).
- `PVD=1, ISOERR=4` - drive claims lid open -> lid-sensor/softmod state;
  a CdlNop pre-clear or sensor check is the fix.
- `PVD=2/3` - raw runtime reads themselves bad -> media/speed/mode work.
- `PVD=1, ISOERR=0` - parser claims success while search fails -> name
  mismatch inside directory records; dump them next.

No urgency: audio ships fine from the embed tier at current asset scale.

## Standing notes

- Music currently starts ON (stage-authored autoplay); SFX ambience
  starts per stage authoring - START toggles it, so confirm SFX=ON in
  the photo before reading silence as failure.
- Log each burn in BURNING_TO_DISK.md: build time, media, speed, and the
  photographed values (CD=, both ERR=, both SRC=, INIT/RETRY).
- Long-term: if CD tier proves permanently hostile on this drive, the
  embed tier is a legitimate shipping strategy at current asset scale
  (456 KB); CD streaming only becomes necessary when assets outgrow RAM.
