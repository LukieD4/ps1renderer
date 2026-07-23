// animation.h - skeletal (bone) animation runtime for the PS1 renderer.
//
// Consumes the rig data baked by py_convert_assets.py into each skinned
// model (MODEL_DEF.bones / .vertSkin / .clips - see generated/model_common.h)
// and turns a clip + playback time into a POSED, model-space vertex buffer
// that main.c's existing projection path draws unchanged.
//
// Division of labour (see ANIMATION_ACTION_PLAN.md section 5):
//   animation.c : clip timing, pose evaluation (keyframe interp + hierarchy
//                 compose + inverse-bind), CPU skinning. Pure math, no GPU/OT.
//   main.c      : owns the draw loop; calls anim_advance/evaluate/skin per
//                 object, then transforms the posed verts as usual.
//
// Fixed point matches the rest of the engine: rotations at ONE==4096,
// vertex/translation coordinates at the 1024 model scale. Everything the
// converter baked is already in ENGINE space, so there is no coordinate
// remap here - just matrix math.

#ifndef ANIMATION_H
#define ANIMATION_H

#include <psxgte.h>                    // SVECTOR, MATRIX
#include "generated/model_common.h"    // MODEL_DEF, BONE_DEF, ANIM_CLIP, VERT_SKIN

// Upper bound on deform bones per model. testnpc uses 23; 32 leaves headroom
// without making the transient pose buffer large.
#define ANIM_MAX_BONES 32

// One bone's LOCAL transform in a pose - rotation quaternion (4096 == 1.0) plus
// translation (1024 model scale). This is the level cross-fade blends at (before
// the hierarchy compose), and the form a fade snapshot is stored in.
typedef struct
{
    short q[4];   // local rotation quaternion (x,y,z,w)
    int   t[3];   // local translation
} BONE_LOCAL;

// Per-object playback state. The transient per-pose MATRIX buffer lives in the
// caller (see anim_evaluate); the fade snapshot lives here because it must
// survive across frames for the duration of a blend.
typedef struct
{
    const MODEL_DEF *model;   // bound model, or NULL when this slot is unused
    int   clip;               // index into model->clips; -1 = no animation
    int   timeTicks;          // accumulated play time, DT_ONE-based (256 == 1/60s)
    int   speed;              // playback rate, 4096 == 1.0x
    int   playing;            // 0 pauses time advance (pose still evaluable)
    int   loop;               // effective loop flag: 1 loop, 0 play-once-then-hold
                              // (seeded from the clip, overridable per object)

    // Cross-fade: while fadeRemaining > 0 the pose is blended from fadeFrom (the
    // pose captured when the clip changed) into the current clip's live pose.
    int         fadeTicks;    // total blend duration
    int         fadeRemaining;// counts down to 0; 0 = not fading
    BONE_LOCAL  fadeFrom[ANIM_MAX_BONES];
} ANIM_STATE;

// Bind st to model's clip (clip<0 or a static model leaves it inert). Resets
// time to 0 and speed to 1.0x, playing.
void anim_init(ANIM_STATE *st, const MODEL_DEF *model, int clip);

// Switch clip (keeps time running from 0). No-op on an unbound/static state.
void anim_set_clip(ANIM_STATE *st, int clip);

// Find a clip index by name (exact match), or -1 if the model has no such
// clip / no rig. Lets callers pick a clip by its authored name instead of a
// brittle index - the basis of stage/object-authored clip selection.
int anim_find_clip(const MODEL_DEF *model, const char *name);

// Advance play time by dtTicks (pass main.c's g_dt). Scaled by st->speed, and
// also ticks down any in-progress cross-fade. Loop vs clamp follows st->loop.
void anim_advance(ANIM_STATE *st, int dtTicks);

// Switch to `clip`, blending smoothly out of the current pose over fadeTicks
// (DT_ONE ticks; e.g. 0.25s == 3840). Pass fadeTicks 0 for a hard cut. The
// new clip restarts from time 0. This is the walk->run mechanism, and what a
// trigger or the future player state machine calls to change animation.
void anim_crossfade(ANIM_STATE *st, int clip, int fadeTicks);

// Evaluate the current pose into boneMtx[0..model->boneCount-1]: each is the
// MODEL-SPACE skin matrix (posed global bone * inverse bind) that maps a bind
// vertex to its posed position. Caller supplies the buffer (>= ANIM_MAX_BONES).
// No-op (leaves buffer untouched) for an unbound/static/clip-less state.
void anim_evaluate(const ANIM_STATE *st, MATRIX *boneMtx);

// Skin model's bind vertices into out[] (model space, same 1024 scale as
// model->verts) using boneMtx from anim_evaluate and model->vertSkin. 2-bone
// linear blend; collapses to 1 bone when w0 == 255. out must hold >= vertCount.
void anim_skin_vertices(const MODEL_DEF *model, const MATRIX *boneMtx, SVECTOR *out);

// Skin the model's normals so lighting follows the pose. outVertN gets one
// posed normal per vertex (rotated by the vertex's bone(s), 2-bone blended);
// outFaceN gets one per triangle, rotated by that triangle's first vertex's
// bone (faces carry no skin of their own). Both renormalised to the 1024 scale
// the GTE lighting path expects. Buffers must hold >= vertCount / triCount.
void anim_skin_normals(const MODEL_DEF *model, const MATRIX *boneMtx,
                       SVECTOR *outVertN, SVECTOR *outFaceN);

#endif // ANIMATION_H
