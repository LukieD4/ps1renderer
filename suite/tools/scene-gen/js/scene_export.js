/*
 * scene_export.js
 *
 * Builds the final scene.json output and triggers its download.
 *
 * ----------------------------------------------------------------------
 * WHY THE COORDINATE REMAP EXISTS - AND WHY THE OLD FORMULA WAS WRONG
 * ----------------------------------------------------------------------
 * Artists author models in Blender (Forward=-Z, Up=Y) and export .obj
 * files in that same space. The scene-gen viewport loads those .obj files
 * AS-IS via OBJLoader (no remap) so the viewport visually matches what the
 * artist saw in Blender - WYSIWYG editing. Three.js/OBJLoader do zero axis
 * conversion, so viewport pos.x/y/z here genuinely IS raw OBJ-file X/Y/Z.
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
 * authoring convention (verified via the arrow.obj dual-tip test against
 * how an individual model's shape should orient), whereas placement needs
 * to preserve the artist's own "up is up, forward is forward" intuition
 * from the viewport into the exported scene. The correct placement remap:
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
 * Build the full scene.json object from editor state.
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
export function buildSceneJson(state) {
  const camRemappedPos = remapPos(state.camera.pos);
  const camRemappedRot = remapRot(state.camera.rot);

  const scene = {
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

  return scene;
}

/**
 * Trigger a browser download of `json` as a pretty-printed .json file,
 * via a Blob + temporary <a> click - same pattern as palette-maker's
 * presumed export helper (no server round-trip, everything client-side).
 */
export function downloadSceneJson(json, filename) {
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
