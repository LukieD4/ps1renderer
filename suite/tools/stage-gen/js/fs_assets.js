/*
 * fs_assets.js
 *
 * Wraps the browser File System Access API (FSA API) for stage-gen.
 * We use `window.showDirectoryPicker()` instead of a plain <input type="file">
 * because the tool needs to walk a whole assets folder tree (model subfolders,
 * their .obj/.mtl, and their textures/ subfolder full of .tim files) and
 * re-resolve relative paths found inside .mtl files (map_Kd lines) against
 * that same tree. A single <input> file picker cannot give us directory
 * handles or relative-path resolution, only flat file lists.
 *
 * Folder-naming convention (mirrors the Python OBJ/TIM export pipeline):
 *   assets/object/<model_name>/<model_name>.obj
 *   assets/object/<model_name>/<model_name>.mtl
 *   assets/object/<model_name>/textures/<MaterialName>.tim
 * i.e. the model's folder name and its .obj/.mtl base filename are always
 * identical. This lets scanModels() find a model's files without parsing
 * any manifest - it just checks for <dirname>/<dirname>.obj and .mtl.
 */

/**
 * Prompt the user to pick the root assets folder.
 * Returns the FileSystemDirectoryHandle, or null if the user cancelled
 * the picker (AbortError - not a real failure, so we swallow it).
 */
export async function pickAssetsFolder() {
  try {
    const handle = await window.showDirectoryPicker();
    return handle;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
}

/**
 * Walk the immediate subdirectories of `rootDirHandle` looking for model
 * folders that follow the <name>/<name>.obj + <name>/<name>.mtl convention.
 * Subdirectories missing either file are skipped (with a console.warn) so
 * that unrelated folders (e.g. a stray textures-only folder) don't break
 * the scan.
 *
 * Model folders canonically live one level down, under object/
 * (assets/object/<model>/...). To keep the tool forgiving about exactly
 * which folder gets dropped, we transparently descend into an "object"
 * subdirectory when the dropped root has one - so dropping the whole
 * assets/ folder (which also contains sound/ and stage/) works just as
 * well as dropping assets/object/ itself.
 *
 * Returns: Array<{name, dirHandle, objHandle, mtlHandle}>
 */
export async function scanModels(rootDirHandle) {
  const results = [];

  // If the dropped root contains an object/ folder, that's where the
  // model folders actually live - scan inside it. Otherwise assume the
  // root already IS the models folder (e.g. assets/object was dropped).
  let modelsRoot = rootDirHandle;
  try {
    modelsRoot = await rootDirHandle.getDirectoryHandle('object');
  } catch (err) {
    // No object/ subdir - fall through and scan rootDirHandle directly.
  }

  for await (const [entryName, entryHandle] of modelsRoot.entries()) {
    if (entryHandle.kind !== 'directory') continue;

    const modelName = entryName;
    let objHandle = null;
    let mtlHandle = null;

    try {
      objHandle = await entryHandle.getFileHandle(`${modelName}.obj`);
    } catch (err) {
      console.warn(`scanModels: skipping "${modelName}" - missing ${modelName}.obj`);
      continue;
    }

    try {
      mtlHandle = await entryHandle.getFileHandle(`${modelName}.mtl`);
    } catch (err) {
      console.warn(`scanModels: skipping "${modelName}" - missing ${modelName}.mtl`);
      continue;
    }

    results.push({
      name: modelName,
      dirHandle: entryHandle,
      objHandle,
      mtlHandle,
    });
  }

  return results;
}

/**
 * Resolve a relative path (e.g. "textures/Grass0.tim", possibly with
 * backslashes from a Windows-authored .mtl) against a given directory
 * handle by walking each path segment: all but the last segment are
 * directories, the last is the target file.
 *
 * Returns the FileSystemFileHandle, or null (with console.warn) if any
 * segment along the way is missing.
 */
export async function resolveRelativePath(dirHandle, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) {
    console.warn(`resolveRelativePath: empty path`);
    return null;
  }

  let current = dirHandle;

  try {
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i]);
    }
    const fileHandle = await current.getFileHandle(segments[segments.length - 1]);
    return fileHandle;
  } catch (err) {
    console.warn(`resolveRelativePath: could not resolve "${relativePath}" (${err.message})`);
    return null;
  }
}
