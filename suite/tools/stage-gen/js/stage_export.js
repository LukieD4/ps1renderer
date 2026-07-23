/*
 * stage_export.js
 *
 * Builds the final stage.json output and triggers its download.
 *
 * ----------------------------------------------------------------------
 * WHY THE COORDINATE REMAP EXISTS - AND WHY THE OLD FORMULA WAS WRONG
 * ----------------------------------------------------------------------
 * Artists author models in Blender (Forward=-Z, Up=Y) and export .glb
 * (glTF) files. The stage-gen viewport loads those via GLTFLoader with no
 * remap, so the viewport visually matches what the artist saw in Blender -
 * WYSIWYG editing. glTF's +Y-up space matches BOTH Blender's export
 * orientation and Three.js's world, so a model's viewport coordinates are
 * the same Blender-export space the old .obj path produced - this placement
 * remap is therefore unchanged by the OBJ->glTF migration.
 *
 * py_convert_assets.py (the PS1-side model converter) applies this
 * PER-VERTEX remap to raw OBJ x/y/z when baking a model's geometry:
 *
 *   renderer_X =  OBJ_X
 *   renderer_Y = -OBJ_Z
 *   renderer_Z = -OBJ_Y
 *
 * This file originally applied that IDENTICAL formula to whole-instance
 * PLACEMENT offsets too, reasoning that a translation is "just a vector in
 * the same space" so the same conversion should apply uniformly. That
 * reasoning was correct in principle but produced a real, confirmed bug:
 * an instance moved 3 units up in the viewport (viewport Y, i.e. OBJ_Y)
 * was exported with its renderer_Z changed instead of renderer_Y - moving
 * it in DEPTH, not height. main.c confirms renderer Y is the actual
 * vertical axis (camera.pos.vy -= is commented "// up"; get_object_transform()
 * passes obj->pos.vy straight through to world_matrix.t[1] with no further
 * remapping) - so object placement needs viewport-vertical to land on
 * renderer-vertical directly, not on renderer-depth.
 *
 * Per-vertex model geometry and whole-object placement offsets are NOT
 * interchangeable here: the per-vertex formula encodes a specific model
 * authoring convention (verified via the arrow asset's dual-tip test against
 * how an individual model's shape should orient), whereas placement needs
 * to preserve the artist's own "up is up, forward is forward" intuition
 * from the viewport into the exported stage. The correct placement remap:
 *
 *   renderer_X =  viewport_X
 *   renderer_Y = -viewport_Y   (viewport Y is up; main.c's Y decreases upward)
 *   renderer_Z = -viewport_Z   (viewport Z is "backward" per Blender's -Z-forward)
 *
 * Rotation uses the same per-axis sign-flip structure, kept in degrees (a
 * separate downstream script converts degrees to the PS1 runtime's
 * fixed-point angle format - out of scope here).
 */

import { FOG_LIMITS, clampFogEngineRange } from './stage_state.js';

const UPSCALE = 1024; // FIXED_POINT_MATH_UPSCALE, matches the Python model converter

/**
 * Remap a viewport (raw OBJ-space) position into PS1 renderer space for
 * WHOLE-OBJECT PLACEMENT. See this file's header comment for why this is
 * a straight per-axis sign flip (viewport up -> renderer up, viewport
 * depth -> renderer depth) rather than the per-vertex model converter's
 * Y/Z-swapping formula - that swap is a model-geometry-specific
 * convention, not the right transform for a translation offset.
 * Does NOT apply the *1024 scale - callers do that separately.
 */
export function remapPos(pos) {
  return {
    x: pos.x,
    y: -pos.y,
    z: -pos.z,
  };
}

/**
 * Remap viewport (raw OBJ-space) Euler degrees into PS1 renderer space,
 * using the same per-axis sign-flip structure as remapPos (see above).
 */
export function remapRot(rot) {
  return {
    x: rot.x,
    y: -rot.y,
    z: -rot.z,
  };
}

/**
 * Parse a Light entity's '#rrggbb' colour into a [r, g, b] byte triple
 * (0-255). Anything malformed falls back to white so a half-typed value
 * never exports garbage - same resolve-late tolerance as sample names.
 */
export function hexToRgb(hex) {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  return [255, 255, 255];
}

/**
 * Compute a Light's world-space direction TOWARD the light, in renderer
 * space, as a unit vector scaled to ONE (4096) - the form the runtime's GTE
 * light matrix wants. Computing it HERE (rather than exporting raw Euler
 * angles) sidesteps the degrees-vs-fixed-point ambiguity on the converter
 * side and keeps all the trig in one testable place.
 *
 * The light's aim is its local -Z (the viewport's dirPointer), matching the
 * Spawn "forward" convention. With Three.js 'XYZ' Euler order the aimed
 * forward is (-sinY, sinX*cosY, -cosX*cosY); the direction TOWARD the light
 * is its negation, then remapped viewport->renderer with the same per-axis
 * sign flip as remapPos (x, -y, -z). Roll (Z) spins about the aim axis and
 * so does not affect the direction - it is intentionally ignored.
 */
/**
 * 3x3 rotation matrix for Three.js's default 'XYZ' Euler order, matching how
 * viewer.js applies an instance's rotation (object3D.rotation.set(x, y, z)).
 * Used to bake authored collision boxes from instance-local into world space.
 *
 * Written out here rather than borrowed from Three because stage_export.js is
 * deliberately free of viewer/Three imports - it is the one module that has to
 * be reasonable about producing the same numbers whether or not a viewport
 * exists.
 */
function eulerMatrixXYZ(x, y, z) {
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    [cy * cz,                  -cy * sz,                  sy       ],
    [cx * sz + sx * sy * cz,    cx * cz - sx * sy * sz,   -sx * cy  ],
    [sx * sz - cx * sy * cz,    sx * cz + cx * sy * sz,    cx * cy  ],
  ];
}

const DIR_SCALE = 4096; // ONE in the runtime's light-matrix fixed point
export function lightDirFromRot(rot) {
  const rx = ((rot && rot.x) || 0) * Math.PI / 180;
  const ry = ((rot && rot.y) || 0) * Math.PI / 180;
  const s1 = Math.sin(rx), c1 = Math.cos(rx);
  const s2 = Math.sin(ry), c2 = Math.cos(ry);
  // toward-light (viewport) = -(forward) = (sinY, -sinX*cosY, cosX*cosY),
  // then remap (x, -y, -z):
  const vx = s2;
  const vy = s1 * c2;   // -(-sinX*cosY)
  const vz = -c1 * c2;  // -(cosX*cosY)
  return [
    Math.round(vx * DIR_SCALE),
    Math.round(vy * DIR_SCALE),
    Math.round(vz * DIR_SCALE),
  ];
}

/**
 * Validate a trigger's referenced soundId against the stage's ACTUAL
 * triggerable emitters, returning -1 ("none") if it no longer resolves.
 *
 * A reference can go stale without the trigger ever being touched: the
 * Sound gets deleted, has its sample cleared, or is switched to Music mode
 * (music is a VAB/SEQ marker for music.c, not an sfx voice - there is no
 * emitter to key on). Shipping the stale id would bake a door that plays
 * nothing and gives the runtime an id it can never match, so it's collapsed
 * to a clean "none" here and warned about at export time in app.js.
 */
function resolveTriggerSound(state, soundId) {
  const id = Math.round(soundId ?? -1);
  if (!Number.isFinite(id) || id < 0) return -1;
  const ok = (state.entities || []).some(
    (ent) =>
      ent.kind === 'sound' &&
      ent.props.mode !== 'music' &&
      (ent.props.sample || '').trim() !== '' &&
      ent.props.soundId === id
  );
  return ok ? id : -1;
}

/**
 * Build the full stage.json object from editor state.
 *
 * Hand-traced example (verify against the code below):
 *   viewport authored pos = (1, 2, 3)   (2 = up, 3 = backward-from-camera)
 *   remapPos(pos) = { x: 1, y: -2, z: -3 }
 *   scale by 1024 and round:
 *     x: 1  * 1024 = 1024
 *     y: -2 * 1024 = -2048   (renderer Y decreases upward, per main.c)
 *     z: -3 * 1024 = -3072
 *   => exported pos = [1024, -2048, -3072]
 *
 * Confirms the real bug report: an instance at viewport (0, 3, 0) - 3
 * units above an instance at viewport (0, 0, 0) - now exports as
 * renderer Y = -3072 (above, since Y decreases upward) vs. the other
 * instance's renderer Y = 0, instead of the old formula's renderer Z
 * change (which left both instances at the same renderer Y and instead
 * pushed one backward in depth - the exact symptom reported).
 */
export function buildStageJson(state) {
  const camRemappedPos = remapPos(state.camera.pos);
  const camRemappedRot = remapRot(state.camera.rot);

  const stage = {
    camera: {
      pos: [
        Math.round(camRemappedPos.x * UPSCALE),
        Math.round(camRemappedPos.y * UPSCALE),
        Math.round(camRemappedPos.z * UPSCALE),
      ],
      rot: [
        Math.round(camRemappedRot.x),
        Math.round(camRemappedRot.y),
        Math.round(camRemappedRot.z),
      ],
    },
    objects: state.instances.map((instance) => {
      const remappedPos = remapPos(instance.pos);
      const remappedRot = remapRot(instance.rot);

      // ANIMATION. Emitted ONLY when the author picked a default clip - an
      // instance with clip=None (the default) has nothing to say to the
      // runtime, so the key is omitted rather than shipping a null. When
      // present it mirrors the runtime's ANIM_STATE seed fields by NAME:
      //   clip     - default clip name; the converter resolves it to an index
      //              (anim_find_clip) at load, so clip reordering is safe.
      //   loop     - loop vs play-once-then-hold.
      //   speed    - playback rate, 1.0 == authored. Kept as a float here (same
      //              as scale); the converter upscales to the runtime's 4096==1.0x.
      //   autoplay - start playing on spawn vs sit paused on frame 0.
      // NOTE: the runtime doesn't consume this yet (py_convert_stages.py / the
      // C stage loader are a later pass) - it's authored and round-tripped now
      // so the data is ready when that wiring lands.
      const anim = instance.anim || null;
      const animOut = (anim && anim.clip)
        ? {
            clip: anim.clip,
            loop: anim.loop !== false,
            speed: Number.isFinite(anim.speed) && anim.speed > 0 ? anim.speed : 1,
            autoplay: anim.autoplay !== false,
          }
        : null;

      return {
        model: instance.model,
        palette: instance.palette,
        // Present only for instances given a default animation clip (see above).
        ...(animOut ? { anim: animOut } : {}),
        // Solid to the player at runtime. py_convert_stages.py bakes this
        // into STAGE_OBJECT.collide, and main.c composes a world-space AABB
        // from the model's bboxMin/bboxMax for every object carrying it.
        //
        // ALWAYS EMITTED, never omitted when false - a passable instance is
        // an authored statement, not an absence. The converter defaults a
        // MISSING key to true (an older stage.json predates the field and
        // its geometry was authored as if solid), so omitting `false` here
        // would flip it to true on the way through.
        collide: instance.collide !== false,
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        rot: [
          Math.round(remappedRot.x),
          Math.round(remappedRot.y),
          Math.round(remappedRot.z),
        ],
        scale: [instance.scale.x, instance.scale.y, instance.scale.z],
      };
    }),
  };

  // AUTHORED COLLISION BOXES. Exported as a stage-level array in WORLD space,
  // not nested under their objects, because that is the shape main.c wants:
  // load_stage_at() copies them straight into stageColliders[] with no
  // composition, no model lookup, and no per-object walk. The editor's
  // parent/child relationship is an AUTHORING convenience - it is what makes
  // a box follow its building around - and it has done its job by the time
  // the file is written.
  //
  // WORLD-SPACE BAKE, and the one place it is lossy: a box on a ROTATED
  // instance is re-fitted to a world-axis-aligned box here, using the same
  // absolute-weighted refit main.c uses for the automatic fallback. A box on
  // a 45-degree-rotated building therefore ships ~41% wider than it looks in
  // the viewport. That is the same trade STAGE_TRIGGER already makes (see
  // stage_common.h) and the reason to keep level geometry axis-aligned.
  //
  // halfExtent, not size: the runtime test is one subtract and one compare
  // per axis against a centre, so the halving happens here rather than 60
  // times a second on the console.
  const colliderEntries = [];
  for (const inst of state.instances) {
    // A non-solid instance keeps its authored boxes in the project file but
    // ships none - the tickbox is the master switch, so unticking it must
    // not cost the author the boxes they placed.
    if (inst.collide === false) continue;

    for (const col of (state.colliders || [])) {
      if (col.parentInstanceId !== inst.id) continue;

      // Local center -> world. Scale, then rotate, then translate: the same
      // composition order as the render path and the fallback baker.
      const s = { x: col.center.x * inst.scale.x, y: col.center.y * inst.scale.y, z: col.center.z * inst.scale.z };
      const rx = (inst.rot.x || 0) * Math.PI / 180;
      const ry = (inst.rot.y || 0) * Math.PI / 180;
      const rz = (inst.rot.z || 0) * Math.PI / 180;
      const m = eulerMatrixXYZ(rx, ry, rz);

      const worldCenter = {
        x: m[0][0] * s.x + m[0][1] * s.y + m[0][2] * s.z + inst.pos.x,
        y: m[1][0] * s.x + m[1][1] * s.y + m[1][2] * s.z + inst.pos.y,
        z: m[2][0] * s.x + m[2][1] * s.y + m[2][2] * s.z + inst.pos.z,
      };

      // Half-extents, scaled then refitted through the rotation. Math.abs on
      // the scale absorbs a mirrored instance, which would otherwise produce
      // a negative extent that fails every runtime test silently.
      const h = {
        x: Math.abs(col.size.x * inst.scale.x) / 2,
        y: Math.abs(col.size.y * inst.scale.y) / 2,
        z: Math.abs(col.size.z * inst.scale.z) / 2,
      };
      const worldHalf = {
        x: Math.abs(m[0][0]) * h.x + Math.abs(m[0][1]) * h.y + Math.abs(m[0][2]) * h.z,
        y: Math.abs(m[1][0]) * h.x + Math.abs(m[1][1]) * h.y + Math.abs(m[1][2]) * h.z,
        z: Math.abs(m[2][0]) * h.x + Math.abs(m[2][1]) * h.y + Math.abs(m[2][2]) * h.z,
      };

      const remapped = remapPos(worldCenter);
      colliderEntries.push({
        // Addressable handle for a future trigger action. Exported even when
        // nothing references it - it costs one integer, and adding a
        // reference later shouldn't require re-exporting every stage.
        colliderId: Math.max(0, Math.round(col.colliderId ?? 0)),
        // Initial solid state. The runtime flag is live; this is only what it
        // starts as.
        enabled: col.enabled !== false,
        pos: [
          Math.round(remapped.x * UPSCALE),
          Math.round(remapped.y * UPSCALE),
          Math.round(remapped.z * UPSCALE),
        ],
        // remapPos flips Y and Z, but a half-extent is a magnitude - flipping
        // it would produce negatives. Only the CENTRE gets remapped.
        halfExtent: [
          Math.max(1, Math.round(worldHalf.x * UPSCALE)),
          Math.max(1, Math.round(worldHalf.y * UPSCALE)),
          Math.max(1, Math.round(worldHalf.z * UPSCALE)),
        ],
      });
    }
  }
  if (colliderEntries.length > 0) {
    stage.colliders = colliderEntries;
  }

  // Sound entities are the FIRST editor entity kind to graduate into
  // stage.json (see ENTITY_KINDS' note in stage_state.js - every other
  // kind is still project-file-only because the PS1 runtime has no
  // loader for them). Placement uses the same remapPos + *1024 upscale
  // as object placement above; volume stays a human 0-1 float (the same
  // "human multiplier" convention as object scale - py_convert_stages.py
  // scales it to the SPU's 0..0x3fff range); radius is a distance, so it
  // gets the same *1024 world-unit upscale as positions. Entities with
  // an empty sample name are skipped rather than exported as
  // unresolvable entries.
  const soundEntities = (state.entities || []).filter(
    (ent) => ent.kind === 'sound' && (ent.props.sample || '').trim() !== ''
  );
  if (soundEntities.length > 0) {
    stage.sounds = soundEntities.map((ent) => {
      const remappedPos = remapPos(ent.pos);
      // Interval bounds: exported in SECONDS (human units, converted to
      // frames by py_convert_stages.py), sanitized so the runtime never
      // sees min > max or negatives regardless of what was typed.
      let intervalMin = Math.max(0, ent.props.intervalMin ?? 2);
      let intervalMax = Math.max(0, ent.props.intervalMax ?? 8);
      if (intervalMax < intervalMin) [intervalMin, intervalMax] = [intervalMax, intervalMin];
      return {
        // Stable per-emitter handle other entities reference (a Switch
        // Scene trigger's Upon Enter SFX today). Exported even when nothing
        // references it - it costs one integer and means a reference added
        // later doesn't require re-exporting every stage that already ships.
        soundId: Math.max(0, Math.round(ent.props.soundId ?? 0)),
        sample: ent.props.sample.trim(),
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        volume: ent.props.volume,
        radius: Math.round(Math.max(0, ent.props.radius || 0) * UPSCALE),
        mode: ent.props.mode || 'loop', // 'loop' | 'once' | 'interval' | 'music'
        delay: Math.max(0, ent.props.delay || 0), // seconds before the FIRST play (non-music modes)
        // Music only (harmless true default elsewhere): cross-fade this
        // stage's track in on a live stage transition vs. a hard cut.
        fadeOnStageEnter: ent.props.fadeOnStageEnter !== false,
        intervalMin,
        intervalMax,
        directional: !!ent.props.directional,
        muteAfterPlay: !!ent.props.muteAfterPlay,
        autoplay: !!ent.props.autoplay,
      };
    });
  }

  // Light entities: the SECOND kind to graduate into stage.json (after
  // sound). Every light is emitted with its full authored parameters;
  // py_convert_stages.py bakes them into STAGE_LIGHT[] and main.c's
  // load_stage_lights() consumes them under the hybrid lighting plan:
  //   - directional (up to THREE - the GTE's light-matrix rows) fill the
  //     runtime light/colour matrices; ambient sums into the back colour.
  //     A stage with no authored directionals falls back to main.c's
  //     hardcoded, L2-tunable sun.
  //   - spherical / spot are carried through the data but not yet lit at
  //     runtime - they await the offline vertex-baking pass, which will
  //     bake them into static geometry's vertex colours (no per-frame
  //     cost).
  // Placement uses the same remapPos + *1024 upscale as objects; rotation
  // is remapped degrees (the light's aim is its own -Z, like a Spawn's
  // forward pointer, so directional/spot carry rot); range is a distance so
  // it gets the *1024 world-unit upscale; colour becomes a 0-255 RGB triple;
  // intensity/coneAngle/penumbra stay human units for the converter to
  // scale. Intensity 0 is a VALID authored value meaning "off" - it is still
  // exported so the light is AUTHORITATIVE at runtime (an authored directional
  // suppresses any default, whether it's on or off). Only genuinely negative
  // intensities are dropped as nonsense.
  const lightEntities = (state.entities || []).filter(
    (ent) => ent.kind === 'light' && (ent.props.intensity ?? 1) >= 0
  );
  if (lightEntities.length > 0) {
    stage.lights = lightEntities.map((ent) => {
      const remappedPos = remapPos(ent.pos);
      const remappedRot = remapRot(ent.rot);
      return {
        type: ent.props.lightType || 'spherical', // spherical|directional|spot|ambient|debug
        // Disabled lights are STILL exported (never dropped from
        // stage.json): they remain authoritative authored data - the
        // runtime skips applying them, nothing more.
        disabled: !!ent.props.disabled,
        // static = destined for the offline vertex bake; dynamic = lit live
        // per object. The runtime currently lights both via the live path
        // (the bake doesn't exist yet) but consumes the flag now so
        // authored stages survive the bake landing unchanged.
        mobility: ent.props.mobility || 'static',
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        rot: [
          Math.round(remappedRot.x),
          Math.round(remappedRot.y),
          Math.round(remappedRot.z),
        ],
        // Precomputed world-space unit direction TOWARD the light (ONE ==
        // 4096), what the runtime GTE light matrix consumes for directional/
        // spot. Derived from rot (kept above for reference/debug).
        dir: lightDirFromRot(ent.rot),
        color: hexToRgb(ent.props.color),          // [r, g, b], 0-255
        intensity: ent.props.intensity ?? 1.0,     // human 0-1+ multiplier
        range: Math.round(Math.max(0, ent.props.range || 0) * UPSCALE),
        coneAngle: Math.max(0, ent.props.coneAngle ?? 30), // degrees (spot)
        penumbra: Math.max(0, ent.props.penumbra ?? 0.2),  // 0-1 (spot)
      };
    });
  }

  // Spawn entities: the THIRD kind to graduate into stage.json (after sound
  // and light). py_convert_stages.py bakes these into STAGE_SPAWN[] and
  // main.c's load_stage_spawn() places the PLAY-mode player at one on stage
  // load, instead of the hardcoded world origin it used before.
  //
  // WHICH ONE WINS: the runtime takes the LOWEST spawnId, so spawn 0 is the
  // player start by convention and the rest are addressable markers for
  // whatever needs them later (checkpoints, door arrivals, a stage-
  // transition entry point). Sorting here rather than at runtime keeps the
  // console-side selection a single pass over an already-ordered array.
  //
  // SUMMON IS DELIBERATELY EXCLUDED even though it shares the spawnId
  // namespace: a summon is an NPC placement, not a player start, and
  // folding them into one array would make "lowest id wins" pick an NPC
  // marker whenever one happened to be numbered below the player's.
  //
  // Placement uses the same remapPos + *1024 upscale as objects. Rotation
  // stays in DEGREES like every other rot in this file - the converter does
  // the degrees -> 12-bit angle conversion. A spawn's facing is its own -Z
  // (the viewport's forward pointer), same convention as the camera, so the
  // Y component is the yaw the player faces on spawn.
  const spawnEntities = (state.entities || [])
    .filter((ent) => ent.kind === 'spawn')
    .sort((a, b) => (a.props.spawnId ?? 0) - (b.props.spawnId ?? 0));
  if (spawnEntities.length > 0) {
    stage.spawns = spawnEntities.map((ent) => {
      const remappedPos = remapPos(ent.pos);
      const remappedRot = remapRot(ent.rot);
      return {
        spawnId: Math.round(ent.props.spawnId ?? 0),
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        rot: [
          Math.round(remappedRot.x),
          Math.round(remappedRot.y),
          Math.round(remappedRot.z),
        ],
      };
    });
  }

  // Trigger entities: the FOURTH kind to graduate. Only triggers with a real
  // action are exported - an action:none trigger is an authoring marker for
  // a region and has nothing for the runtime to do, so shipping it would
  // just cost a per-frame volume test that can never fire.
  //
  // SCALE IS THE VOLUME EXTENT. The viewport helper is a unit cube, so the
  // entity's scale IS the box size - there is no separate extent field. The
  // runtime wants half-extents in engine units (a centre + half-size test is
  // one subtract and one compare per axis, versus recovering the corners
  // from a min/max pair), so that conversion happens here: scale is the FULL
  // size of a 1-unit cube, hence * 1024 / 2. Math.abs guards a negative
  // scale, which the gizmo can produce by dragging a handle through zero and
  // which would otherwise make the box fail every test silently.
  //
  // Rotation is deliberately NOT exported: the runtime test is an
  // axis-aligned box. A rotated trigger would need an OBB test (transform
  // the player into the box's local space first), which is real work for a
  // feature nothing has asked for yet. Authors should keep trigger volumes
  // axis-aligned; a rotated one will behave as its axis-aligned equivalent.
  const triggerEntities = (state.entities || []).filter(
    (ent) => ent.kind === 'trigger' && (ent.props.action || 'none') !== 'none'
  );
  if (triggerEntities.length > 0) {
    stage.triggers = triggerEntities.map((ent) => {
      const remappedPos = remapPos(ent.pos);
      return {
        action: ent.props.action,
        event: (ent.props.event || '').trim(),
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        halfExtent: [
          Math.round((Math.abs(ent.scale.x) * UPSCALE) / 2),
          Math.round((Math.abs(ent.scale.y) * UPSCALE) / 2),
          Math.round((Math.abs(ent.scale.z) * UPSCALE) / 2),
        ],
        targetStage: (ent.props.targetStage || '').trim(),
        targetSpawnId: Math.max(0, Math.round(ent.props.targetSpawnId ?? 0)),
        // Sound to fire in THIS stage as the door opens; -1 is none. The
        // reference is validated against the live entity list below rather
        // than trusted, because a Sound can be deleted, renamed to an empty
        // sample, or switched to Music AFTER a trigger pointed at it - none
        // of which touches the trigger. Exporting a dangling id would ship a
        // door that silently plays nothing.
        onEnterSoundId: resolveTriggerSound(state, ent.props.onEnterSoundId),
        // Require a CROSS press while inside, rather than firing on entry.
        // Defaults TRUE on a missing field to match the schema, so a trigger
        // exported before this existed becomes press-to-activate rather than
        // silently keeping the old walk-in behaviour under a new default.
        userInteract: ent.props.userInteract !== false,
        once: ent.props.once !== false,
      };
    });
  }

  // POST-PROCESS VOLUMES. Regions that change how the frame is rendered.
  //
  // Same axis-aligned centre + half-extent shape as triggers, and for the
  // same reason: the runtime test is one subtract and one compare per axis,
  // and the viewport helper is a unit cube so the entity's SCALE is the
  // volume size. Rotation is deliberately not carried - a rotated volume
  // behaves as its axis-aligned equivalent.
  //
  // A volume with EVERY effect disabled is dropped. It costs a per-frame
  // containment test and can produce nothing, so shipping it would be paying
  // for an authoring marker. (An author mid-experiment keeps it in the
  // project file - this only affects what reaches the console.)
  //
  // falloff is a distance, so it gets the same *1024 world-unit upscale as
  // positions and radii. tintStrength is a LAYER COUNT (the GPU's blend
  // modes are fixed ratios, so "stronger" means drawing the quad again) and
  // is clamped hard: each layer is a full-screen fill and the fill rate is
  // the real budget on this hardware.
  const postFxEntities = (state.entities || []).filter(
    (ent) => ent.kind === 'postprocess' && (
      ent.props.tintEnabled || ent.props.blurEnabled ||
      ent.props.ghostEnabled || ent.props.paletteEnabled
    )
  );
  if (postFxEntities.length > 0) {
    stage.postfx = postFxEntities.map((ent) => {
      const remappedPos = remapPos(ent.pos);
      const eased = ent.props.transition !== 'hard';
      return {
        pos: [
          Math.round(remappedPos.x * UPSCALE),
          Math.round(remappedPos.y * UPSCALE),
          Math.round(remappedPos.z * UPSCALE),
        ],
        halfExtent: [
          Math.round((Math.abs(ent.scale.x) * UPSCALE) / 2),
          Math.round((Math.abs(ent.scale.y) * UPSCALE) / 2),
          Math.round((Math.abs(ent.scale.z) * UPSCALE) / 2),
        ],
        // 0 falloff on an eased volume is just a hard edge; exported as such
        // rather than leaving the runtime to divide by zero working out a ramp.
        falloff: eased ? Math.round(Math.max(0, ent.props.falloff || 0) * UPSCALE) : 0,
        // Master intensity as an authored PERCENTAGE; the converter scales it
        // to fixed point. Not clamped to 100 - over-driving a volume is a
        // legitimate way to find the right level - but floored at 0, since a
        // negative intensity has no meaning the runtime could act on.
        intensity: Math.max(0, Math.round(ent.props.intensity ?? 100)),

        tint: !!ent.props.tintEnabled,
        tintColor: hexToRgb(ent.props.tintColor || '#804060'),
        tintMode: ent.props.tintMode || 'blend50', // blend50|additive|subtractive|quarter
        tintStrength: Math.max(1, Math.min(8, Math.round(ent.props.tintStrength ?? 1))),

        blur: !!ent.props.blurEnabled,
        blurAmount: Math.max(0, Math.min(1, ent.props.blurAmount ?? 0.5)),

        ghost: !!ent.props.ghostEnabled,
        ghostAmount: Math.max(0, Math.min(1, ent.props.ghostAmount ?? 0.5)),

        palette: !!ent.props.paletteEnabled,
        paletteRow: Math.max(0, Math.round(ent.props.paletteRow ?? 0)),
      };
    });
  }

  // Stage fog. Emitted UNCONDITIONALLY (never gated on `enabled`), like
  // `camera` and unlike the sounds/lights arrays - fog is a stage-level block
  // with exactly one instance, and a stage that authors fog OFF is making a
  // statement the runtime needs to hear. main.c has no fallback fog to fall
  // back TO: load_stage_lights() sets these globals from stage data, so an
  // absent block would leave whatever the previously-loaded stage set,
  // meaning fog would leak across a runtime stage switch. Same reasoning that
  // made authored lights authoritative with no recovery sun.
  //
  // near/far get the standard *1024 world-unit upscale (positions, sound
  // radius, light range all do the same) and are clamped through the port of
  // main.c's fog_clamp_range() first, so a stage.json can never carry a range
  // that rails DQA or overflows DQB on the console. setup_frame_fog() still
  // rails independently as a backstop - this just means it never has to.
  //
  // colour becomes a 0-255 RGB triple like light colour. layers/cull/drift
  // are the authored DEFAULTS for main.c's fog_layers / fog_cull_enabled /
  // fog_drift_enabled; the DEBUG-mode L1+L2 editor still overrides them live,
  // exactly the "authored value + live offset" pattern light intensity uses.
  const fog = state.fog || {};
  const fogRange = clampFogEngineRange(
    Math.round((fog.near ?? 0.78125) * UPSCALE),
    Math.round((fog.far ?? 5.859375) * UPSCALE)
  );
  stage.fog = {
    enabled: !!fog.enabled,
    near: fogRange.near,
    far: fogRange.far,
    color: hexToRgb(fog.color || '#808080'), // [r, g, b], 0-255
    // Clamped to main.c's FOG_MAX_LAYERS; 0 is valid and means "depth cue
    // only" (untextured geometry fogs, textured does not).
    layers: Math.max(0, Math.min(FOG_LIMITS.MAX_LAYERS, Math.round(fog.layers ?? 3))),
    cull: !!fog.cull,
    drift: !!fog.drift,
  };

  return stage;
}

/**
 * Trigger a browser download of `json` as a pretty-printed .json file,
 * via a Blob + temporary <a> click - same pattern as palette-maker's
 * presumed export helper (no server round-trip, everything client-side).
 */
export function downloadStageJson(json, filename) {
  const text = JSON.stringify(json, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}
