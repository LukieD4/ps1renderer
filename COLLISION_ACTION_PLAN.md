# Collision - Action Plan

Author-time `Collide` boolean in stage-gen, reflected through stage.json into
the PS1 runtime as horizontal wall blocking against a configurable player
cylinder.

Scope agreed:

| Decision | Choice |
| --- | --- |
| `Collide` default on a model instance | **On** |
| Phase 1 runtime | **Walls only** - no gravity, keep the `player_ground_y` pin |
| Player collider | **Vertical cylinder**, hardcoded dimensions, previewed in the tool |
| Tool viewport | **Yes** - collider wireframes + walk-mode parity |

---

## 0. The enabling discovery

`MODEL_DEF` (generated/model_common.h) already carries per-model bounds:

```c
SVECTOR *bboxMin;
SVECTOR *bboxMax;
SVECTOR *bsphereCenter;
int      bsphereRadius;
```

and `py_convert_assets.py` computes them from `split_vert_positions`, which is
**already remapped** (line 558, `remap_pos(*wp)` -> `(x, -y, -z)`).

That is the *same* per-axis sign flip `stage_export.js`'s `remapPos()` applies to
instance placement. So model-space bounds and instance positions live in one
coordinate space, in the same 20.12 fixed point, with no conversion between them.

**Consequence: colliders need no new geometry export.** A collider is
`bboxMin/bboxMax` composed with the instance's existing `pos`/`rot`/`scale`. The
whole feature is one boolean on the wire plus arithmetic at stage load.

(The header comment in `stage_export.js` describing the per-vertex remap as
Y/Z-*swapping* is stale - it documents the OBJ-era formula. The glTF path's
`remap_pos` is a straight sign flip. Worth a comment fix while we're in there,
because the next person to reason about collider space will read that comment
and conclude the two spaces disagree.)

---

## 1. Why the player must NOT collide as its model

`assets/object/player/player.glb` is 3988 bytes; `assets/object/arrow/arrow.glb`
is 3980. The player *is* the debug arrow, and `draw_player()` renders it at
identity scale `{4096, 4096, 4096}`.

So `modelRegistry[playerModelIndex].bboxMin/Max` describes an arrow: long, thin,
pointed, asymmetric about its origin. Deriving player collision from it would
mean the player's solidity is a property of a placeholder art asset - and the day
that arrow is swapped for a real character, the physics silently change.

**The player collider is a constant in `main.c`, structurally unrelated to
`playerModelIndex`.** `draw_player()` keeps using `bsphereRadius` for *render
culling* (correct - that is a question about the mesh). Collision asks a
different question and gets its own answer:

```c
// Player collision volume. DELIBERATELY NOT DERIVED FROM THE PLAYER MODEL.
// The mesh is currently a scaled-down debug arrow; its bbox is long, thin and
// pointed, which is not how a character should feel against a wall. Swapping in
// real art must not change how the player collides, so the volume is authored
// here (and overridable per stage - see STAGE_PLAYER) rather than measured
// from geometry.
//
// A vertical cylinder: a circle in XZ, extruded over the player's height.
// Circle-vs-box needs no sqrt in the common case, and a round footprint slides
// along walls and around corners instead of snagging the way a box does.
//
// HARDCODED, and not authored per stage. The player's size is a property of the
// GAME, not of any one stage: shipping it in stage.json would mean the player
// can change size walking through a door, and would put a number that must be
// globally consistent on a wire that carries per-stage data. If it ever needs to
// vary, it wants a project-wide setting written identically into every export -
// not a per-stage field. Retuning today means editing these two lines and
// rebuilding, which is the correct cost for a value that should rarely move.
#define PLAYER_RADIUS   350   // world units (20.12); ~0.34 authoring units
#define PLAYER_HEIGHT  1600   // feet -> head; renderer Y DECREASES upward
```

Note the Y direction. `main.c` documents `camera.pos.vy -= // up`, and
`load_stage_spawn_at()` takes `player_ground_y` straight from the spawn's `pos.vy`.
So with feet at `player_pos.vy`, the head is at `player_pos.vy - PLAYER_HEIGHT`.
Every vertical comparison below has to respect that or it will be exactly
inverted - the single most likely bug in this whole plan.

These two constants are the **only** place the player's collision size is
defined. No stage.json block, no `STAGE_PLAYER` on `STAGE_DEF`, no converter
work - the wire carries `collide` and nothing else new.

The tool mirrors the numbers for its preview (§4), which is the one real cost of
hardcoding: two constants exist in two languages and can drift. Mitigate it the
cheap way - a comment on each side naming the other as the source of truth, with
`main.c` winning. A mismatch is visible immediately (the preview cylinder stops
matching how the console feels) and harmless when it happens, which is a fair
trade against building an authoring pipeline for two numbers.

---

## 2. Data path - every touchpoint

The instance shape is written out in **nine** places - grep `palette:` to find
them all, since every one of them carries palette too. Missing one produces a
flag that survives editing but vanishes on undo, or on paste, or on reload -
the kind of bug that takes an hour to see. Full list:

### stage-gen

| # | File | Change |
| --- | --- | --- |
| 1 | `js/stage_state.js` `addInstance()` | `collide: true` in the literal |
| 2 | `js/stage_state.js` `duplicateInstance()` | carry `original.collide` |
| 3 | `js/stage_state.js` `serializeNode()` | carry it (copy/paste) |
| 4 | `js/stage_state.js` `createNodeFromData()` | `data.collide !== false` |
| 5 | `js/stage_project.js` `buildProjectJson()` | carry it; bump `PROJECT_FILE_VERSION` 5 -> 6 + version note |
| 6 | `js/app.js` project-load `.map()` | `inst.collide !== false` |
| 7 | `js/history.js` `snapshot()` | carry it - the undo *builder*, and NOT in app.js as first assumed |
| 8 | `js/app.js` `applySnapshot()` | carry it - the undo *restorer*, the other half of #7 |
| 9 | `js/stage_export.js` `buildStageJson()` objects map | `collide: inst.collide !== false` |

#7 and #8 are a pair and both are needed: snapshot without restore means undo
silently drops the flag; restore without snapshot means it reads `undefined` and
falls back to solid. Either one alone looks like it works right up until you undo.

The `!== false` idiom throughout is what makes **default-on** work on old data:
a v1-v5 project and a pre-existing stage.json both lack the key, read as `true`,
and become solid. That is the chosen behaviour - see the migration note in §5.

### Properties panel

`instance-fields` currently holds numeric editors only. `wireInstanceField()`
(app.js ~1213) hard-codes `parseInt`/`parseFloat`:

```js
const value = group === 'palette' ? parseInt(inputEl.value, 10) : round3(parseFloat(inputEl.value));
```

A checkbox has no `.value` worth parsing, so this needs a boolean branch reading
`inputEl.checked` - or, cleaner, a separate small `wireInstanceCheckbox()` rather
than growing a third mode into a function whose two existing modes already
special-case each other. Plus `index.html` markup and a read in `updateUI()`
alongside `fPalette.value = selectedInst.palette`.

Place it under a **Collision** heading, not under Appearance. Palette is how the
instance looks; `Collide` is what it does.

### Converter

`py_convert_stages.py` (~281, alongside `palette`):

```python
collide = 1 if obj.get("collide", True) else 0
```

emitted into the `STAGE_OBJECT` initialiser, and the field added to the
`stage_common.h` generator block (~666). Put `collide` **immediately after
`palette`** so the two `unsigned char`s pack adjacently rather than each burning
a padded word ahead of a `VECTOR`.

```c
typedef struct
{
    const char *model;
    unsigned char palette;
    unsigned char collide;  // 1 = solid to the player (see §3); packs with palette
    VECTOR  pos;
    SVECTOR rot;
    VECTOR  scale;
} STAGE_OBJECT;
```

`STAGE_DEF` is untouched - one new byte on `STAGE_OBJECT` is the entire wire
change for this feature.

---

## 3. Runtime - `main.c`

### 3a. Bake world colliders once at stage load

Colliders are static: object transforms never change after `load_stage_at()`.
Recomputing them per frame would be pure waste, so build a table beside
`stageObjectModelIndex[]` (which already caches the same kind of load-time
resolution):

```c
typedef struct {
    VECTOR centre;      // world, 20.12 - same space as STAGE_OBJECT.pos
    VECTOR halfExtent;  // per-axis, always >= 1
} COLLIDER_BOX;

static COLLIDER_BOX stageColliders[MAX_STAGE_OBJECTS];
static unsigned int activeColliderCount = 0;
```

Deliberately the **same centre + half-extent shape as `STAGE_TRIGGER`**, so the
overlap helpers are shared rather than written twice with subtly different
boundary conditions.

Per collidable object: take `model->bboxMin/bboxMax`, scale per axis by
`obj->scale / 4096`, rotate the 8 corners by the object's `RotMatrix`, and refit
a world AABB around the result, then offset by `obj->pos`.

**Why refit an AABB rather than keep an OBB.** Three reasons, in order of weight:

1. It costs nothing per frame. Eight `ApplyMatrixLV` calls once at load versus a
   world->local transform per object per frame, forever.
2. It is *exact* for the 0/90/180/270 rotations that architectural level geometry
   actually uses. The conservative case only arises at odd angles.
3. It matches the precedent already set: `STAGE_TRIGGER` deliberately drops
   rotation, and `stage_common.h` documents the reasoning ("an OBB test is real
   work nothing has needed yet"). Two collision-ish systems in the engine
   answering the same question two different ways is worse than both being
   slightly conservative.

The cost is honest and should be documented at the call site: a 45-degree-rotated
wall gets a collider ~41% wider than the wall. Authors keep level geometry
axis-aligned, exactly as they already must for triggers.

Skip objects whose `collide` is 0 or whose model didn't resolve. `MAX_STAGE_OBJECTS`
is 32, so the table is 32 entries of static storage - no heap, consistent with
everything else here.

### 3b. Resolve movement per axis

In `update_play_mode()`, the current sequence is:

```c
player_pos.vx += dt_advance(&player_move_frac_x, stepFP_X);
player_pos.vz += dt_advance(&player_move_frac_z, stepFP_Z);
...
player_pos.vy = player_ground_y;
update_triggers(raw);
```

Becomes: move X, resolve X, move Z, resolve Z. **Sequential axis resolution is
what buys wall-sliding for free** - blocked on X, the Z component still applies,
so the player slides along the wall instead of stopping dead. No separate slide
vector, no dot products.

```c
player_pos.vx += dt_advance(&player_move_frac_x, stepFP_X);
if (resolve_player_axis(0)) player_move_frac_x = 0;

player_pos.vz += dt_advance(&player_move_frac_z, stepFP_Z);
if (resolve_player_axis(2)) player_move_frac_z = 0;
```

Zeroing the accumulator on a blocked axis matters and is easy to miss: the
remainder would otherwise bank up while the player pushes into a wall, then
discharge as a visible jolt the instant they turn away.

`update_triggers()` stays **last**, unchanged. Its existing comment - test against
the position the player actually ended the frame at - is now more true, not less:
it must see the post-collision position, or a door behind a wall could fire.

### 3c. The test

Minkowski sum: inflate the box by `PLAYER_RADIUS` on X and Z and test the player's
centre point against it. Vertical gate first (cheapest reject, and it is what stops
a floor acting as a wall - see §3d):

```c
// Player spans feet .. head. Renderer Y DECREASES upward, so the head is
// at vy - PLAYER_HEIGHT and the box "top" is its SMALLER Y.
int feet = player_pos.vy;
int head = player_pos.vy - PLAYER_HEIGHT;
int boxTop    = c->centre.vy - c->halfExtent.vy;
int boxBottom = c->centre.vy + c->halfExtent.vy;
if (boxTop >= feet || boxBottom <= head) continue;  // no vertical overlap
```

then the XZ test, then push out along the axis just moved - to whichever face the
player's centre is nearer:

```c
int dx = player_pos.vx - c->centre.vx;
if (dx >= 0) player_pos.vx = c->centre.vx + c->halfExtent.vx + PLAYER_RADIUS;
else         player_pos.vx = c->centre.vx - c->halfExtent.vx - PLAYER_RADIUS;
```

This treats the cylinder as a square footprint. The two differ **only in the
corner region**, where a true cylinder should push out radially. If corners feel
snaggy in practice, the refinement is ~6 lines - clamp the player centre to the
box to get the nearest point, compare squared distance against `PLAYER_RADIUS *
PLAYER_RADIUS`, push along the difference vector. Squared comparison, no sqrt,
until an actual push is needed. **Ship the square version first**; corner feel is
not assessable from a design document and the refinement is additive.

Overflow watch: `PLAYER_RADIUS * PLAYER_RADIUS` at 20.12 with radius 350 is
122,500 - fine. A radius above ~46,000 units would overflow int32, which no sane
authored diameter approaches, but the corner refinement should carry a note.

### 3d. The floor-is-a-wall hazard

**This is the one that will bite on first run.** `zflatplane`'s ground plane is a
model instance. Default-on makes it collidable. Its AABB is a flat slab centred at
the player's ground height - and a naive horizontal test says the player is inside
it, and shoves them sideways off the edge of the world.

The vertical gate in §3c is the first line of defence, but it is not sufficient on
its own: a floor slab with any thickness whose top sits exactly at `player_ground_y`
is ambiguous at the boundary.

Add a step tolerance:

```c
// Ignore any collider whose top surface is at or below the player's feet plus
// a step allowance. Floors, kerbs and low steps are things you stand on, not
// things you walk into - and with no gravity yet (player_pos.vy is pinned to
// player_ground_y) there is no other mechanism that could tell them apart.
// When gravity lands this constant becomes the real step-up height and this
// test becomes the ground query rather than a special case.
#define PLAYER_STEP_HEIGHT 400
if (boxTop >= feet - PLAYER_STEP_HEIGHT) continue;   // Y decreases upward
```

That single constant is what makes phase 1 shippable without gravity, and it is
already shaped like the thing phase 2 needs.

### 3e. Debug overlay

Add to the **WORLD** page: `activeColliderCount`, and which axes blocked this
frame. Respect the documented 40-column rule - the rendered result, not the format
string. Two short lines, e.g. `COLLIDERS 12  BLOCK X- Z`.

---

## 4. stage-gen viewport

### Wireframe overlay

Per collidable instance, a `THREE.Box3Helper` from the same composed AABB the
runtime bakes - **compute it the same way** (scale, rotate corners, refit) so the
overlay is a genuine preview and not an independent approximation that agrees
right up until it doesn't. Toggle in the viewport toolbar, colour distinct from
the entity-helper palette in `ENTITY_KINDS` (those run orange / green / purple /
yellow / cyan / pink; a cool desaturated blue is free).

### Player cylinder preview

A wireframe `CylinderGeometry` drawn at every **Spawn** entity - that is precisely
where the player will stand, so it answers "is my doorway wide enough" at the
moment the author is placing the doorway.

Static geometry, since the dimensions are compile-time constants. The two numbers
are mirrored from `main.c` (§1), converted out of 20.12 into viewport units:

```js
// MIRRORED FROM main.c's PLAYER_RADIUS / PLAYER_HEIGHT. main.c is the source of
// truth - change it there first, then match here. Divided by 1024 (UPSCALE) to
// get viewport units.
const PLAYER_PREVIEW_RADIUS = 350 / 1024;
const PLAYER_PREVIEW_HEIGHT = 1600 / 1024;
```

### Walk mode parity

`viewer.js`'s freecam walk mode currently does ground-follow only, with an explicit
comment that horizontal collision was deliberately excluded. That decision was
correct then and is superseded now: the tool should feel like the console.

- `collectWalkableMeshes()` filters to collide-enabled instances.
- Add the same cylinder-vs-box XZ test against the same composed boxes, using
  `FREECAM_EYE_HEIGHT` for the vertical span.
- Update that comment block rather than leaving it contradicting the code.

Note the space difference: the viewport works in viewport units (1 unit == 1
Blender unit), the runtime in 20.12 with the `(x, -y, -z)` flip. The *shape* logic
is identical; only the numbers differ. Keep the box-composition helper in one
module and let both callers feed it their own units.

---

## 4b. Per-primitive colliders (revision after first hardware feel)

**The bug this fixes.** §3a said "one AABB per model" and never spelled out the
consequence. `assets/object/house/house.glb` contains TWO meshes:

| mesh | size (Blender units) | what it is |
| --- | --- | --- |
| `Garage` | 4.91 x 3.50 x 2.95 | the building |
| `Plane` | 6.19 x 6.19 x **0.0** | a flat grass slab around it |

`py_convert_assets.py` flattens both into one vertex list and baked one bbox
around the **union**. So the house's collider was the *grass slab's* footprint
extruded to the *building's* height - an invisible block the size of the lawn.
The player could not get near the front door. Worse, the grass - which on its
own would bake a zero-thickness box and be exempted as walkable floor by
`PLAYER_STEP_HEIGHT` - inherited the building's height and became a wall.

**The fix.** Bake bounds PER GLTF PRIMITIVE, not per model:

- `py_convert_assets.py` accumulates min/max per triangle-bearing primitive and
  emits `<ident>_modelCollMin[] / _modelCollMax[] / _modelCollCount`.
- `MODEL_DEF` gains `collMin / collMax / collCount`. The existing whole-model
  `bboxMin/bboxMax` is UNTOUCHED and still feeds render culling - that is a
  question about the mesh as a *drawn* thing; collision asks about it as a
  *solid* thing, and merging the two would mean retuning one silently retunes
  the other.
- `build_stage_colliders()` emits one `COLLIDER_BOX` per primitive.
  `MAX_STAGE_COLLIDERS` (64) replaces `MAX_STAGE_OBJECTS` as the table bound,
  with overflow counted into `SKIP` rather than silently dropped.
- The stage-gen overlay iterates template meshes (GLTFLoader makes one Mesh per
  primitive), so tool and console still agree box-for-box.

Result on the real asset - one placed house now bakes two colliders:

| collider | centre | half-extent | verdict |
| --- | --- | --- | --- |
| Garage | `(-14, -1511, -33)` | `(2513, 1511, 1790)` | WALL |
| Plane (grass) | `(0, 0, -32)` | `(3170, **1**, 3170)` | top 1 unit up -> WALKABLE |

Approaching along Z reclaims **1378 units** of lawn (blocked at `-2173` instead
of `-3552`); along X, 643 units. `3shapes` likewise went from 1 box around all
three shapes to 3.

**Still open:** a primitive AABB is still a box, so a building with a doorway
stays sealed. A per-triangle narrow phase was tried and REVERTED - see §4d.

---

## 5. Migration - the cost of default-on

Default-on was chosen deliberately, and it has one consequence to handle: the next
export of any existing stage makes **every instance in it solid**, including
foliage, decals, ceiling detail and the ground plane. §3d handles floors; the rest
is an authoring audit.

Two cheap mitigations, both worth doing:

1. **Export summary line** - `stage.json exported: 24 objects, 24 collidable`.
   The count being conspicuously equal to the total is the signal that nobody has
   audited it yet. Same warn-don't-block policy as the existing palette-range and
   spawn-ID warnings.
2. **Multi-select bulk toggle** - "set Collide off for selection". Without it,
   de-solidifying a forest is a click per tree, and the feature gets resented.

---

## 6. Suggested order

1. ~~**Wire the flag end to end, default on, no runtime response.**~~ **DONE.**
   All 9 state sites, the Collision section + checkbox, `stage_export.js`, and
   `py_convert_stages.py`. Verified: both existing stages regenerate with
   `collide = 1` on every object (they predate the key, so the converter default
   applied - the intended migration), the generated `.c` compiles against the new
   struct, and export emits `true` / `false` / `true` for set / cleared / absent.
   Also added the all-solid audit warning from §5.
2. ~~**Bake `stageColliders[]` at load + debug readout.**~~ **DONE.**
   `build_stage_colliders()` in main.c, called from `load_stage_at()` after the
   model-resolve loop; `COL=n OF=n SKIP=n` on the WORLD page. Verified by
   extracting the real function into a host harness (no transcription) and
   running it against the actual baked bboxes:

   | case | result |
   | --- | --- |
   | `plane` at origin | centre/extent match the bbox arithmetic exactly |
   | `house` at (1,0,0) | centre Y `-1511`, half Y `1511` - correct for Y-decreasing-upward |
   | `arrow` yaw 90 | half `(733,1377,1914)` -> `(1914,1377,733)`, centre `(0,·,1563)` -> `(1563,·,0)` - exact swap, no rounding loss |
   | `house` yaw 45 | half `3170` -> `4482`, i.e. the predicted ~1.41x conservative fattening |
   | scale 2x | extents exactly doubled |
   | scale -1 on X | extents stay positive (mirror handled) |
   | collide=0 / bad model / no bounds | 0 colliders, `SKIP=2` - passable is not counted as a failure |

   **`plane` bakes `bboxMin.vy == bboxMax.vy == 0`** - a true zero-thickness
   ground plane. The `>= 1` clamp fired and gave it `halfExtent.vy = 1` centred
   at y=0, which is exactly where the player stands. This is §3d's floor-is-a-wall
   hazard confirmed in the data, not just in theory: without `PLAYER_STEP_HEIGHT`,
   step 4 would shove the player sideways off the ground plane on the first frame.
3. ~~**Viewport wireframes.**~~ **DONE.** `Colliders` toolbar toggle;
   `refreshColliderOverlay()` in viewer.js, fed the collidable-id set by app.js
   (viewer.js has no access to editor state). Rebuilds on every `updateUI()` and
   live during gizmo drags.

   **The trap this stepped around:** `THREE.Box3().setFromObject()` fits a box
   around the ROTATED GEOMETRY, which is *tighter* than what the runtime bakes -
   the runtime rotates the local AABB and refits, giving the fatter box §3a
   describes. An overlay built the obvious way would have agreed with the console
   on every axis-aligned prop and quietly disagreed on every rotated one, which
   is precisely the failure an overlay exists to prevent. So the overlay mirrors
   the runtime's math instead: local AABB -> instance basis -> absolute-weighted
   refit.

   Cross-checked the JS against the C harness on the same `arrow` bounds:

   | case | C (20.12) | JS (viewport) |
   | --- | --- | --- |
   | yaw 0 | `733, 1377, 1914` | `0.7158, 1.3452, 1.8691` |
   | yaw 90 | `1914, 1377, 733` | `1.8691, 1.3452, 0.7158` |

   Agreement to 4 decimal places (the ~0.0005 drift is the console's integer
   truncation at 20.12). Confirms both the refit formula and the column-major
   read of `matrixWorld.elements`.
4. ~~**Runtime resolution.**~~ **DONE.** `resolve_player_axis()`, called once per
   axis immediately after that axis moves; `PLAYER_RADIUS`/`PLAYER_HEIGHT`/
   `PLAYER_STEP_HEIGHT`; accumulator zeroing on a blocked axis; the ground-plane
   pin moved ahead of the movement block so resolution reads this frame's height;
   `BLOCK=XZ R=n STEP=n` on the WORLD page.

   Verified by extracting the real constants and the real resolver into a host
   harness and running them against the real baked colliders:

   | case | result |
   | --- | --- |
   | walk +X into `house` | stops at `-3520` = face `-3170` minus radius `350`, exact |
   | push diagonally into the wall | X pinned at `-3520` while Z advances 400/step - sliding works |
   | standing on `plane`, step guard ON | unmoved |
   | standing on `plane`, step guard OFF | **shoved from x=-3000 to x=448** |
   | 300-unit kerb (under step height) | walkable |
   | beam 2500-3500 up, head at 1600 | walk under |

   **The step guard is load-bearing, now demonstrated rather than asserted.**
   With it removed, standing still on the ground plane teleports the player 3.4
   authoring units sideways on the first frame. That is the §3d hazard firing
   exactly as predicted.

   **New known limitation - the squeeze.** Single-pass resolution cannot solve a
   gap narrower than the player's diameter: box A pushes right, box B pushes
   left, last one tested wins, player ends up inside the other. Iterating would
   not help - there is no valid position to converge on. Documented at the call
   site with the authoring rule (leave more than `2 * PLAYER_RADIUS` between
   solid props) and the fix if it ever bites (track the largest penetration
   across all boxes, apply only that one, instead of applying each in turn).
5. **Player cylinder preview**, then **walk-mode parity**.
6. Optional: corner refinement, bulk toggle.

Phase 2, explicitly out of scope here: gravity, floor height queries from collider
tops, `PLAYER_STEP_HEIGHT` becoming a real step-up, and retiring `player_ground_y`.
The step tolerance in §3d is the seam that work grows from.
