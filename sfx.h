// root/sfx.h
//
// Stage-driven sound effects layer: the sounds a stage authors in stage-gen
// (its stage.json "sounds" array, baked into STAGE_DEF.sounds by
// py_convert_stages.py). At stage load every authored sound's VAG is pulled
// off the CD into SPU RAM (through sound.c's shared bump allocator) and
// pinned to its own hardware voice.
//
// Per-sound behavior (all stage-authored, see STAGE_SOUND):
//   - Play mode: LOOP (continuous ambient - hardware-looped when the VAG
//     carries loop flags, otherwise re-keyed from the top each playthrough
//     so Loop ALWAYS loops regardless of how the sample was encoded),
//     ONCE (single playthrough), or INTERVAL (re-fires after a random
//     delay in [intervalMinFrames, intervalMaxFrames] - bird caws, distant
//     barks). Playthrough completion is detected by a frame countdown
//     computed from the VAG's size and sample rate (the SPU has no cheap
//     "voice finished" read-back), ticked by sfx_tick().
//   - Delay: frames before the sound's FIRST activity, in every mode
//     (loop/once key on when it elapses; interval starts scheduling then).
//     Also replayed on a START-toggle re-start.
//   - Directional: per-frame distance falloff inside `radius` plus stereo
//     pan derived from the camera's yaw, updated in sfx_tick(). Off =
//     constant stage-authored volume on both channels.
//   - Mute after played: once the sound completes a playthrough it is
//     forced silent and never retriggers. NOTHING is freed - sample and
//     voice stay resident (the LIFO SPU allocator can't reclaim mid-stack
//     anyway), so a future trigger tier can re-arm it. Loop mode never
//     "finishes" and so ignores the flag.
//
// DEPENDS ON sound.c: call these only after sound_init() (SPU + CD booted,
// allocator ready). Voice map (see music.h): voices 0..7 belong to this
// module, 8..23 to music.c.
//
// STILL LATER: one-shot barks chained to triggers/characters ("sounds"
// entries grow a trigger field; unpinned voices get a play-by-handle call).
#pragma once

#include <psxgte.h>

#include "generated/stage_common.h"

// Hardware voices this module owns (0..7; music.c owns 8..23 - keep in
// sync with music.h's voice map comment).
#define SFX_VOICE_FIRST  0
#define SFX_VOICE_COUNT  8

// Ceiling on sounds loaded per stage (fixed-size arrays, no heap on PS1) -
// deliberately equal to the voice pool, since every stage sound pins a
// voice. STAGE_DEF.soundCount is clamped against this at load, same
// pattern as MAX_STAGE_OBJECTS in main.c.
#define SFX_MAX_STAGE_SOUNDS SFX_VOICE_COUNT

// STAGE_SOUND.mode values - keep in sync with SOUND_MODES in
// py_convert_stages.py (which bakes stage.json's "mode" string to this).
// MUSIC is not an sfx voice at all: the entity names the stage's VAB+SEQ
// pair (cdPath/cdPath2) for music.c - sfx_stage_load() records it (see
// sfx_stage_music()) and otherwise skips it (no .VAG lookup, no voice,
// not counted unresolved).
#define SFX_MODE_LOOP     0
#define SFX_MODE_ONCE     1
#define SFX_MODE_INTERVAL 2
#define SFX_MODE_MUSIC    3

// Load `stage`'s authored sounds: releases whatever the PREVIOUS stage
// loaded first (LIFO-safe, see sfx_stage_unload), then CD-loads each
// STAGE_SOUND's VAG into SPU RAM, assigns it a voice, and starts every
// autoplay sound per its mode. NULL or a stage with no sounds is fine
// (silence). Call only after sound_init(), and AFTER music_load() at boot -
// stage sounds must sit ABOVE the music bank in the bump allocator so a
// runtime stage switch can release them without touching music's slice.
void sfx_stage_load(const STAGE_DEF *stage);

// Key off every stage voice and give back the SPU RAM the current stage's
// sounds reserved, in reverse load order (the LIFO contract of
// sound_spu_release()). Safe to call with nothing loaded.
void sfx_stage_unload(void);

// Advance the sfx layer exactly once per displayed frame (call right next
// to music_tick() in the main loop - same VSync cadence the baked
// interval/duration frame counts assume). Handles ONCE/INTERVAL
// completion + re-fire timers, mute-after-played latching, and the
// per-frame directional volume/pan pass - which is why the camera comes
// in here: `camPos` is the live camera position and `camYaw` its 12-bit
// Y rotation (camera.rot.vy), used to place each directional emitter in
// view space. Cheap no-op while the ambience is stopped or the stage has
// no sounds.
void sfx_tick(const VECTOR *camPos, int camYaw);

// Master on/off for the current stage's sounds (START button): stop keys
// every voice off and freezes the timers; start re-arms everything as at
// stage load (loops key on, ONCE sounds replay, INTERVAL sounds
// reschedule) - EXCEPT sounds already latched by muteAfterPlay, which
// stay silent until a stage reload. Samples stay resident throughout.
void sfx_stage_start(void);
void sfx_stage_stop(void);
void sfx_stage_toggle(void);
int  sfx_stage_playing(void); // 1 while the ambience is running (our own flag, not SPU read-back)

// Diagnostics for the debug overlay, same self-explanatory-silence
// philosophy as the old wind readouts:
//   sound_count      - sounds the active stage authored (post-clamp)
//   loaded_count     - how many actually made it off the CD into SPU RAM
//   unresolved_count - how many didn't (missing file, bad VAG, SPU RAM or
//                      voice budget exhausted) - the SFX analogue of
//                      main.c's UNRESOLVED model-name count
//   muted_count      - how many are latched silent by muteAfterPlay
int sfx_stage_sound_count(void);
int sfx_stage_loaded_count(void);
int sfx_stage_unresolved_count(void);
int sfx_stage_muted_count(void);

// The active stage's authored music entity (first mode==SFX_MODE_MUSIC
// sound), or NULL if the stage authors none. cdPath/cdPath2 are the
// VAB/SEQ CD paths and fadeOnStageEnter the authored transition
// preference - consumed by the (future) live stage-transition system;
// at BOOT main.c reads stage 0's entry directly to pick which pair
// music_load() gets (falling back to \SONG.VAB;1 + \SONG.SEQ;1).
const STAGE_SOUND *sfx_stage_music(void);
