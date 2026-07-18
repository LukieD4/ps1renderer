/*
 * stage_state.js
 *
 * Central editor state, mirroring palette-maker's "PaletteManager" class
 * pattern: one class instance holds all mutable editor state, and every
 * mutation goes through a method on this class so app.js's updateUI()
 * has a single, predictable source of truth to re-render from.
 *
 * Units note: instance/camera pos/rot/scale stored here are in VIEWPORT
 * space, i.e. the same Blender-equivalent, un-remapped, unscaled units the
 * artist sees in the 3D viewport (1 unit == 1 Blender/OBJ unit). The
 * PS1-space remap and the *1024 scale to integer stage.json units only
 * happen at export time, in stage_export.js. Keeping raw viewport units
 * here means the viewport, OrbitControls, and TransformControls all just
 * work in a single consistent space without back-and-forth conversions
 * during editing.
 */

/**
 * Registry of the hardcoded, editor-native object kinds that can be
 * inserted into the Instances tree WITHOUT any model asset backing them
 * - game-logic markers (spawn points, trigger volumes, ...) rather than
 * renderable geometry. One entry per kind:
 *
 *   label:  display name (row labels, insert menu, properties header)
 *   hint:   one-liner shown in the insert menu
 *   color:  CSS color for the tree row dot / matches the viewport
 *           helper's color (viewer.js keeps its own copy as a Three.js
 *           hex - update both if you change one)
 *   props:  ordered schema the Properties panel renders editors from:
 *           { key, label, type: 'bool' | 'int' | 'number' | 'string',
 *             default } - plus `uniqueSpawnId: true` on fields that must
 *             be unique across all spawn-like entities.
 *
 * NOTE: these are deliberately NOT exported into stage.json yet - the
 * PS1 runtime has no loader for them (all "tbd"). They persist in the
 * .StageGen project file (format v3) only, so authoring can start now
 * and the exporter can pick them up whenever main.c grows support.
 */
export const ENTITY_KINDS = {
  trigger: {
    label: 'Trigger',
    hint: 'Volume that fires an event when entered',
    color: '#ff8c42',
    props: [
      { key: 'event', label: 'Event Name', type: 'string', default: '' },
      { key: 'once', label: 'Fire Once', type: 'bool', default: true },
    ],
  },
  spawn: {
    label: 'Spawn',
    hint: 'Player/actor spawn point (unique ID)',
    color: '#5dd06a',
    props: [
      { key: 'spawnId', label: 'Spawn ID', type: 'int', default: 0, uniqueSpawnId: true },
    ],
  },
  summon: {
    label: 'Summon',
    hint: 'NPC spawn with behavior parameters',
    color: '#b06ee0',
    props: [
      { key: 'spawnId', label: 'Spawn ID', type: 'int', default: 0, uniqueSpawnId: true },
      { key: 'isFriendly', label: 'Is Friendly', type: 'bool', default: false },
      { key: 'patrolRadius', label: 'Patrol Radius', type: 'number', default: 3 },
      { key: 'health', label: 'Health', type: 'int', default: 100 },
      { key: 'canSeeThroughWalls', label: 'Sees Through Walls', type: 'bool', default: false },
    ],
  },
  particle: {
    label: 'Particle',
    hint: 'Effect emitter point',
    color: '#ffd23c',
    props: [
      { key: 'effect', label: 'Effect Name', type: 'string', default: '' },
      { key: 'loop', label: 'Looping', type: 'bool', default: true },
    ],
  },
  billboard: {
    label: 'Billboard',
    hint: 'Camera-facing flat sprite plane',
    color: '#3ec6dc',
    props: [
      { key: 'trackCamera', label: 'Track Camera', type: 'bool', default: true },
      { key: 'pivotAngle', label: 'Pivot Angle (deg)', type: 'number', default: 0 },
      { key: 'seeThroughWalls', label: 'Draw Through Walls', type: 'bool', default: false },
    ],
  },
  sound: {
    // FIRST entity kind the PS1 runtime actually loads: stage_export.js
    // graduates these into stage.json's "sounds" array (unlike every
    // other kind above, which is still project-file-only - see the
    // NOTE on ENTITY_KINDS). Runtime is sfx.c: play modes (loop / once /
    // random interval), optional directional audio (distance falloff
    // inside `radius` + stereo pan, updated per frame from the camera),
    // and mute-after-played (finished sound is forced silent and never
    // retriggers - it stays resident so a future trigger can re-arm it).
    label: 'Sound',
    hint: 'Ambient / one-shot audio emitter',
    color: '#e05d8a',
    props: [
      // Matched against assets/sound/**/<NAME>.vag by 8.3 uppercase
      // convention at convert time ("wind" -> \WIND.VAG;1). A typo'd or
      // missing sample degrades to silence at runtime and is counted on
      // the debug overlay's SFX UNRESOLVED readout - same free-text,
      // resolve-late philosophy as stage object model names.
      { key: 'sample',   label: 'Sample Name (e.g. WIND, not WIND.VAG)',    type: 'string', default: '' },
      { key: 'volume',   label: 'Volume (0-1)',   type: 'number', default: 0.5 },
      // Mutually exclusive playback behaviors as ONE selector (a set of
      // tickboxes would allow contradictions like loop+once):
      //   loop     - continuous: hardware-looped when the VAG carries loop
      //              flags, otherwise sfx.c re-keys it from the top each
      //              playthrough (software loop) - so Loop ALWAYS loops,
      //              however the sample was encoded
      //   once     - plays a single time at start
      //   interval - re-fires after a random delay in [intervalMin,
      //              intervalMax] seconds (bird caws, distant dog barks)
      //   music    - THIS STAGE'S MUSIC TRACK: the sample name maps to
      //              assets/sound/music/<NAME>.VAB + <NAME>.SEQ (not a
      //              .vag), loaded by music.c at boot for the entered
      //              stage. Position/directional/etc. don't apply - a
      //              music entity is a stage-level marker that happens
      //              to live in the entity tree. First one wins if a
      //              stage authors several.
      { key: 'mode', label: 'Play Mode', type: 'select', default: 'loop',
        options: [
          { value: 'loop',     label: 'Loop' },
          { value: 'once',     label: 'Play Once' },
          { value: 'interval', label: 'Random Interval' },
          { value: 'music',    label: 'Music' },
        ] },
      // Music only: when live stage transitioning lands, cross-fade this
      // track in while the previous stage's music fades out (vs. a hard
      // cut). Baked into STAGE_SOUND now so stages author it ahead of
      // that system existing.
      { key: 'fadeOnStageEnter', label: 'Fade entering new stage', type: 'bool', default: true,
        showIf: (props) => props.mode === 'music' },
      // Seconds before the FIRST play (0 = immediate): loop/once start
      // after the delay; interval schedules its first random fire after
      // it. Hidden for music - the runtime ignores it there today.
      { key: 'delay', label: 'Delay (s)', type: 'number', default: 0,
        showIf: (props) => props.mode !== 'music' },
      // Bounds of the random silence between plays, in seconds. Only
      // meaningful - and only SHOWN (showIf, see renderEntityProps) -
      // in Random Interval mode.
      { key: 'intervalMin', label: 'Interval Min (s)', type: 'number', default: 2,
        showIf: (props) => props.mode === 'interval' },
      { key: 'intervalMax', label: 'Interval Max (s)', type: 'number', default: 8,
        showIf: (props) => props.mode === 'interval' },
      // Distance falloff (inside `radius`) + stereo pan, updated per
      // frame from the camera. Off = constant volume everywhere.
      // Hidden for music (a track has no world position).
      { key: 'directional', label: 'Directional Audio', type: 'bool', default: false,
        showIf: (props) => props.mode !== 'music' },
      // Falloff radius in viewport units for directional sounds;
      // 0 = no distance falloff (pan still applies when directional).
      { key: 'radius',   label: 'Radius (0=global)', type: 'number', default: 0,
        showIf: (props) => props.mode !== 'music' },
      // After the sound has completed one playthrough, force it silent
      // and stop retriggering (loop mode never "finishes", so it
      // ignores this). Sample + voice stay resident for later re-arming.
      // Hidden for music.
      { key: 'muteAfterPlay', label: 'Mute After Played', type: 'bool', default: false,
        showIf: (props) => props.mode !== 'music' },
      { key: 'autoplay', label: 'Autoplay',       type: 'bool',   default: true },
    ],
  },
};

export class StageState {
  constructor() {
    // modelName -> { objText, mtlText, materialsMap: Map<matName, decodedTim|null>, dirHandle }
    this.models = new Map();

    // Array of { id, model, palette, name, parentId, pos:{x,y,z}, rot:{x,y,z}, scale:{x,y,z} }
    //   name:     display-only rename override (null = default "model #id"
    //             label). Never used by export - purely for the editor UI.
    //   parentId: id of the folder this instance sits in, or null for the
    //             tree's root level.
    this.instances = [];

    // Display-only grouping folders for the Instances tree:
    // { id, name, parentId, collapsed }. Folders draw ids from the SAME
    // this.nextId counter as instances so a parentId can never be
    // ambiguous between the two kinds. They exist purely to organize the
    // editor's instance list (and are saved in the project file so the
    // organization survives reload) - stage_export.js flattens them away
    // entirely, since the PS1 runtime has no concept of them.
    this.folders = [];

    // Editor-native entities (see ENTITY_KINDS above): array of
    // { id, kind, name, parentId, pos, rot, scale, props }. Same id
    // counter and same tree-parenting rules as instances; props is a
    // flat object matching the kind's schema. Not exported to
    // stage.json (yet) - see ENTITY_KINDS' note.
    this.entities = [];

    // Next spawn ID handed to a freshly created spawn/summon entity.
    // Spawn IDs are their own sequence (dense small integers the game
    // logic will reference), separate from this.nextId's editor ids.
    this.nextSpawnId = 0;

    // Default camera: sits back on +Z-ish looking toward the origin from
    // above, pitched down. Since the viewport is Blender-equivalent space
    // (Forward=-Z, Up=Y), a camera at positive Z pointing toward -Z (i.e.
    // toward the objects clustered near the origin) with a downward pitch
    // gives a reasonable "looking at the stage from a 3/4 angle" starting
    // view without requiring the artist to reposition it before doing
    // anything useful.
    this.camera = {
      pos: { x: 0, y: 2, z: 8 },
      rot: { x: -20, y: 0, z: 0 },
    };

    this.selectedInstanceId = null;
    // At most ONE of selectedInstanceId / selectedFolderId is non-null at
    // a time - selecting a folder deselects the instance and vice versa
    // (app.js enforces this at every selection site). Folder selection
    // exists so asset placement / New Folder can target the selected folder
    // and so the Delete key has a folder target.
    this.selectedFolderId = null;
    this.nextId = 1;
  }

  /**
   * Register a loaded model's data (called after fs_assets + mtl_resolver
   * have finished loading & decoding a model's .glb + .tim files).
   */
  addModel(name, data) {
    this.models.set(name, data);
  }

  /**
   * Create a new instance of `modelName` with default (or provided)
   * transform, push it into the instances array, and return it.
   */
  addInstance(modelName, initialTransform = {}, parentId = null) {
    const instance = {
      id: this.nextId++,
      model: modelName,
      palette: 0,
      name: null,
      parentId,
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
      // Keep the custom name verbatim (Roblox Studio does the same on
      // duplicate) - the clone is selected on creation so the two
      // identically-named rows are never ambiguous, and appending "(2)"
      // style suffixes would fight the typical duplicate-rename flow.
      name: original.name,
      parentId: original.parentId,
      pos: { ...original.pos },
      rot: { ...original.rot },
      scale: { ...original.scale },
    };
    this.instances.push(clone);
    return clone;
  }

  // ------------------------------------------------------------------
  // Folders (display-only grouping for the Instances tree)
  // ------------------------------------------------------------------

  addFolder(parentId = null) {
    const folder = {
      id: this.nextId++,
      name: 'Folder',
      parentId,
      collapsed: false,
    };
    this.folders.push(folder);
    return folder;
  }

  getFolder(id) {
    return this.folders.find((f) => f.id === id) || null;
  }

  /**
   * All folder ids inside `folderId`'s subtree, INCLUDING folderId
   * itself. Iterative breadth-first walk (the loop appends children of
   * ids already collected) so arbitrarily deep nesting never recurses.
   */
  collectFolderIds(folderId) {
    const ids = [folderId];
    for (let i = 0; i < ids.length; i++) {
      for (const folder of this.folders) {
        if (folder.parentId === ids[i]) ids.push(folder.id);
      }
    }
    return ids;
  }

  /** Every instance living anywhere inside `folderId`'s subtree. */
  getFolderInstances(folderId) {
    const folderIds = new Set(this.collectFolderIds(folderId));
    return this.instances.filter((inst) => folderIds.has(inst.parentId));
  }

  /** Total instances + entities inside `folderId`'s subtree (row count
   * badge / delete-confirm sizing, where both kinds matter equally). */
  getFolderContentsCount(folderId) {
    const folderIds = new Set(this.collectFolderIds(folderId));
    return (
      this.instances.filter((inst) => folderIds.has(inst.parentId)).length +
      this.entities.filter((ent) => folderIds.has(ent.parentId)).length
    );
  }

  /**
   * True if `folderId` is inside `ancestorId`'s subtree (including being
   * the same folder). Used by the tree's drag-drop to refuse dropping a
   * folder into itself or one of its own descendants, which would orphan
   * the whole subtree from the root walk.
   */
  isFolderInside(folderId, ancestorId) {
    return this.collectFolderIds(ancestorId).includes(folderId);
  }

  /**
   * Delete a folder AND everything inside it (subfolders, instances,
   * entities), mirroring how Roblox Studio treats folder deletion as
   * subtree deletion. Returns the removed instance AND entity ids so
   * the caller can also remove their viewport representations (both
   * kinds live in the viewer's same tracked-object map).
   */
  removeFolder(id) {
    const folderIds = new Set(this.collectFolderIds(id));

    const removedIds = [];
    this.instances = this.instances.filter((inst) => {
      if (folderIds.has(inst.parentId)) {
        removedIds.push(inst.id);
        return false;
      }
      return true;
    });
    this.entities = this.entities.filter((ent) => {
      if (folderIds.has(ent.parentId)) {
        removedIds.push(ent.id);
        return false;
      }
      return true;
    });

    this.folders = this.folders.filter((f) => !folderIds.has(f.id));

    if (removedIds.includes(this.selectedInstanceId)) {
      this.selectedInstanceId = null;
    }
    if (folderIds.has(this.selectedFolderId)) {
      this.selectedFolderId = null;
    }

    return removedIds;
  }

  // ------------------------------------------------------------------
  // Editor entities (Triggers / Spawns / Summons / Particles / Billboards)
  // ------------------------------------------------------------------

  /**
   * Create an entity of `kind` (an ENTITY_KINDS key) with that kind's
   * default props. Spawn-like kinds get the next unique spawn ID.
   */
  addEntity(kind, parentId = null) {
    const def = ENTITY_KINDS[kind];
    if (!def) return null;

    const props = {};
    for (const propDef of def.props) {
      props[propDef.key] = propDef.uniqueSpawnId ? this.nextSpawnId++ : propDef.default;
    }

    const entity = {
      id: this.nextId++,
      kind,
      name: null,
      parentId,
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      props,
    };
    this.entities.push(entity);
    return entity;
  }

  getEntity(id) {
    return this.entities.find((ent) => ent.id === id) || null;
  }

  removeEntity(id) {
    const idx = this.entities.findIndex((ent) => ent.id === id);
    if (idx !== -1) this.entities.splice(idx, 1);
    if (this.selectedInstanceId === id) this.selectedInstanceId = null;
  }

  /**
   * Clone an entity (Ctrl+D parity with instances). Props copy verbatim
   * EXCEPT unique spawn IDs, which are freshly allocated - two spawns
   * sharing an ID is exactly the invalid state uniqueness exists to
   * prevent, so a duplicate must never be born already in violation.
   */
  duplicateEntity(id) {
    const original = this.getEntity(id);
    if (!original) return null;

    const def = ENTITY_KINDS[original.kind];
    const props = { ...original.props };
    for (const propDef of def.props) {
      if (propDef.uniqueSpawnId) props[propDef.key] = this.nextSpawnId++;
    }

    const clone = {
      id: this.nextId++,
      kind: original.kind,
      name: original.name,
      parentId: original.parentId,
      pos: { ...original.pos },
      rot: { ...original.rot },
      scale: { ...original.scale },
      props,
    };
    this.entities.push(clone);
    return clone;
  }

  /**
   * True if another spawn-like entity (any kind with a spawnId prop)
   * already uses `spawnId`. Used to warn on manual ID edits - soft
   * validation, same philosophy as palette rows: warn, don't block.
   */
  isSpawnIdTaken(spawnId, excludeEntityId) {
    return this.entities.some(
      (ent) => ent.id !== excludeEntityId && ent.props.spawnId === spawnId
    );
  }

  getInstance(id) {
    return this.instances.find((inst) => inst.id === id) || null;
  }

  /**
   * Set a single field on an instance OR entity via a dotted path, e.g.
   * 'pos.x'. Used by app.js's per-field <input> change handlers - the
   * transform fields in the Properties panel are shared between model
   * instances and editor entities, so this resolves either.
   */
  setInstanceField(id, path, value) {
    const instance = this.getInstance(id) || this.getEntity(id);
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
   * on the MAXIMUM clutHeight across all of its model's resolved
   * (non-null) materials.
   *
   * Max - not min - because of how the PS1 runtime actually consumes the
   * row (main.c, draw_object_into_ot): the object's palette row is
   * clamped PER TEXTURE against that texture's own paletteCount before
   * the setClut() call -
   *
   *     unsigned int row = objectPalette;
   *     if (row >= tex->paletteCount) row = tex->paletteCount - 1;
   *
   * so a multi-material model like house (House0.tim: 4 CLUT rows,
   * Grass0.tim: 1 row) legitimately supports rows 0-3: House0 swaps
   * through its four palettes while Grass0 safely clamps to its only
   * row. This tool's own viewport preview clamps identically
   * (tim_reader's getRGBATextureForRow), so preview, runtime, and this
   * validation now all agree. The previous MIN-based bound flagged
   * house's rows 1-3 as "out of range" even though both the preview and
   * the runtime handle them exactly as intended - a row is only truly
   * out of range when NO texture on the model has it (row >= max),
   * because then every texture just clamps and the row does nothing.
   *
   * If no materials resolved successfully (all null), fall back to 1
   * (i.e. only row 0 is valid) as a conservative default - there is no
   * real bound to check against in that scenario.
   */
  getMaxPaletteForInstance(id) {
    const instance = this.getInstance(id);
    if (!instance) return 1;

    const modelData = this.models.get(instance.model);
    if (!modelData || !modelData.materialsMap) return 1;

    let maxClutHeight = null;
    for (const decoded of modelData.materialsMap.values()) {
      if (decoded === null) continue;
      if (maxClutHeight === null || decoded.clutHeight > maxClutHeight) {
        maxClutHeight = decoded.clutHeight;
      }
    }

    return maxClutHeight === null ? 1 : maxClutHeight;
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
