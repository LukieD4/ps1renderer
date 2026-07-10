/*
 * scene_project.js
 *
 * Save/load the FULL editor session as a `.scenegen.json` project file,
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

const PROJECT_FILE_VERSION = 1;

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
    modelNames,
    instances: state.instances.map((inst) => ({
      id: inst.id,
      model: inst.model,
      palette: inst.palette,
      pos: { ...inst.pos },
      rot: { ...inst.rot },
      scale: { ...inst.scale },
    })),
    nextId: state.nextId,
  };
}

/**
 * Trigger a browser download of the project JSON as a `.scenegen.json`
 * file, using the same Blob + temporary <a> click pattern as
 * scene_export.js's downloadSceneJson.
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
 * scene-gen project file" mistakes) and throws a descriptive Error on
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
    throw new Error('Project file is missing an "instances" array - this may not be a scene-gen project file.');
  }
  if (!parsed.camera || typeof parsed.camera !== 'object') {
    throw new Error('Project file is missing a "camera" object.');
  }

  return parsed;
}
