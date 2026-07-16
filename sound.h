// root/sound.h
//
// Minimal SPU sound layer for the renderer. v1 scope: load one looping
// SPU-ADPCM VAG (ambient wind) off the CD into SPU RAM and play it on a
// dedicated voice. Later tiers (one-shot barks/caws, positional volume/pan,
// XA streaming) build on this same module - see sound.c's header comment.
//
// This module also owns the SPU RAM bump allocator; sibling audio modules
// (music.c now, sfx later) reserve their waveform slices through
// sound_spu_reserve() so the debug overlay sees one authoritative budget.
#pragma once

#include <stdint.h>

// Call once, from init(), AFTER ResetGraph()/InitGeom() (CdInit and SpuInit
// both require the reset to have happened). Boots the SPU + CD, loads
// WIND.VAG from the disc into SPU RAM, and sets sensible master/CD volumes.
// Does NOT start playback - call sound_wind_start() for that.
void sound_init(void);

// Key the wind voice on (starts the loop) / off (release then silence).
void sound_wind_start(void);
void sound_wind_stop(void);
void sound_wind_toggle(void);

// 1 while the wind voice is keyed on, 0 otherwise (our own state flag, not
// read back from the SPU). Used by debug_text().
int  sound_wind_playing(void);

// Diagnostics for the debug overlay: did WIND.VAG load off the CD and upload
// to SPU RAM (sound_wind_loaded), and does it carry loop flags
// (sound_wind_is_looped)? These make a silent boot self-explanatory - if
// LOADED=N the CD/file path failed; if LOOP=N a one-shot VAG was shipped.
int  sound_wind_loaded(void);
int  sound_wind_is_looped(void);

// SPU RAM allocator, shared by every audio module.
//   sound_spu_reserve - claim `bytes` of SPU RAM (8-byte aligned); returns
//                       the start byte address, or 0 if it won't fit. A
//                       caller that gets 0 must skip its upload.
//   sound_spu_release - give back the MOST RECENT `bytes` reserved (LIFO
//                       rewind of the bump cursor; same rounding as reserve).
//                       Correct scene teardown = release in reverse order of
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

// Live volume for the wind voice, 0..0x3fff per channel. Kept as a setter so
// the future positional-audio hook (distance -> volume, screen-X -> L/R pan)
// can drive it straight from draw_scene() without touching this module's guts.
void sound_wind_set_volume(int left, int right);
