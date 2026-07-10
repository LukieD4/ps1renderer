/*
 * dnd_assets.js
 *
 * Firefox fallback for opening the assets folder.
 *
 * ----------------------------------------------------------------------
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------
 * fs_assets.js's pickAssetsFolder() uses window.showDirectoryPicker(),
 * which Firefox does not implement at all (Chrome/Edge only). A polyfill
 * exists (use-strict/file-system-access) but per community reports it
 * doesn't reliably walk more than one level deep - and this tool needs
 * TWO levels (assets/<model>/textures/<file>.tim), so that polyfill is
 * not safe to rely on here.
 *
 * Firefox DOES support recursively walking a dropped folder tree via the
 * older drag-and-drop DataTransferItem.webkitGetAsEntry() API (despite
 * the "webkit" name, this is broadly supported including Firefox). This
 * module drives that API and wraps the result in a tiny SHIM that exposes
 * the exact same handle interface real File System Access API handles
 * do - .entries(), .getFileHandle(name), .getDirectoryHandle(name), and
 * .getFile() returning a File-like object with .text()/.arrayBuffer().
 *
 * Because scanModels()/resolveRelativePath() in fs_assets.js, and
 * resolveMaterials() in mtl_resolver.js, only ever call THOSE methods -
 * never anything native-FSA-specific - they work completely unmodified
 * against a shimmed handle from a drag-and-drop folder just as well as
 * against a real FileSystemDirectoryHandle from showDirectoryPicker().
 * app.js picks whichever backend is available at startup (see
 * pickBestAssetsBackend() below) and everything downstream is agnostic
 * to which one supplied the handle.
 * ----------------------------------------------------------------------
 */

/**
 * A minimal in-memory directory handle shim, backed by a plain nested
 * Map tree built from a drag-and-drop walk. Implements just enough of
 * the FileSystemDirectoryHandle surface for this tool's consumers.
 */
class ShimDirectoryHandle {
  constructor(name, entriesMap) {
    this.kind = 'directory';
    this.name = name;
    // entriesMap: Map<string, ShimDirectoryHandle | ShimFileHandle>
    this._entries = entriesMap;
  }

  async getFileHandle(name) {
    const entry = this._entries.get(name);
    if (!entry || entry.kind !== 'file') {
      const err = new Error(`No such file: ${name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    return entry;
  }

  async getDirectoryHandle(name) {
    const entry = this._entries.get(name);
    if (!entry || entry.kind !== 'directory') {
      const err = new Error(`No such directory: ${name}`);
      err.name = 'NotFoundError';
      throw err;
    }
    return entry;
  }

  // Async iterator yielding [name, handle] pairs, matching
  // FileSystemDirectoryHandle.entries()'s shape (used by scanModels()'s
  // `for await (const [name, handle] of rootDirHandle.entries())`).
  async *entries() {
    for (const [name, handle] of this._entries) {
      yield [name, handle];
    }
  }
}

/**
 * A minimal in-memory file handle shim wrapping a real browser File
 * object (drag-and-drop gives us real File objects directly, unlike
 * directory handles which FSA API normally provides but drag-and-drop
 * doesn't - hence this shim layer existing at all).
 */
class ShimFileHandle {
  constructor(name, file) {
    this.kind = 'file';
    this.name = name;
    this._file = file;
  }

  async getFile() {
    // Real FileSystemFileHandle.getFile() returns a File (or a fresh
    // copy of one); returning the same File object we already have is
    // equivalent for this tool's read-only use (.text()/.arrayBuffer()).
    return this._file;
  }
}

/**
 * Recursively read a dropped FileSystemEntry (the drag-and-drop API's
 * own entry type, NOT a File System Access API handle - unfortunately
 * both APIs use overlapping terminology for unrelated types) into our
 * Shim*Handle tree.
 */
function readEntryRecursive(entry) {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      entry.file(
        (file) => resolve(new ShimFileHandle(entry.name, file)),
        reject
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];

      // readEntries() only returns entries in batches (Chrome caps
      // around 100 per call even though this path is Firefox-focused,
      // some engines share the underlying implementation) - keep
      // calling until it returns an empty array, per the documented
      // pattern for this API.
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            try {
              const childHandles = await Promise.all(collected.map(readEntryRecursive));
              const map = new Map();
              collected.forEach((childEntry, i) => map.set(childEntry.name, childHandles[i]));
              resolve(new ShimDirectoryHandle(entry.name, map));
            } catch (err) {
              reject(err);
            }
            return;
          }
          collected.push(...batch);
          readBatch();
        }, reject);
      };

      readBatch();
    } else {
      reject(new Error(`Unsupported entry type for "${entry.name}"`));
    }
  });
}

/**
 * True if the native File System Access API's directory picker is
 * available in this browser (Chrome/Edge). When false, callers should
 * use the drag-and-drop flow this module provides instead.
 */
export function hasNativeDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

/**
 * Wire a drop zone element to accept a dragged assets folder and resolve
 * to a root ShimDirectoryHandle equivalent to what pickAssetsFolder()
 * (fs_assets.js) returns from the native picker - so callers can treat
 * the two interchangeably.
 *
 * `onFolderReady(rootShimHandle)` fires once the whole tree has been
 * read into memory. `onError(err)` fires if the drop wasn't a folder or
 * reading failed.
 *
 * Note: the user must drop the ROOT assets folder itself (the one
 * containing the per-model subfolders), same expectation as the native
 * picker flow - dropping a single model folder or individual files will
 * scan zero valid models.
 */
export function initDropZone(dropZoneEl, { onFolderReady, onError }) {
  const preventDefaults = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
    dropZoneEl.addEventListener(evt, preventDefaults);
  });

  dropZoneEl.addEventListener('dragenter', () => dropZoneEl.classList.add('is-dragover'));
  dropZoneEl.addEventListener('dragover', () => dropZoneEl.classList.add('is-dragover'));
  dropZoneEl.addEventListener('dragleave', () => dropZoneEl.classList.remove('is-dragover'));

  dropZoneEl.addEventListener('drop', async (e) => {
    dropZoneEl.classList.remove('is-dragover');

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) {
      onError(new Error('Drop did not contain any files or folders.'));
      return;
    }

    // webkitGetAsEntry() is the whole reason this has to be a drag/drop
    // handler rather than a plain <input type="file" webkitdirectory> -
    // only the DataTransferItem drop path exposes real directory entries
    // we can recurse into; the <input webkitdirectory> flat-file-list
    // form loses the folder structure resolveRelativePath() needs.
    const entry = items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;

    if (!entry) {
      onError(new Error('This browser does not support reading dropped folder structure.'));
      return;
    }

    if (!entry.isDirectory) {
      onError(new Error('Please drop the root assets folder itself, not a file.'));
      return;
    }

    try {
      const rootShimHandle = await readEntryRecursive(entry);
      onFolderReady(rootShimHandle);
    } catch (err) {
      onError(err);
    }
  });
}
