// root/music.h
//
// VAB + SEQ music player for PSn00bSDK 0.24 (which ships no libsnd, so this
// module IS the sequencer). Plays the .vab/.seq pair exported by the suite's
// OST Studio tool; the parsers follow the real PsyQ formats (psx-spx), so
// third-party banks that stick to v7 layout load too.
//
// DEPENDS ON sound.c: call music_load() after sound_init() (SPU + CD up,
// bump allocator ready). Waveforms are reserved through sound_spu_reserve()
// so they show up in the same debug-overlay RAM budget as the wind.
//
// VOICE MAP (24 hardware voices):
//   0..7     stage-driven SFX      (sfx.c - looping ambients now, one-shot
//                                   barks/caws on the unpinned voices later)
//   8..23    music                 (this module, 16-voice pool)
//
// FUTURE SCOPE — stage-driven assets. The plan is a per-stage manifest that
// lists every asset the stage needs: music (one VAB+SEQ), SFX banks (one-shot
// VAGs, standalone / chained to a character / fired by an event trigger),
// characters, particles. This module is already shaped for that:
//   - fully data-driven: load takes file paths, nothing is hardcoded;
//   - load/play are split, so a stage loader can prefetch during a fade;
//   - music_unload() rewinds the SPU allocator mark it took. NOTE the boot
//     ordering flipped when stage-driven sfx landed: music (still global)
//     now loads FIRST, so per-stage sfx sits ABOVE the bank and can be
//     LIFO-released on a stage switch without touching it. If music itself
//     becomes stage-driven, unload sfx before music (reverse load order),
//     or grow the allocator into a real free list;
//   - the voice pool is a compile-time partition the future sfx module
//     extends rather than fights with.
//
// TYPICAL USE
//   sound_init();
//   if (music_load("\\SONG.VAB;1", "\\SONG.SEQ;1")) music_play();
//   ...each frame in the main loop: music_tick();
#pragma once

#include <stdint.h>

// First voice + voice count of the music pool (see voice map above).
#define MUSIC_VOICE_FIRST   8
#define MUSIC_VOICE_COUNT   16

// NOTE: the tick accumulator's vblank-rate calibration is no longer a
// compile-time constant. music_load() reads the GPU video mode (PAL/NTSC,
// inherited from the BIOS by ResetGraph) and picks the real 240p progressive
// vblank rate at runtime - see MUSIC_VSYNC_CHZ_* in music.c.

// Load a VAB (instrument bank -> SPU RAM, attributes -> main RAM) and a SEQ
// (score -> main RAM) from the CD. Returns 1 on success, 0 on any failure
// (missing file, bank too big for the SPU budget, malformed header); failure
// leaves the module inert - play/stop/tick become no-ops, the game keeps
// running silently, same philosophy as sound.c.
int  music_load(const char *vab_path, const char *seq_path);

// Release the SPU RAM the bank took (only safe if music was the most recent
// sound_spu_reserve() caller - see FUTURE SCOPE note) and forget the song.
void music_unload(void);

// Start playback from the top / stop (keys every music voice off, releases
// ring out through their ADSR). play() while playing restarts.
void music_play(void);
void music_stop(void);
int  music_playing(void);

// Advance the sequencer. Call ONCE PER FRAME from the main loop (after
// VSync). Cheap when stopped. Handles tempo, note on/off, program changes
// and the exporter's NRPN loop markers (song loops seamlessly on its own).
void music_tick(void);

// Master music volume, 0..0x3fff per channel (default 0x3000). Applied to
// new notes and pushed onto already-sounding voices immediately, so a stage
// can duck music under dialogue.
void music_set_volume(int left, int right);

// Diagnostics for the debug overlay.
int      music_voices_active(void);   // music voices currently keyed on
uint32_t music_spu_used(void);        // bytes of SPU RAM the bank occupies
int      music_loaded(void);

// FIRST failure step of the last music_load() (SND_ERR_* in sound.h;
// +SND_ERR_SEQ_BASE when the SEQ, not the VAB, failed; SND_ERR_NONE =
// loaded clean). Shown as MUSERR= on the overlay - pinpoints where a
// hardware-only load failure died from a single photographed frame.
int      music_last_error(void);

// Where the loaded pair came from: 0 = nothing loaded, 1 = CD (tier 1),
// 2 = the copy embedded in the EXE (tier 2 fallback - CD path failed,
// see music_last_error() for where). Overlay SRC=-/CD/EMB.
int      music_source(void);
