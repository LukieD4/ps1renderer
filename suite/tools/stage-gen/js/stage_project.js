/*
 * stage_project.js
 *
 * Save/load the FULL editor session as a `.stagegen.json` project file,
 * mirroring palette-maker's presumed `.PaletteGen` save/load pattern.
 *
 * WHY dirHandle/loaded model binary data ISN'T serialized:
 * FileSystemDirectoryHandle / FileSystemFileHandle objects (from the File
 * System Access API) are live, capability-scoped references tied to the
 * browser's permission grant for this tab session - they cannot be
 * serialized to JSON or restored across a reload/reopen. Similarly, the
 * decoded .tim texture data (Uint8Arrays, potentially large) would bloat
 * the project file enormously and is trivially cheap to regenerate by
 * just re-reading the source files.
 *
 * So a project file only stores: the instance list, camera state, and the
 * list of model names that were in use (as a hint so the user knows which
 * assets to have ready). After loading a project, the user MUST reopen
 * their assets folder via "Open Assets Folder" so app.js can re-resolve
 * each referenced model name against the freshly granted dirHandle before
 * instances will actually render in the viewport again.
 */

// Version 2: adds display names (instance.name), the folder tree
// (folders array + instance.parentId), and each folder's collapsed flag.
// Version 3: adds editor entities (entities array - triggers, spawns,
// summons, particles, billboards; see stage_state.js's ENTITY_KINDS) and
// the nextSpawnId counter backing spawn/summon unique IDs.
// No backwards-compat shims: the loader in app.js simply defaults any
// missing newer fields (folders -> [], entities -> [], name -> null,
// parentId -> null), which happens to make older files load flat/empty
// where the newer concepts would be - same content, nothing errors.
// Version 4: adds the stage-level `fog` block (enabled/near/far/color/
// layers/cull/drift - see FOG_DEFAULTS in stage_state.js). Same no-shim
// policy as v2/v3: app.js merges whatever is present over FOG_DEFAULTS, so a
// v1-v3 file simply loads with main.c's compiled-in fog defaults, which is
// exactly the fog those older stages actually shipped with.
// Version 5: adds per-Sound unique IDs (soundId) and the nextSoundId
// counter backing them, plus the Trigger action schema that references
// them. Older files have no soundId, so every Sound would load with the
// schema default of 0 - app.js calls state.repairUniqueIds() after the
// merge to mint real ones, which is what keeps a v1-v4 file's sounds
// individually addressable rather than all sharing id 0.
// Version 6: adds per-instance `collide` (solid to the player at runtime -
// see COLLISION_ACTION_PLAN.md). Same no-shim policy as the versions above,
// but note the default is TRUE, so a v1-v5 file loads with every instance
// SOLID rather than every instance passable. That is deliberate and matches
// what a freshly placed instance does - but it is the one bump here that
// changes the behaviour of an old file rather than just adding a concept the
// file didn't have. An older project reopened after this wants an audit pass
// to untick foliage, decals and ceiling detail.
// Version 7: adds authored collision boxes (`colliders` array + the
// nextColliderId counter backing their addressable ids). A v1-v6 file simply
// loads with no boxes, which means every instance falls back to the automatic
// per-primitive AABB - exactly the behaviour those files already shipped with,
// so this bump changes nothing until Auto Box is pressed.
// Version 8: adds the per-instance `anim` block (default clip name, loop,
// speed, autoplay - see ANIM_DEFAULTS in stage_state.js). Same no-shim policy:
// app.js runs each loaded instance's anim through normalizeAnim(), so a v1-v7
// file (which has no `anim` key) loads every instance with clip=None - i.e. no
// default animation, exactly the behaviour those stages already had.
const PROJECT_FILE_VERSION = 8;

/**
 * Build the serializable project JSON from current editor state.
 */
export function buildProjectJson(state) {
  const modelNames = Array.from(state.models.keys());

  return {
    version: PROJECT_FILE_VERSION,
    camera: {
      pos: { ...state.camera.pos },
      rot: { ...state.camera.rot },
    },
    // Stage fog: flat primitives, so a spread is a full deep clone.
    fog: { ...state.fog },
    modelNames,
    folders: state.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      collapsed: folder.collapsed,
    })),
    instances: state.instances.map((inst) => ({
      id: inst.id,
      model: inst.model,
      palette: inst.palette,
      collide: inst.collide !== false,
      name: inst.name,
      parentId: inst.parentId,
      pos: { ...inst.pos },
      rot: { ...inst.rot },
      scale: { ...inst.scale },
      // Flat primitives, so a spread is a full deep clone. Always present on
      // live instances (addInstance seeds it); older loaded files got one
      // backfilled by normalizeAnim on the way in.
      anim: { ...inst.anim },
    })),
    colliders: state.colliders.map((c) => ({
      id: c.id,
      parentInstanceId: c.parentInstanceId,
      name: c.name,
      colliderId: c.colliderId,
      enabled: c.enabled !== false,
      center: { ...c.center },
      size: { ...c.size },
    })),
    entities: state.entities.map((ent) => ({
      id: ent.id,
      kind: ent.kind,
      name: ent.name,
      parentId: ent.parentId,
      pos: { ...ent.pos },
      rot: { ...ent.rot },
      scale: { ...ent.scale },
      props: { ...ent.props },
    })),
    nextId: state.nextId,
    nextSpawnId: state.nextSpawnId,
    nextSoundId: state.nextSoundId,
    nextColliderId: state.nextColliderId,
  };
}

/**
 * Trigger a browser download of the project JSON as a `.stagegen.json`
 * file, using the same Blob + temporary <a> click pattern as
 * stage_export.js's downloadStageJson.
 */
export function downloadProjectFile(json, filename) {
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

/**
 * Read and parse a project file (from a <input type="file"> selection).
 * Validates the shape loosely (just enough to catch "this isn't a
 * stage-gen project file" mistakes) and throws a descriptive Error on
 * failure so app.js can alert() it to the user.
 */
export async function loadProjectFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (err) {
    throw new Error(`Could not read project file: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Project file is not valid JSON: ${err.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Project file does not contain a JSON object.');
  }
  if (!Array.isArray(parsed.instances)) {
    throw new Error('Project file is missing an "instances" array - this may not be a stage-gen project file.');
  }
  if (!parsed.camera || typeof parsed.camera !== 'object') {
    throw new Error('Project file is missing a "camera" object.');
  }

  return parsed;
}
