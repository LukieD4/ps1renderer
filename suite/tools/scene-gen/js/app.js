/*
 * app.js
 *
 * Entry point / controller. Wires DOM events to scene_state.js mutations
 * and viewer.js viewport calls, and re-renders the whole sidebar from a
 * single central updateUI() function after every mutation (mirrors
 * palette-maker's app.js "one central re-render" pattern).
 *
 * MODULE STRATEGY DEVIATION FROM PALETTE-MAKER:
 * palette-maker's non-module files use the IIFE + `window.PaletteGen`
 * global-namespace pattern, loaded via plain <script> tags in a fixed
 * order. scene-gen deviates from that here: every JS file (including
 * viewer.js and app.js) is a proper ES module using `export`, and
 * index.html loads ONLY this file via <script type="module" src="js/app.js">.
 * This is necessary because the Three.js addons (OBJLoader, OrbitControls,
 * TransformControls) are only published as ES modules and are consumed
 * here via an import map - mixing that with global-namespace IIFEs for
 * the rest of the app would mean maintaining two different loading
 * strategies for no benefit. Pure ESM throughout also sidesteps
 * script-tag-order bugs entirely, since imports make dependencies
 * explicit and are resolved by the browser's module graph. "use strict"
 * is implicit in ES modules, so it is not written out anywhere.
 */

import { pickAssetsFolder, scanModels } from './fs_assets.js';
import { hasNativeDirectoryPicker, initDropZone } from './dnd_assets.js';
import { resolveMaterials } from './mtl_resolver.js';
import { SceneState } from './scene_state.js';
import { buildSceneJson, downloadSceneJson } from './scene_export.js';
import { buildProjectJson, downloadProjectFile, loadProjectFile } from './scene_project.js';
import { pushHistory, undo, redo, canUndo, canRedo, clearHistory } from './history.js';
import { showError, showWarning, showInfo } from './toast.js';
import { showConfirm } from './modal.js';
import { makeScrubbable } from './drag_scrub.js';
import { computeVramUsage, formatBytes } from './vram.js';
import * as viewer from './viewer.js';

// ---- DOM refs ----
const canvasEl = document.getElementById('viewport-canvas');
const gizmoCanvasEl = document.getElementById('viewport-gizmo-canvas');

const btnViewFront = document.getElementById('view-front');
const btnViewTop = document.getElementById('view-top');
const btnViewSide = document.getElementById('view-side');
const btnViewReset = document.getElementById('view-reset');

const btnOpenAssets = document.getElementById('btn-open-assets');
const dropZoneAssets = document.getElementById('dropzone-assets');
const modelListEl = document.getElementById('model-list');

const btnAddInstance = document.getElementById('btn-add-instance');
const instanceListEl = document.getElementById('instance-list');
const instanceFieldsEl = document.getElementById('instance-fields');

const fPosX = document.getElementById('f-pos-x');
const fPosY = document.getElementById('f-pos-y');
const fPosZ = document.getElementById('f-pos-z');
const fRotX = document.getElementById('f-rot-x');
const fRotY = document.getElementById('f-rot-y');
const fRotZ = document.getElementById('f-rot-z');
const fScaleX = document.getElementById('f-scale-x');
const fScaleY = document.getElementById('f-scale-y');
const fScaleZ = document.getElementById('f-scale-z');
const fPalette = document.getElementById('f-palette');

const camPosX = document.getElementById('cam-pos-x');
const camPosY = document.getElementById('cam-pos-y');
const camPosZ = document.getElementById('cam-pos-z');
const camRotX = document.getElementById('cam-rot-x');
const camRotY = document.getElementById('cam-rot-y');
const camRotZ = document.getElementById('cam-rot-z');

const modeButtons = {
  translate: document.getElementById('mode-translate'),
  rotate: document.getElementById('mode-rotate'),
  scale: document.getElementById('mode-scale'),
};

const btnLoadProject = document.getElementById('btn-load-project');
const btnSaveProject = document.getElementById('btn-save-project');
const btnExportScene = document.getElementById('btn-export-scene');
const fileLoadProject = document.getElementById('file-load-project');

// ---- app state ----
const state = new SceneState();
let activeModelName = null; // the model that "Add Instance" will place
let currentTransformMode = 'translate';

// Unsaved-changes tracking (QOL): flipped true by markDirty() alongside
// every undoable mutation, cleared by Save Project / Load Project. Drives
// the beforeunload "you have unsaved changes" prompt below.
let isDirty = false;

function markDirty() {
  isDirty = true;
}

window.addEventListener('beforeunload', (event) => {
  if (!isDirty) return;
  event.preventDefault();
  event.returnValue = ''; // required by Chrome to actually show the prompt
});

// Round a value to (at least) 3 decimal places for display/storage. Applied
// everywhere a numeric field's value is written from live data (gizmo
// drags, scrub drags, undo/redo restores) so displayed/stored pos-rot-scale
// numbers never carry raw floating-point noise (e.g. 2.0000000000000004)
// that Three.js math routinely introduces. toFixed + parseFloat rather than
// a manual Math.round(*1000)/1000 so it's not vulnerable to the classic
// floating-point round-trip artifacts of the multiply/divide approach.
function round3(value) {
  return parseFloat(value.toFixed(3));
}

/**
 * Make the VIEWPORT (Three.js scene) match state.instances, INCREMENTALLY:
 *   - remove any tracked viewport instance whose id no longer exists in
 *     state.instances at all (deletions, or a full state swap)
 *   - add any state.instances entry that ISN'T yet represented in the
 *     viewport, PROVIDED its model is loaded in state.models (unresolved
 *     ones are skipped and reported back via the returned Set, same
 *     "not loaded yet" concept the project-load flow already surfaces)
 *   - instances that are ALREADY correctly represented are left alone -
 *     NOT torn down and rebuilt
 *
 * This incremental diff (rather than "wipe everything, rebuild
 * everything") matters for one specific call site: selectModel() calls
 * this every time a NEW model finishes loading, so that any instances
 * from an already-loaded project that were WAITING on that model spawn
 * immediately (see selectModel()'s own comment for the full bug this
 * fixes). If this function destroyed and recreated every instance on
 * every call, loading a project's 2nd/3rd/... model would repeatedly
 * tear down and rebuild every ALREADY-visible instance of the 1st model
 * too - thrashing textures, losing the current gizmo selection, and
 * wasting work, for models that were already fine.
 *
 * Also used by project-load and undo/redo, where a full instance-id-set
 * swap naturally reduces to "remove everything old, add everything new"
 * via the same add-if-missing/remove-if-gone diff - no separate code path
 * needed for those callers.
 */
function resyncViewportFromState() {
  const desiredIds = new Set(state.instances.map((inst) => inst.id));

  for (const trackedId of viewer.getTrackedInstanceIds()) {
    if (!desiredIds.has(trackedId)) {
      viewer.removeInstance(trackedId);
    }
  }

  const trackedIds = new Set(viewer.getTrackedInstanceIds());
  const unresolvedModelNames = new Set();

  for (const inst of state.instances) {
    if (trackedIds.has(inst.id)) {
      // Already represented in the viewport, but its DATA may have just
      // changed underneath it - notably after undo/redo restores a
      // snapshot with a different transform/palette for the same
      // instance id. setInstanceTransform/updateInstancePaletteRow are
      // cheap no-op-ish calls when nothing actually changed, so it's
      // simplest (and correct) to always push the current state's values
      // down rather than trying to diff field-by-field first.
      viewer.setInstanceTransform(inst.id, { pos: inst.pos, rot: inst.rot, scale: inst.scale });
      viewer.updateInstancePaletteRow(inst.id, inst.palette);
      continue;
    }

    const modelData = state.models.get(inst.model);
    if (!modelData) {
      unresolvedModelNames.add(inst.model);
      continue;
    }
    viewer.addInstance(inst.id, inst.model, inst, modelData.materialsMap);
    viewer.updateInstancePaletteRow(inst.id, inst.palette);
  }

  viewer.setCameraTransform(state.camera);

  if (state.selectedInstanceId !== null && state.getInstance(state.selectedInstanceId)) {
    viewer.selectInstance(state.selectedInstanceId);
  } else {
    viewer.selectInstance(null);
  }

  return unresolvedModelNames;
}

// ==========================================================================
// Assets panel
// ==========================================================================

// Shared by both backends (native picker and drag-and-drop): once we
// have a root directory handle - real or the dnd_assets.js in-memory
// shim, scanModels() (fs_assets.js) treats them identically since the
// shim implements the same .entries()/.getFileHandle()/.getDirectoryHandle()
// surface - scan it for model folders and populate the sidebar list.
async function handleRootFolderHandle(rootHandle) {
  let found;
  try {
    found = await scanModels(rootHandle);
  } catch (err) {
    showError(`Failed to scan assets folder: ${err.message}`);
    return;
  }

  if (found.length === 0) {
    showWarning('No valid models found. Each model needs a subfolder containing <name>.obj and <name>.mtl with matching names.');
    return;
  }

  // Store the discovered handles for on-demand loading when the user
  // clicks a model in the list (avoids loading every model's .obj/.mtl/
  // .tim data up front, which could be slow for a large assets folder).
  window.__sceneGenDiscoveredModels = found;

  // BUG FIX (project-first, assets-second ordering): the auto-load of a
  // project's referenced models used to live ONLY in the project-load
  // handler, which auto-loads from whatever assets folder is ALREADY
  // open. Opening the folder in the opposite order - load project, THEN
  // connect the assets directory - left every instance invisible with no
  // trigger to ever load their models: this function just rendered the
  // sidebar list and waited for the user to click each model by hand.
  // Mirror the same auto-load here: any model that placed instances are
  // already waiting on gets loaded immediately, and loadModelData()'s
  // own resyncViewportFromState() call spawns those instances as each
  // model comes in. Both orderings now behave identically.
  const referencedModelNames = new Set(state.instances.map((inst) => inst.model));
  for (const name of referencedModelNames) {
    const entry = found.find((d) => d.name === name);
    if (entry) await loadModelData(entry);
  }

  const stillMissing = Array.from(referencedModelNames).filter((name) => !state.models.has(name));
  if (stillMissing.length > 0) {
    showWarning(
      `This assets folder doesn't contain: ${stillMissing.join(', ')}. Their instances stay hidden until a folder containing them is opened.`
    );
  }

  updateUI();
}

// Startup: pick whichever assets-folder backend this browser actually
// supports. Chrome/Edge get the native showDirectoryPicker() button;
// Firefox (and anything else missing that API) gets a drag-and-drop zone
// instead, since Firefox has no native directory picker and the known
// showDirectoryPicker() ponyfill doesn't reliably walk more than one
// level deep - not safe for this tool's two-level assets/<model>/textures/
// structure. See dnd_assets.js's header comment for the full story.
if (hasNativeDirectoryPicker()) {
  btnOpenAssets.classList.remove('hidden');

  btnOpenAssets.addEventListener('click', async () => {
    let rootHandle;
    try {
      rootHandle = await pickAssetsFolder();
    } catch (err) {
      showError(`Failed to open assets folder: ${err.message}`);
      return;
    }
    if (!rootHandle) return; // user cancelled

    await handleRootFolderHandle(rootHandle);
  });
} else {
  dropZoneAssets.classList.remove('hidden');

  initDropZone(dropZoneAssets, {
    onFolderReady: (rootShimHandle) => {
      handleRootFolderHandle(rootShimHandle);
    },
    onError: (err) => {
      showError(`Failed to read dropped folder: ${err.message}`);
    },
  });
}

/**
 * Read + resolve one model's .obj/.mtl/.tim data and register it into
 * both state.models and the viewer's template cache. Returns true on
 * success, false on failure (with a toast already shown). A no-op (still
 * returns true) if the model is already loaded.
 *
 * Factored out of selectModel() so it can ALSO be called automatically -
 * without any click - for every model name a freshly-loaded project
 * references (see the project-load handler's "auto-load referenced
 * models" step further down), not just when the user manually clicks a
 * model in the sidebar list.
 */
async function loadModelData(modelEntry) {
  if (state.models.has(modelEntry.name)) return true;

  let objText;
  let mtlText;
  try {
    objText = await (await modelEntry.objHandle.getFile()).text();
    mtlText = await (await modelEntry.mtlHandle.getFile()).text();
  } catch (err) {
    showError(`Failed to read model "${modelEntry.name}": ${err.message}`);
    return false;
  }

  const materialsMap = await resolveMaterials(modelEntry.dirHandle, mtlText);

  state.addModel(modelEntry.name, {
    objText,
    mtlText,
    materialsMap,
    dirHandle: modelEntry.dirHandle,
  });

  const strayCount = viewer.loadModelIntoScene(modelEntry.name, objText, materialsMap);
  if (strayCount > 0) {
    // Stray edges/points would otherwise silently turn the whole object
    // into a wireframe (see loadModelIntoScene's sanitization comment).
    // The viewer already stripped them; this warning is so the artist
    // knows to clean the source asset (Blender: Mesh > Clean Up >
    // Delete Loose) rather than shipping strays to the PS1 converter.
    showWarning(
      `Model "${modelEntry.name}": ignored ${strayCount} stray edge/point element(s) in the .obj. ` +
      `Faces still load here, but clean the asset in Blender (Mesh > Clean Up > Delete Loose) before converting.`
    );
  }

  // This is the fix for "load a project, THEN load assets - instances
  // never appear": resyncViewportFromState() was previously only called
  // right after a PROJECT finished loading (or on undo/redo), never
  // after a MODEL finishes loading. If a project was loaded first,
  // state.instances can already contain entries referencing this exact
  // model name (with zero viewport representation, since the model
  // didn't exist yet when the project loaded) - now that the model's
  // template is loaded, immediately spawn any instances that were
  // waiting on it instead of leaving them invisible forever with no
  // further trigger to ever check again.
  resyncViewportFromState();

  return true;
}

async function selectModel(modelEntry) {
  await loadModelData(modelEntry);
  activeModelName = modelEntry.name;
  updateUI();
}

function renderModelList(discoveredModels) {
  modelListEl.innerHTML = '';
  for (const entry of discoveredModels) {
    const li = document.createElement('li');
    li.className = entry.name === activeModelName ? 'is-selected' : '';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    // QOL: loaded models show their triangle count (useful for PS1 budget
    // awareness at a glance); unloaded ones keep the "(not loaded)" tag.
    if (state.models.has(entry.name)) {
      const tris = viewer.getModelTriCount(entry.name);
      nameSpan.textContent = tris !== null ? `${entry.name} (${tris} tris)` : entry.name;
    } else {
      nameSpan.textContent = `${entry.name} (not loaded)`;
    }
    li.appendChild(nameSpan);

    li.addEventListener('click', () => selectModel(entry));
    modelListEl.appendChild(li);
  }
}

// ==========================================================================
// Instances panel
// ==========================================================================

btnAddInstance.addEventListener('click', () => {
  if (!activeModelName) return;
  pushHistory(state);
  markDirty();
  const instance = state.addInstance(activeModelName);
  const modelData = state.models.get(activeModelName);
  viewer.addInstance(instance.id, activeModelName, instance, modelData.materialsMap);
  state.selectedInstanceId = instance.id;
  viewer.selectInstance(instance.id);
  updateUI();
});

/**
 * Duplicate a single instance by id: pushes undo history, clones it in
 * state + the viewport, and selects the new copy. Shared by the sidebar
 * list's per-row "Dup" button and the Ctrl+D keyboard shortcut (see the
 * keydown handler further down) so both stay in sync with one
 * implementation instead of two copies that could drift apart.
 */
function duplicateInstance(id) {
  const original = state.getInstance(id);
  if (!original) return;

  pushHistory(state);
  markDirty();
  const clone = state.duplicateInstance(id);
  const modelData = state.models.get(clone.model);
  viewer.addInstance(clone.id, clone.model, clone, modelData.materialsMap);
  viewer.updateInstancePaletteRow(clone.id, clone.palette);
  state.selectedInstanceId = clone.id;
  viewer.selectInstance(clone.id);
  updateUI();
}

/**
 * Delete a single instance by id, after an in-page confirm dialog
 * (modal.js - our own HTML prompt, NOT window.confirm(): native prompts
 * block the whole tab including the render loop, and can't match the
 * tool's styling or keyboard handling). Shared by the sidebar list's
 * per-row "Del" button and the Delete/Backspace keyboard shortcut, same
 * reasoning as duplicateInstance() above.
 *
 * Async because the dialog is promise-based; the instance is re-fetched
 * after the await in case state changed while the dialog was open (e.g.
 * an undo restored to a snapshot where this id no longer exists).
 */
async function deleteInstance(id) {
  const instance = state.getInstance(id);
  if (!instance) return;

  const ok = await showConfirm({
    title: 'Delete instance',
    message: `Delete instance #${instance.id} (${instance.model})?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
  });
  if (!ok) return;
  if (!state.getInstance(id)) return; // vanished while dialog was open

  pushHistory(state);
  markDirty();
  state.removeInstance(id);
  viewer.removeInstance(id);
  updateUI();
}

function renderInstanceList() {
  instanceListEl.innerHTML = '';

  for (const instance of state.instances) {
    const li = document.createElement('li');
    li.className = instance.id === state.selectedInstanceId ? 'is-selected' : '';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = `${instance.model} #${instance.id}`;
    nameSpan.addEventListener('click', () => {
      state.selectedInstanceId = instance.id;
      viewer.selectInstance(instance.id);
      updateUI();
    });
    li.appendChild(nameSpan);

    const actions = document.createElement('span');
    actions.className = 'item-actions';

    const dupBtn = document.createElement('button');
    dupBtn.textContent = 'Dup';
    dupBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      duplicateInstance(instance.id);
    });
    actions.appendChild(dupBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Del';
    delBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      deleteInstance(instance.id);
    });
    actions.appendChild(delBtn);

    li.appendChild(actions);
    instanceListEl.appendChild(li);
  }
}

/**
 * Apply a field's current value to state + the viewport. Shared by BOTH
 * the live 'input' listener (fires continuously while drag-scrubbing,
 * see drag_scrub.js) and the committing 'change' listener (fires once,
 * at blur/Enter/scrub-release) - `pushUndo` controls whether this call
 * also records a history entry, so the live path can update the 3D view
 * in real time during a drag WITHOUT spamming one undo entry per pixel of
 * movement (that's still pushed exactly once, by the 'change' handler).
 *
 * `fullRerender` controls whether the whole sidebar re-renders via
 * updateUI() - skipped during live drag updates (the field the user is
 * actively dragging doesn't need to re-render ITSELF from state on every
 * frame; only the 3D viewport needs to move) to avoid the visual jank of
 * re-rendering the entire instance list dozens of times per second.
 */
function applyInstanceField(inputEl, path, { pushUndo, fullRerender }) {
  const id = state.selectedInstanceId;
  if (id === null) return;

  const [group] = path.split('.');
  // Palette is a row INDEX, not a continuous quantity - always an
  // integer, and never negative (matches the field's own min="0"
  // attribute). parseInt guards against a typed "2.5" or a scrub's
  // floating-point rounding noise producing a fractional row.
  const value = group === 'palette' ? parseInt(inputEl.value, 10) : round3(parseFloat(inputEl.value));
  if (Number.isNaN(value) || (group === 'palette' && value < 0)) return;

  if (pushUndo) {
    pushHistory(state);
    markDirty();
  }
  state.setInstanceField(id, path, value);

  if (group === 'palette') {
    viewer.updateInstancePaletteRow(id, value);
  } else {
    viewer.setInstanceTransform(id, { [group]: state.getInstance(id)[group] });
  }

  if (fullRerender) {
    updateUI();
  } else {
    // Still refresh the palette-range warning styling on the field being
    // dragged itself, even without a full re-render - this is cheap
    // (one classList check) and keeps the warning indicator live-accurate
    // during a palette scrub instead of only updating after release.
    if (group === 'palette') {
      const maxPalette = state.getMaxPaletteForInstance(id);
      inputEl.classList.toggle('field-warning', value >= maxPalette);
    }
  }
}

function wireInstanceField(inputEl, path) {
  inputEl.addEventListener('input', () => {
    applyInstanceField(inputEl, path, { pushUndo: false, fullRerender: false });
  });
  inputEl.addEventListener('change', () => {
    applyInstanceField(inputEl, path, { pushUndo: true, fullRerender: true });
  });
}

wireInstanceField(fPosX, 'pos.x');
wireInstanceField(fPosY, 'pos.y');
wireInstanceField(fPosZ, 'pos.z');
wireInstanceField(fRotX, 'rot.x');
wireInstanceField(fRotY, 'rot.y');
wireInstanceField(fRotZ, 'rot.z');
wireInstanceField(fScaleX, 'scale.x');
wireInstanceField(fScaleY, 'scale.y');
wireInstanceField(fScaleZ, 'scale.z');
wireInstanceField(fPalette, 'palette');

// Undo snapshot for gizmo drags: fired ONCE at drag-start (mouse-down on
// a handle), before any of the continuous 'objectChange' events for that
// drag - see viewer.js's onDragStart() header comment for why this has to
// be a separate hook from onTransformChange() below, rather than pushing
// history on every objectChange (which fires many times per drag and
// would make undo only step back a tiny fraction of the drag at a time).
viewer.onDragStart(() => {
  pushHistory(state);
  markDirty();
});

// Live sync while dragging the gizmo (two-way sync). 'objectChange' fires
// continuously (per mouse-move) during a drag, so this deliberately does
// NOT call the full updateUI() - rebuilding the entire sidebar's DOM
// (model list, instance list, buttons) dozens of times per second is
// wasted work and visible jank when only the 9 transform number fields
// and 6 camera fields can actually have changed. refreshTransformFields()
// (extracted from updateUI, shared by both) rewrites just those inputs.
function round3Axes(v) {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}

viewer.onTransformChange((id, transform) => {
  if (id === '__camera__') {
    state.camera.pos = round3Axes(transform.pos);
    state.camera.rot = round3Axes(transform.rot);
  } else {
    const instance = state.getInstance(id);
    if (!instance) return;
    instance.pos = round3Axes(transform.pos);
    instance.rot = round3Axes(transform.rot);
    if (transform.scale) instance.scale = round3Axes(transform.scale);
  }
  refreshTransformFields();
});

viewer.onSelectionChange((id) => {
  if (id === '__camera__') {
    state.selectedInstanceId = null;
    viewer.selectCameraGizmo();
  } else {
    state.selectedInstanceId = id;
    viewer.selectInstance(id);
  }
  updateUI();
});

// ==========================================================================
// Camera panel
// ==========================================================================

// Same live-vs-commit split as applyInstanceField() above: 'input' fires
// continuously during a drag-scrub (moves the camera gizmo live, no undo
// entry, no full re-render), 'change' fires once at release/blur/Enter
// (commits the value, pushes exactly one undo entry, re-renders the
// sidebar).
function applyCameraField(inputEl, group, axis, { pushUndo, fullRerender }) {
  const value = round3(parseFloat(inputEl.value));
  if (Number.isNaN(value)) return;

  if (pushUndo) {
    pushHistory(state);
    markDirty();
  }
  state.camera[group][axis] = value;
  viewer.setCameraTransform({ [group]: { [axis]: value } });

  if (fullRerender) updateUI();
}

function wireCameraField(inputEl, group, axis) {
  inputEl.addEventListener('input', () => {
    applyCameraField(inputEl, group, axis, { pushUndo: false, fullRerender: false });
  });
  inputEl.addEventListener('change', () => {
    applyCameraField(inputEl, group, axis, { pushUndo: true, fullRerender: true });
  });
}

wireCameraField(camPosX, 'pos', 'x');
wireCameraField(camPosY, 'pos', 'y');
wireCameraField(camPosZ, 'pos', 'z');
wireCameraField(camRotX, 'rot', 'x');
wireCameraField(camRotY, 'rot', 'y');
wireCameraField(camRotZ, 'rot', 'z');

// ==========================================================================
// Transform mode panel
// ==========================================================================

for (const [mode, btn] of Object.entries(modeButtons)) {
  btn.addEventListener('click', () => {
    currentTransformMode = mode;
    viewer.setTransformMode(mode);
    updateUI();
  });
}

// ==========================================================================
// Viewport view panel (editing orbit camera only - NOT the exported PS1
// camera gizmo, which is handled separately by the "Camera panel" section
// above via wireCameraField()).
// ==========================================================================

btnViewFront.addEventListener('click', () => viewer.setViewportView('front'));
btnViewTop.addEventListener('click', () => viewer.setViewportView('top'));
btnViewSide.addEventListener('click', () => viewer.setViewportView('side'));
btnViewReset.addEventListener('click', () => viewer.resetViewportCamera());
document.getElementById('view-grid').addEventListener('click', () => viewer.toggleGridVisible());

// ==========================================================================
// Transport footer: Load / Save / Export
// ==========================================================================

btnSaveProject.addEventListener('click', () => {
  const json = buildProjectJson(state);
  downloadProjectFile(json, 'development.SceneGen');
  isDirty = false; // saved - beforeunload prompt no longer needed until the next mutation
});

btnLoadProject.addEventListener('click', () => {
  fileLoadProject.click();
});

fileLoadProject.addEventListener('change', async () => {
  const file = fileLoadProject.files[0];
  fileLoadProject.value = '';
  if (!file) return;

  let parsed;
  try {
    parsed = await loadProjectFile(file);
  } catch (err) {
    showError(`Could not load project: ${err.message}`);
    return;
  }

  // Reset instance/camera state from the loaded project. Model BINARY data
  // (dirHandle, materialsMap) is NOT restored - see scene_project.js
  // header comment for why - but if the referenced model is ALREADY loaded
  // in this session's state.models (e.g. the assets folder was opened
  // before loading this project, or is still open from earlier), there is
  // no reason to wait: resyncViewportFromState() below spawns it
  // immediately. Only models NOT already in state.models actually need
  // the assets folder reopened, so the warning is scoped to just those.
  state.instances = parsed.instances.map((inst) => ({
    id: inst.id,
    model: inst.model,
    palette: inst.palette,
    pos: { ...inst.pos },
    rot: { ...inst.rot },
    scale: { ...inst.scale },
  }));
  state.camera.pos = { ...parsed.camera.pos };
  state.camera.rot = { ...parsed.camera.rot };
  state.selectedInstanceId = null;
  state.nextId = parsed.nextId || (Math.max(0, ...state.instances.map((i) => i.id)) + 1);

  // Loading a whole new project makes the PREVIOUS project's undo history
  // meaningless (undoing "into" a different loaded file would be
  // confusing, not useful), so history starts fresh here.
  clearHistory();
  isDirty = false; // freshly-loaded project == nothing unsaved yet

  // Auto-load every model this project's instances reference, PROVIDED
  // the assets folder is already open this session (i.e. its entry
  // exists in window.__sceneGenDiscoveredModels - populated by
  // handleRootFolderHandle() when "Open Assets Folder" was used, at any
  // point before or after this project load). Previously the user had to
  // manually click each model name in the sidebar list one at a time
  // after loading a project, even when the exact folder those models
  // live in was already open and fully scanned - loadModelData() already
  // does the real work (parse .obj/.mtl, decode .tim textures, register
  // the template), this just calls it automatically for every name the
  // project actually needs instead of waiting for a click per model.
  const referencedModelNames = new Set(state.instances.map((inst) => inst.model));
  const discovered = window.__sceneGenDiscoveredModels || [];
  for (const name of referencedModelNames) {
    const entry = discovered.find((d) => d.name === name);
    if (entry) await loadModelData(entry);
  }

  const unresolvedModelNames = resyncViewportFromState();
  if (unresolvedModelNames.size > 0) {
    showInfo(
      `Project loaded. These models aren't loaded yet, so their instances won't appear until you reopen the matching assets folder: ${Array.from(unresolvedModelNames).join(', ')}`
    );
  } else {
    showInfo('Project loaded.');
  }

  updateUI();
});

btnExportScene.addEventListener('click', () => {
  const warnings = state.validatePaletteAssignments();
  if (warnings.length > 0) {
    // We warn but do not block export: a slightly out-of-range palette
    // row is recoverable (the artist can still see/fix it in the exported
    // file or by re-opening the tool), whereas blocking export entirely
    // over a palette warning could stop the artist from getting any
    // output at all during iterative work. The warnings are surfaced via
    // updateUI()'s field styling and this toast.
    showWarning(`Palette warnings:\n${warnings.map((w) => w.message).join('\n')}`);
  }

  const json = buildSceneJson(state);
  downloadSceneJson(json, 'scene.json');
});

// ==========================================================================
// Undo / redo (Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z)
// ==========================================================================
//
// applySnapshot is the glue between history.js's plain-data snapshots and
// this app's live state: it OVERWRITES state.instances/camera/selection/
// nextId in place (rather than replacing `state` itself, since state is a
// `const` referenced by every closure above) and then calls
// resyncViewportFromState() to make the 3D view match - the exact same
// resync path project-loading uses, so undo/redo gets correct viewport
// behavior "for free" from that earlier fix rather than needing its own
// separate sync logic.
function applySnapshot(snapshot) {
  state.instances = snapshot.instances.map((inst) => ({
    id: inst.id,
    model: inst.model,
    palette: inst.palette,
    pos: { ...inst.pos },
    rot: { ...inst.rot },
    scale: { ...inst.scale },
  }));
  state.camera.pos = { ...snapshot.camera.pos };
  state.camera.rot = { ...snapshot.camera.rot };
  state.selectedInstanceId = snapshot.selectedInstanceId;
  state.nextId = snapshot.nextId;

  resyncViewportFromState();
  updateUI();
}

window.addEventListener('keydown', (event) => {
  const tag = document.activeElement && document.activeElement.tagName;
  // Don't hijack Ctrl+Z/Delete/Ctrl+D while editing a number field - e.g.
  // Backspace needs to delete a character in a focused input, not the
  // selected 3D instance, and Ctrl+Z inside a field should probably use
  // the browser's own native text-undo rather than the scene history.
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
  const isRedo =
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z') ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y');
  const isDuplicate = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd';
  const isDelete = event.key === 'Delete' || event.key === 'Backspace';
  const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';

  if (isSave) {
    event.preventDefault(); // browser default is "save page as..." - never useful here
    btnSaveProject.click(); // route through the button so save behavior stays in one place
    return;
  }

  // Single-key shortcuts below must not fire while freecam owns the
  // keyboard (viewer.js claims WASD etc. there).
  if (!viewer.isFreecamActive() && !event.ctrlKey && !event.metaKey) {
    if (event.key === '.') {
      // Frame selected (like Blender's View Selected / numpad-.)
      if (state.selectedInstanceId !== null) viewer.frameInstance(state.selectedInstanceId);
      return;
    }
    if (event.key === 'g' || event.key === 'G') {
      viewer.toggleGridVisible();
      return;
    }
  }

  if (isUndo) {
    event.preventDefault(); // stop the browser's own page-level undo/back-navigation muscle memory from firing too
    if (!canUndo()) return;
    undo(state, applySnapshot);
    markDirty();
  } else if (isRedo) {
    event.preventDefault();
    if (!canRedo()) return;
    redo(state, applySnapshot);
    markDirty();
  } else if (isDuplicate) {
    event.preventDefault(); // Ctrl+D is "bookmark this page" by default in most browsers - must be suppressed
    if (state.selectedInstanceId === null) return;
    duplicateInstance(state.selectedInstanceId);
  } else if (isDelete) {
    // Backspace's browser default is "navigate back" on some pages when
    // focus isn't in a text field - preventDefault() unconditionally here
    // (not just when an instance is actually selected) to make sure that
    // never fires while the user is working in the viewport.
    event.preventDefault();
    if (state.selectedInstanceId === null) return;
    deleteInstance(state.selectedInstanceId);
  }
});

// ==========================================================================
// Central re-render
// ==========================================================================

/**
 * Rewrite ONLY the numeric transform/camera/palette input fields from
 * state. Extracted from updateUI() so the continuous gizmo-drag path
 * (viewer.onTransformChange above) can refresh what the drag actually
 * changes without rebuilding the whole sidebar DOM per mouse-move.
 */
function refreshTransformFields() {
  const selected = state.selectedInstanceId !== null ? state.getInstance(state.selectedInstanceId) : null;
  if (selected) {
    instanceFieldsEl.classList.remove('hidden');
    fPosX.value = round3(selected.pos.x);
    fPosY.value = round3(selected.pos.y);
    fPosZ.value = round3(selected.pos.z);
    fRotX.value = round3(selected.rot.x);
    fRotY.value = round3(selected.rot.y);
    fRotZ.value = round3(selected.rot.z);
    fScaleX.value = round3(selected.scale.x);
    fScaleY.value = round3(selected.scale.y);
    fScaleZ.value = round3(selected.scale.z);
    fPalette.value = selected.palette;

    // Reflect the model's real CLUT row bound on the input itself (QOL):
    // max clamps the spinner arrows/validation to valid rows, while the
    // warning styling still flags values typed past it (max on a number
    // input doesn't block typing, so both remain useful).
    const maxPalette = state.getMaxPaletteForInstance(selected.id);
    fPalette.max = Math.max(0, maxPalette - 1);
    fPalette.classList.toggle('field-warning', selected.palette >= maxPalette);
  } else {
    instanceFieldsEl.classList.add('hidden');
  }

  camPosX.value = round3(state.camera.pos.x);
  camPosY.value = round3(state.camera.pos.y);
  camPosZ.value = round3(state.camera.pos.z);
  camRotX.value = round3(state.camera.rot.x);
  camRotY.value = round3(state.camera.rot.y);
  camRotZ.value = round3(state.camera.rot.z);
}

// ---- VRAM panel ----
const vramImageLabel = document.getElementById('vram-image-label');
const vramImageBar = document.getElementById('vram-image-bar');
const vramClutLabel = document.getElementById('vram-clut-label');
const vramClutBar = document.getElementById('vram-clut-bar');
const vramTotalLabel = document.getElementById('vram-total-label');
const vramWarningsEl = document.getElementById('vram-warnings');

// Hardcoded PS1 runtime limits, mirrored from main.c's #defines. These are
// hand-maintained (the web tool can't read main.c) - if main.c's values
// ever change, change them here too:
//   #define MAX_MODELS        16
//   #define MAX_SCENE_OBJECTS 32
//   #define MAX_TEXTURES      32
//   #define MAX_MODEL_TRIS    256
const MAINC_LIMITS = {
  models: 16,
  sceneObjects: 32,
  textures: 32,
  modelTris: 256,
};

const maincModelsLabel = document.getElementById('mainc-models-label');
const maincObjectsLabel = document.getElementById('mainc-objects-label');
const maincTexturesLabel = document.getElementById('mainc-textures-label');
const maincWarningsEl = document.getElementById('mainc-warnings');

/**
 * Refresh the MAIN.C limits readout: unique models used by placed
 * instances, total placed instances, and unique textures, each against
 * the runtime's hardcoded array sizes. Values at/over their limit turn
 * red - the PS1 loader clamps/rejects past these, so an over-budget
 * scene here IS a broken scene there.
 */
function renderMaincPanel(uniqueTextureCount) {
  // main.c's MAX_MODELS bounds its model table - count DISTINCT models
  // actually referenced by placed instances (what a scene load consumes),
  // not how many happen to be loaded in this editor session.
  const modelsUsed = new Set(state.instances.map((inst) => inst.model)).size;
  const objectsUsed = state.instances.length;

  maincModelsLabel.textContent = `${modelsUsed} / ${MAINC_LIMITS.models}`;
  maincModelsLabel.classList.toggle('limit-danger', modelsUsed > MAINC_LIMITS.models);

  maincObjectsLabel.textContent = `${objectsUsed} / ${MAINC_LIMITS.sceneObjects}`;
  maincObjectsLabel.classList.toggle('limit-danger', objectsUsed > MAINC_LIMITS.sceneObjects);

  maincTexturesLabel.textContent = `${uniqueTextureCount} / ${MAINC_LIMITS.textures}`;
  maincTexturesLabel.classList.toggle('limit-danger', uniqueTextureCount > MAINC_LIMITS.textures);

  const warnings = [];
  if (objectsUsed > MAINC_LIMITS.sceneObjects) {
    warnings.push(`Too many instances: main.c only loads ${MAINC_LIMITS.sceneObjects} scene objects.`);
  }
  if (modelsUsed > MAINC_LIMITS.models) {
    warnings.push(`Too many distinct models: main.c's model table holds ${MAINC_LIMITS.models}.`);
  }
  if (uniqueTextureCount > MAINC_LIMITS.textures) {
    warnings.push(`Too many textures: main.c's texture table holds ${MAINC_LIMITS.textures}.`);
  }
  // Per-model triangle budget (MAX_MODEL_TRIS) - checked against the tri
  // counts viewer.js computed at load time.
  for (const modelName of state.models.keys()) {
    const tris = viewer.getModelTriCount(modelName);
    if (tris !== null && tris > MAINC_LIMITS.modelTris) {
      warnings.push(`Model "${modelName}" has ${tris} tris - main.c's MAX_MODEL_TRIS is ${MAINC_LIMITS.modelTris}.`);
    }
  }

  maincWarningsEl.textContent = warnings.join(' ');
  maincWarningsEl.classList.toggle('hidden', warnings.length === 0);
}

/**
 * Refresh the VRAM budget panel from the currently-loaded models'
 * decoded textures. Cheap (a few dozen map entries + arithmetic), so
 * it just runs as part of every updateUI() - texture set only actually
 * changes when a model loads, but recomputing is far simpler than
 * tracking dirtiness for something this small.
 */
function renderVramPanel() {
  const usage = computeVramUsage(state.models);

  const imagePct = Math.min(100, (usage.imageBytesUsed / usage.imageBytesMax) * 100);
  const clutPct = Math.min(100, (usage.clutRowsUsed / usage.clutRowsMax) * 100);

  vramImageLabel.textContent =
    `${formatBytes(usage.imageBytesUsed)} / ${formatBytes(usage.imageBytesMax)} (${usage.textures.length} tex)`;
  vramImageBar.style.width = `${imagePct}%`;
  vramImageBar.classList.toggle('vram-bar-danger', usage.imageBytesUsed > usage.imageBytesMax * 0.9);

  vramClutLabel.textContent = `${usage.clutRowsUsed} / ${usage.clutRowsMax} rows (${formatBytes(usage.clutBytesUsed)})`;
  vramClutBar.style.width = `${clutPct}%`;
  vramClutBar.classList.toggle('vram-bar-danger', usage.clutRowsUsed > usage.clutRowsMax * 0.9);

  vramTotalLabel.textContent = `${formatBytes(usage.totalBytesUsed)} / ${formatBytes(usage.totalBytesMax)}`;

  vramWarningsEl.textContent = usage.warnings.join(' ');
  vramWarningsEl.classList.toggle('hidden', usage.warnings.length === 0);

  // The MAIN.C limits readout shares this panel and needs the unique
  // texture count the VRAM computation already derived.
  renderMaincPanel(usage.textures.length);
}

function updateUI() {
  renderVramPanel();

  // Export button enabled only when at least one model is loaded AND at
  // least one instance has been placed - an empty scene.json with zero
  // objects is technically valid JSON but not a useful export target, so
  // we gate on there being something to actually export.
  btnExportScene.disabled = !(state.models.size > 0 && state.instances.length > 0);

  btnAddInstance.disabled = !activeModelName;

  if (window.__sceneGenDiscoveredModels) {
    renderModelList(window.__sceneGenDiscoveredModels);
  }

  renderInstanceList();

  refreshTransformFields();

  for (const [mode, btn] of Object.entries(modeButtons)) {
    btn.classList.toggle('is-active', mode === currentTransformMode);
  }
}

// ==========================================================================
// Drag-to-scrub numeric fields (Blender-style click-to-type/drag-to-nudge)
// ==========================================================================
//
// Position/scale fields use the default sensitivity (tuned for small
// decimal nudges - these are viewport/Blender-space units, typically
// single digits). Rotation fields get a coarser sensitivity since
// degrees are usually dragged in bigger jumps and their step is already
// 1 (whole degrees) rather than 0.1.
const POSITION_SENSITIVITY = 0.05;
const ROTATION_SENSITIVITY = 0.15;

[fPosX, fPosY, fPosZ, fScaleX, fScaleY, fScaleZ, camPosX, camPosY, camPosZ].forEach((el) =>
  makeScrubbable(el, { sensitivity: POSITION_SENSITIVITY })
);
// NOTE: fPalette is deliberately NOT scrubbable. It's a small integer row
// index (typically 0-15) - drag-scrubbing it proved too finicky to land
// on a specific row, and typing/spinner arrows (now clamped via the max
// attribute, see refreshTransformFields) fit an index better anyway.
[fRotX, fRotY, fRotZ, camRotX, camRotY, camRotZ].forEach((el) =>
  makeScrubbable(el, { sensitivity: ROTATION_SENSITIVITY })
);

// ==========================================================================
// Startup
// ==========================================================================

// Freecam on-screen indicator (QOL): shows which input mode owns the
// keyboard/mouse, since pointer-lock freecam is otherwise invisible state.
const freecamIndicatorEl = document.getElementById('freecam-indicator');
viewer.onFreecamChange(({ active, walk }) => {
  freecamIndicatorEl.classList.toggle('hidden', !active);
  if (active) {
    freecamIndicatorEl.textContent = walk ? 'FREECAM — WALK (Space: fly, Esc: exit)' : 'FREECAM (Space: walk, Esc: exit)';
  }
});

viewer.initViewer(canvasEl, gizmoCanvasEl);
updateUI();
