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
//   0        wind ambient          (sound.c)
//   1..7     one-shot SFX / barks  (future sfx module)
//   8..23    music                 (this module, 16-voice pool)
//
// FUTURE SCOPE — scene-driven assets. The plan is a per-scene manifest that
// lists every asset the scene needs: music (one VAB+SEQ), SFX banks (one-shot
// VAGs, standalone / chained to a character / fired by an event trigger),
// characters, particles. This module is already shaped for that:
//   - fully data-driven: load takes file paths, nothing is hardcoded;
//   - load/play are split, so a scene loader can prefetch during a fade;
//   - music_unload() rewinds the SPU allocator mark it took, so scene
//     teardown is load-order-independent as long as music loads last of the
//     audio assets (or the allocator grows a real free list later);
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

// Vertical sync rate the tick accumulator is calibrated against. Set to 50
// before building for PAL.
#define MUSIC_VSYNC_HZ      60

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
// new notes and pushed onto already-sounding voices immediately, so a scene
// can duck music under dialogue.
void music_set_volume(int left, int right);

// Diagnostics for the debug overlay.
int      music_voices_active(void);   // music voices currently keyed on
uint32_t music_spu_used(void);        // bytes of SPU RAM the bank occupies
int      music_loaded(void);
