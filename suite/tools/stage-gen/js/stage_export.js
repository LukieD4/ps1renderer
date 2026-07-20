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
      return {
        model: instance.model,
        palette: instance.palette,
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
