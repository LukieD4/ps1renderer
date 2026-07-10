/*
 * scene_state.js
 *
 * Central editor state, mirroring palette-maker's "PaletteManager" class
 * pattern: one class instance holds all mutable editor state, and every
 * mutation goes through a method on this class so app.js's updateUI()
 * has a single, predictable source of truth to re-render from.
 *
 * Units note: instance/camera pos/rot/scale stored here are in VIEWPORT
 * space, i.e. the same Blender-equivalent, un-remapped, unscaled units the
 * artist sees in the 3D viewport (1 unit == 1 Blender/OBJ unit). The
 * PS1-space remap and the *1024 scale to integer scene.json units only
 * happen at export time, in scene_export.js. Keeping raw viewport units
 * here means the viewport, OrbitControls, and TransformControls all just
 * work in a single consistent space without back-and-forth conversions
 * during editing.
 */

export class SceneState {
  constructor() {
    // modelName -> { objText, mtlText, materialsMap: Map<matName, decodedTim|null>, dirHandle }
    this.models = new Map();

    // Array of { id, model, palette, pos:{x,y,z}, rot:{x,y,z}, scale:{x,y,z} }
    this.instances = [];

    // Default camera: sits back on +Z-ish looking toward the origin from
    // above, pitched down. Since the viewport is Blender-equivalent space
    // (Forward=-Z, Up=Y), a camera at positive Z pointing toward -Z (i.e.
    // toward the objects clustered near the origin) with a downward pitch
    // gives a reasonable "looking at the scene from a 3/4 angle" starting
    // view without requiring the artist to reposition it before doing
    // anything useful.
    this.camera = {
      pos: { x: 0, y: 2, z: 8 },
      rot: { x: -20, y: 0, z: 0 },
    };

    this.selectedInstanceId = null;
    this.nextId = 1;
  }

  /**
   * Register a loaded model's data (called after fs_assets + mtl_resolver
   * have finished loading & decoding a model's .obj/.mtl/.tim files).
   */
  addModel(name, data) {
    this.models.set(name, data);
  }

  /**
   * Create a new instance of `modelName` with default (or provided)
   * transform, push it into the instances array, and return it.
   */
  addInstance(modelName, initialTransform = {}) {
    const instance = {
      id: this.nextId++,
      model: modelName,
      palette: 0,
      pos: { x: 0, y: 0, z: 0, ...(initialTransform.pos || {}) },
      rot: { x: 0, y: 0, z: 0, ...(initialTransform.rot || {}) },
      scale: { x: 1, y: 1, z: 1, ...(initialTransform.scale || {}) },
    };
    this.instances.push(instance);
    return instance;
  }

  removeInstance(id) {
    const idx = this.instances.findIndex((inst) => inst.id === id);
    if (idx !== -1) {
      this.instances.splice(idx, 1);
    }
    if (this.selectedInstanceId === id) {
      this.selectedInstanceId = null;
    }
  }

  /**
   * Clone an existing instance with a new id, inheriting the source's
   * EXACT transform - position, rotation, and scale. (An earlier version
   * offset the clone by +1 on X/Z to make it visibly distinct, but exact
   * inheritance is more useful in practice: the typical flow is
   * duplicate-then-move, often via the surface-snap drag, and a
   * pre-applied offset just meant undoing a placement nobody asked for.
   * The clone is selected on creation, so it's never ambiguous which of
   * the two coincident instances a subsequent drag will move.)
   */
  duplicateInstance(id) {
    const original = this.getInstance(id);
    if (!original) return null;

    const clone = {
      id: this.nextId++,
      model: original.model,
      palette: original.palette,
      pos: { ...original.pos },
      rot: { ...original.rot },
      scale: { ...original.scale },
    };
    this.instances.push(clone);
    return clone;
  }

  getInstance(id) {
    return this.instances.find((inst) => inst.id === id) || null;
  }

  /**
   * Set a single field on an instance via a dotted path, e.g. 'pos.x'.
   * Used by app.js's per-field <input> change handlers.
   */
  setInstanceField(id, path, value) {
    const instance = this.getInstance(id);
    if (!instance) return;

    const [group, axis] = path.split('.');
    if (axis) {
      instance[group][axis] = value;
    } else {
      instance[group] = value;
    }
  }

  /**
   * Determine the maximum valid palette row index for an instance, based
   * on the minimum clutHeight across all of its model's resolved (non-null)
   * materials. We take the MIN across materials (not max) because a
   * palette row selection must be valid for every material simultaneously
   * - if one material only has 2 CLUT rows and another has 8, row index 5
   * would be out-of-range for the first material even though it's fine for
   * the second, and the PS1 renderer has no way to apply different palette
   * rows to different materials on the same instance.
   *
   * If no materials resolved successfully (all null), we fall back to 1
   * (i.e. only row 0 is valid) as a conservative default - there is no
   * "correct" bound in that scenario, so we assume the worst case rather
   * than silently allowing an arbitrary row index that would go out of
   * bounds against whatever texture eventually gets fixed up.
   */
  getMaxPaletteForInstance(id) {
    const instance = this.getInstance(id);
    if (!instance) return 1;

    const modelData = this.models.get(instance.model);
    if (!modelData || !modelData.materialsMap) return 1;

    let minClutHeight = null;
    for (const decoded of modelData.materialsMap.values()) {
      if (decoded === null) continue;
      if (minClutHeight === null || decoded.clutHeight < minClutHeight) {
        minClutHeight = decoded.clutHeight;
      }
    }

    return minClutHeight === null ? 1 : minClutHeight;
  }

  /**
   * Returns an array of { instanceId, message } warnings for any instance
   * whose assigned palette row is >= the max valid row for its model.
   */
  validatePaletteAssignments() {
    const warnings = [];
    for (const instance of this.instances) {
      const maxPalette = this.getMaxPaletteForInstance(instance.id);
      if (instance.palette >= maxPalette) {
        warnings.push({
          instanceId: instance.id,
          message: `Instance #${instance.id} (${instance.model}): palette row ${instance.palette} is out of range (max valid row is ${maxPalette - 1}).`,
        });
      }
    }
    return warnings;
  }
}
