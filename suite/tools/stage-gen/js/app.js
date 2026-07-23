/*
 * app.js
 *
 * Entry point / controller. Wires DOM events to stage_state.js mutations
 * and viewer.js viewport calls, and re-renders the whole sidebar from a
 * single central updateUI() function after every mutation (mirrors
 * palette-maker's app.js "one central re-render" pattern).
 *
 * MODULE STRATEGY DEVIATION FROM PALETTE-MAKER:
 * palette-maker's non-module files use the IIFE + `window.PaletteGen`
 * global-namespace pattern, loaded via plain <script> tags in a fixed
 * order. stage-gen deviates from that here: every JS file (including
 * viewer.js and app.js) is a proper ES module using `export`, and
 * index.html loads ONLY this file via <script type="module" src="js/app.js">.
 * This is necessary because the Three.js addons (GLTFLoader, OrbitControls,
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
import { resolveMaterialsByNames } from './mtl_resolver.js';
import {
  StageState,
  ENTITY_KINDS,
  FOG_DEFAULTS,
  FOG_LIMITS,
  clampFogViewportRange,
  normalizeAnim,
} from './stage_state.js';
import { buildStageJson, downloadStageJson } from './stage_export.js';
import { buildProjectJson, downloadProjectFile, loadProjectFile } from './stage_project.js';
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

const btnNewFolder = document.getElementById('btn-new-folder');
const btnInsertEntity = document.getElementById('btn-insert-entity');
const insertEntityMenuEl = document.getElementById('insert-entity-menu');
const instanceListEl = document.getElementById('instance-list');
const instanceFieldsEl = document.getElementById('instance-fields');
const propsNoSelectionEl = document.getElementById('props-no-selection');
const propsTargetLabelEl = document.getElementById('props-target-label');
const appearanceSectionEl = document.getElementById('appearance-section');
const collisionSectionEl = document.getElementById('collision-section');
const animationSectionEl = document.getElementById('animation-section');
const entityPropsSectionEl = document.getElementById('entity-props-section');
const entityPropsTitleEl = document.getElementById('entity-props-title');
const entityPropsBodyEl = document.getElementById('entity-props-body');

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
const fCollide = document.getElementById('f-collide');
const fAnimDefault = document.getElementById('f-anim-default');
const fAnimLoop = document.getElementById('f-anim-loop');
const fAnimSpeed = document.getElementById('f-anim-speed');
const fAnimAutoplay = document.getElementById('f-anim-autoplay');
const animHintEl = document.getElementById('anim-hint');

const colliderFieldsEl = document.getElementById('collider-fields');
const colliderTargetLabelEl = document.getElementById('collider-target-label');
const cCenterX = document.getElementById('c-center-x');
const cCenterY = document.getElementById('c-center-y');
const cCenterZ = document.getElementById('c-center-z');
const cSizeX = document.getElementById('c-size-x');
const cSizeY = document.getElementById('c-size-y');
const cSizeZ = document.getElementById('c-size-z');
const cEnabled = document.getElementById('c-enabled');
const cIdHint = document.getElementById('c-id-hint');

const camPosX = document.getElementById('cam-pos-x');
const camPosY = document.getElementById('cam-pos-y');
const camPosZ = document.getElementById('cam-pos-z');
const camRotX = document.getElementById('cam-rot-x');
const camRotY = document.getElementById('cam-rot-y');
const camRotZ = document.getElementById('cam-rot-z');

const fogEnabled = document.getElementById('fog-enabled');
const fogNear = document.getElementById('fog-near');
const fogFar = document.getElementById('fog-far');
const fogColor = document.getElementById('fog-color');
const fogLayers = document.getElementById('fog-layers');
const fogCull = document.getElementById('fog-cull');
const fogDrift = document.getElementById('fog-drift');
const fogRangeHint = document.getElementById('fog-range-hint');

const modeButtons = {
  translate: document.getElementById('mode-translate'),
  rotate: document.getElementById('mode-rotate'),
  scale: document.getElementById('mode-scale'),
};

const btnLoadProject = document.getElementById('btn-load-project');
const btnSaveProject = document.getElementById('btn-save-project');
const btnExportStage = document.getElementById('btn-export-stage');
const fileLoadProject = document.getElementById('file-load-project');

// ---- app state ----
const state = new StageState();
let activeModelName = null; // the Assets-list model currently highlighted (loaded/previewed)
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
 * Make the VIEWPORT (Three.js stage) match state.instances, INCREMENTALLY:
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
  // Purge any tracked viewport object that the new state no longer wants -
  // either the id is gone entirely, OR the id has been REUSED for a
  // different model/kind (project load renumbers from scratch, so stage B's
  // instance #3 can collide with stage A's #3 while being a different
  // model). Comparing identity, not just presence, stops the old mesh from
  // surviving under the reused id and leaking into the loaded stage.
  const trackedMeta = viewer.getTrackedInstanceMeta();
  const desiredInstModel = new Map(state.instances.map((inst) => [inst.id, inst.model]));
  const desiredEntKind = new Map(state.entities.map((ent) => [ent.id, ent.kind]));

  for (const trackedId of viewer.getTrackedInstanceIds()) {
    const meta = trackedMeta.get(trackedId);
    const stillValid = meta.isEntity
      ? desiredEntKind.get(trackedId) === meta.kind
      : desiredInstModel.get(trackedId) === meta.modelName;
    if (!stillValid) {
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

  // Same add-if-missing/update-if-present diff for editor entities -
  // they render unconditionally (no model dependency to wait on).
  const trackedAfterInstances = new Set(viewer.getTrackedInstanceIds());
  for (const ent of state.entities) {
    if (trackedAfterInstances.has(ent.id)) {
      viewer.setInstanceTransform(ent.id, { pos: ent.pos, rot: ent.rot, scale: ent.scale });
      viewer.updateEntityProps(ent.id, ent.props);
    } else {
      viewer.addEntityHelper(ent.id, ent.kind, ent, ent.props);
    }
  }

  viewer.setCameraTransform(state.camera);

  // Fog rides the same resync path as the camera, so project load and
  // undo/redo both restore the viewport preview for free - the two callers
  // that replace `state.fog` wholesale rather than field-by-field.
  pushFogToViewer();

  if (
    state.selectedInstanceId !== null &&
    (state.getInstance(state.selectedInstanceId) || state.getEntity(state.selectedInstanceId))
  ) {
    viewer.selectInstance(state.selectedInstanceId);
  } else if (state.selectedInstanceId !== null && state.getCollider(state.selectedInstanceId)) {
    // A selected collision box keeps its gizmo across undo/redo and project
    // load. Deliberately NOT falling through to selectInstance(null): that
    // detaches, and the overlay rebuild immediately after would re-attach -
    // a visible flicker of the handles on every undo step.
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
    showWarning('No valid models found. Each model needs a subfolder containing a matching <name>.glb (or <name>.gltf).');
    return;
  }

  // Store the discovered handles for on-demand loading when the user
  // clicks a model in the list (avoids loading every model's .glb +
  // .tim data up front, which could be slow for a large assets folder).
  window.__stageGenDiscoveredModels = found;

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
// level deep - not safe for this tool's two-level assets/object/<model>/textures/
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
 * Read one model's .glb + resolve its .tim textures, and register it into
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

  let glbBuffer;
  try {
    glbBuffer = await (await modelEntry.glbHandle.getFile()).arrayBuffer();
  } catch (err) {
    showError(`Failed to read model "${modelEntry.name}": ${err.message}`);
    return false;
  }

  // The viewer parses the .glb, then calls back with the material names it
  // found so we can resolve textures/<name>.tim against THIS model's folder.
  // It returns the resolved map, which we store for per-instance palette rows.
  let materialsMap;
  try {
    materialsMap = await viewer.loadModelIntoStage(
      modelEntry.name,
      glbBuffer,
      (names) => resolveMaterialsByNames(modelEntry.dirHandle, names)
    );
  } catch (err) {
    showError(`Failed to load model "${modelEntry.name}": ${err.message}`);
    return false;
  }

  state.addModel(modelEntry.name, {
    materialsMap,
    dirHandle: modelEntry.dirHandle,
  });

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

// Name of the asset being dragged from the Assets list toward the
// viewport, or null. Deliberately separate from the instance tree's
// dragPayload - the two drag flows (organize existing rows vs. spawn a
// new instance) must never confuse each other's drop targets.
let assetDragName = null;

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

    li.addEventListener('click', () => {
      // Already the active, loaded model: skip the re-render. Same
      // rebuild-vs-dblclick reasoning as the instance tree rows - the
      // second click of a double-click must land on THIS li, not a
      // freshly rebuilt copy of it.
      if (entry.name === activeModelName && state.models.has(entry.name)) return;
      selectModel(entry);
    });

    // Double-click: spawn an instance at the center of the current view
    // (at a safe distance - see viewer.placeInstanceAtViewCenter).
    li.addEventListener('dblclick', () => {
      spawnInstanceFromAsset(entry.name, (id) => viewer.placeInstanceAtViewCenter(id));
    });

    // Drag toward the viewport: the drop handler on the canvas places
    // the new instance at the cursor's surface point.
    li.draggable = true;
    li.addEventListener('dragstart', (evt) => {
      assetDragName = entry.name;
      evt.dataTransfer.effectAllowed = 'copy';
      evt.dataTransfer.setData('text/plain', `asset:${entry.name}`); // Firefox needs non-empty data
    });
    li.addEventListener('dragend', () => {
      assetDragName = null;
      viewportMainEl.classList.remove('is-drop-target');
    });

    modelListEl.appendChild(li);
  }
}

/**
 * Shared spawn path for both asset-placement gestures (drag-drop onto
 * the viewport, double-click in the Assets list) - replaces the old
 * "Add Instance" button. Loads the model on demand if it isn't yet
 * (so either gesture works straight off a fresh folder scan), creates
 * the instance inside the selected folder (if any), lets the supplied
 * `place` callback position it in the viewport, then copies the placed
 * transform back into state and selects the new instance.
 */
async function spawnInstanceFromAsset(modelName, place) {
  const discovered = window.__stageGenDiscoveredModels || [];
  const entry = discovered.find((d) => d.name === modelName);
  if (!entry) return;

  if (!(await loadModelData(entry))) return;
  if (!state.models.has(modelName)) return;

  pushHistory(state);
  markDirty();

  const parentFolder = state.selectedFolderId !== null ? state.getFolder(state.selectedFolderId) : null;
  if (parentFolder) parentFolder.collapsed = false;
  const instance = state.addInstance(modelName, {}, parentFolder ? parentFolder.id : null);

  const modelData = state.models.get(modelName);
  viewer.addInstance(instance.id, modelName, instance, modelData.materialsMap);

  const placedTransform = place(instance.id);
  if (placedTransform) {
    instance.pos = round3Axes(placedTransform.pos);
  }

  state.selectedInstanceId = instance.id;
  state.selectedFolderId = null;
  viewer.selectInstance(instance.id);
  updateUI();
}

// Viewport drop target: dragging an asset over the 3D view highlights it,
// releasing spawns the instance at the cursor's surface point (same
// placement rules as the translate gizmo's center-square surface drag).
const viewportMainEl = document.querySelector('.main');

viewportMainEl.addEventListener('dragover', (evt) => {
  if (!assetDragName) return; // instance-tree drags etc. are not viewport drops
  evt.preventDefault();
  evt.dataTransfer.dropEffect = 'copy';
  viewportMainEl.classList.add('is-drop-target');
});
viewportMainEl.addEventListener('dragleave', () => {
  viewportMainEl.classList.remove('is-drop-target');
});
viewportMainEl.addEventListener('drop', (evt) => {
  if (!assetDragName) return;
  evt.preventDefault();
  viewportMainEl.classList.remove('is-drop-target');

  const modelName = assetDragName;
  assetDragName = null;
  // Client coords captured NOW - the spawn path awaits model loading, and
  // the event object's fields aren't reliable after an await.
  const { clientX, clientY } = evt;
  spawnInstanceFromAsset(modelName, (id) => {
    const t = viewer.placeInstanceAtScreenPoint(id, clientX, clientY);
    // Cursor aimed at sky/void (possible when dropping high above the
    // horizon): fall back to the view-center placement rather than
    // leaving the new instance at the world origin.
    return t || viewer.placeInstanceAtViewCenter(id);
  });
});

// ==========================================================================
// Instances panel
// ==========================================================================

/** Display label for an instance row/properties header: the custom
 * rename if one was set, otherwise the classic "model #id" default. */
function instanceDisplayName(inst) {
  return inst.name || `${inst.model} #${inst.id}`;
}

/** Same for editor entities: rename override, else "Kind #id". */
function entityDisplayName(ent) {
  const def = ENTITY_KINDS[ent.kind];
  return ent.name || `${def ? def.label : ent.kind} #${ent.id}`;
}

btnNewFolder.addEventListener('click', () => {
  pushHistory(state);
  markDirty();
  // Nest inside the selected folder if there is one, else at root.
  const parentFolder = state.selectedFolderId !== null ? state.getFolder(state.selectedFolderId) : null;
  if (parentFolder) parentFolder.collapsed = false;
  const folder = state.addFolder(parentFolder ? parentFolder.id : null);
  state.selectedFolderId = folder.id;
  state.selectedInstanceId = null;
  viewer.selectInstance(null);
  updateUI();
});

// ==========================================================================
// Insert-object menu (editor entities: Trigger / Spawn / Summon / ...)
// ==========================================================================

// Build the menu once from the ENTITY_KINDS registry - one row per kind
// with its tree-dot color and hint line, so adding a future kind to the
// registry automatically surfaces it here.
for (const [kind, def] of Object.entries(ENTITY_KINDS)) {
  const item = document.createElement('button');
  item.className = 'insert-menu-item';

  const dot = document.createElement('span');
  dot.className = 'entity-dot';
  dot.style.color = def.color;
  dot.textContent = '●';
  item.appendChild(dot);

  const textWrap = document.createElement('span');
  textWrap.className = 'insert-menu-text';
  const title = document.createElement('span');
  title.className = 'insert-menu-label';
  title.textContent = def.label;
  const hint = document.createElement('span');
  hint.className = 'insert-menu-hint';
  hint.textContent = def.hint;
  textWrap.appendChild(title);
  textWrap.appendChild(hint);
  item.appendChild(textWrap);

  item.addEventListener('click', () => {
    closeInsertMenu();
    insertEntity(kind);
  });
  insertEntityMenuEl.appendChild(item);
}

function closeInsertMenu() {
  insertEntityMenuEl.classList.add('hidden');
  btnInsertEntity.classList.remove('is-active');
}

btnInsertEntity.addEventListener('click', (evt) => {
  evt.stopPropagation(); // keep the document-level close handler from instantly re-hiding it
  const opening = insertEntityMenuEl.classList.contains('hidden');
  insertEntityMenuEl.classList.toggle('hidden', !opening);
  btnInsertEntity.classList.toggle('is-active', opening);
});

document.addEventListener('click', (evt) => {
  if (insertEntityMenuEl.classList.contains('hidden')) return;
  if (insertEntityMenuEl.contains(evt.target)) return;
  closeInsertMenu();
});

/**
 * Create an editor entity of `kind`: same flow as spawning a model
 * instance - into the selected folder, placed at the center of the
 * current view at a safe distance (the entity helper participates in
 * the shared placement code), selected, undoable.
 */
function insertEntity(kind) {
  pushHistory(state);
  markDirty();

  const parentFolder = state.selectedFolderId !== null ? state.getFolder(state.selectedFolderId) : null;
  if (parentFolder) parentFolder.collapsed = false;
  const entity = state.addEntity(kind, parentFolder ? parentFolder.id : null);
  if (!entity) return;

  viewer.addEntityHelper(entity.id, kind, entity, entity.props);
  const placedTransform = viewer.placeInstanceAtViewCenter(entity.id);
  if (placedTransform) {
    entity.pos = round3Axes(placedTransform.pos);
  }

  state.selectedInstanceId = entity.id;
  state.selectedFolderId = null;
  viewer.selectInstance(entity.id);
  updateUI();
}

/**
 * Delete an editor entity (Del key while one is selected) - confirmed
 * like instance deletion, and undoable.
 */
async function deleteEntity(id) {
  const entity = state.getEntity(id);
  if (!entity) return;

  const ok = await showConfirm({
    title: 'Delete object',
    message: `Delete "${entityDisplayName(entity)}"?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
  });
  if (!ok) return;
  if (!state.getEntity(id)) return; // vanished while dialog was open

  pushHistory(state);
  markDirty();
  state.removeEntity(id);
  viewer.removeInstance(id);
  updateUI();
}

/** Ctrl+D for entities: clone (fresh unique spawn ID where applicable),
 * select the copy. */
function duplicateEntity(id) {
  const original = state.getEntity(id);
  if (!original) return;

  pushHistory(state);
  markDirty();
  const clone = state.duplicateEntity(id);
  viewer.addEntityHelper(clone.id, clone.kind, clone, clone.props);
  state.selectedInstanceId = clone.id;
  state.selectedFolderId = null;
  viewer.selectInstance(clone.id);
  updateUI();
}

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
  state.selectedFolderId = null;
  viewer.selectInstance(clone.id);
  updateUI();
}

// Copy/paste clipboard. The in-memory buffer is the source of truth: it
// always works, including in Firefox, where web pages can't READ the system
// clipboard (navigator.clipboard.readText is unavailable to page scripts).
// On copy we ALSO best-effort WRITE the payload to the system clipboard
// (that IS allowed in Firefox on a user gesture), so a paste in another tab
// - or any browser that does grant readText - can pick it up too.
let internalClipboard = null;
const CLIPBOARD_TAG = '__stagegen_node__';

/**
 * Ctrl+C: serialize the selected instance/entity into the clipboard.
 * No-op when nothing (or a folder) is selected. Mirrors Ctrl+D's "operate
 * on the current selection" contract.
 */
async function copySelection() {
  if (state.selectedInstanceId === null) return;
  const data = state.serializeNode(state.selectedInstanceId);
  if (!data) return;

  internalClipboard = data;
  try {
    // Best-effort only - a rejection (permissions, no gesture, etc.) leaves
    // internalClipboard as the working copy, so paste still functions.
    await navigator.clipboard.writeText(JSON.stringify({ [CLIPBOARD_TAG]: 1, data }));
  } catch (_) {
    /* system clipboard unavailable - internal buffer covers paste */
  }
  showInfo('Copied.');
}

/**
 * Ctrl+V: paste whatever's on the clipboard as a new node, selected. Tries
 * the system clipboard first (so a copy from another tab pastes here where
 * the browser allows reads), then falls back to the in-memory buffer -
 * which is the path Firefox always takes.
 */
async function pasteSelection() {
  let data = null;
  try {
    const text = await navigator.clipboard.readText();
    const parsed = JSON.parse(text);
    if (parsed && parsed[CLIPBOARD_TAG] && parsed.data) data = parsed.data;
  } catch (_) {
    /* no system read (Firefox / no permission) - use the internal buffer */
  }
  if (!data) data = internalClipboard;
  if (!data) return;

  // Paste into the selected folder if one is active, otherwise the tree
  // root - the same target New-asset placement uses.
  const parentId = state.selectedFolderId ?? null;

  pushHistory(state);
  markDirty();
  const created = state.createNodeFromData(data, parentId);
  if (!created) return;

  const { node, type } = created;
  if (type === 'instance') {
    const modelData = state.models.get(node.model);
    if (modelData) {
      viewer.addInstance(node.id, node.model, node, modelData.materialsMap);
      viewer.updateInstancePaletteRow(node.id, node.palette);
    } else {
      // Model isn't loaded this session (e.g. pasted from another tab before
      // its assets folder was opened) - it lives in state and the tree now,
      // and resyncViewportFromState() will spawn it once the model loads.
      showInfo(`Pasted "${node.model}" - open its assets folder to see it in 3D.`);
    }
  } else {
    viewer.addEntityHelper(node.id, node.kind, node, node.props);
  }

  state.selectedInstanceId = node.id;
  state.selectedFolderId = null;
  viewer.selectInstance(node.id);
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
    message: `Delete "${instanceDisplayName(instance)}"?`,
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

/**
 * Delete a folder and its ENTIRE contents (subfolders + instances),
 * after a confirm dialog that spells out how many instances that is.
 * Triggered by the Delete key while a folder row is selected - like
 * instances, there is no per-row delete button anymore.
 */
async function deleteFolder(id) {
  const folder = state.getFolder(id);
  if (!folder) return;

  const count = state.getFolderContentsCount(id);
  const ok = await showConfirm({
    title: 'Delete folder',
    message: count > 0
      ? `Delete folder "${folder.name}" and the ${count} object${count === 1 ? '' : 's'} inside it?`
      : `Delete folder "${folder.name}"?`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
  });
  if (!ok) return;
  if (!state.getFolder(id)) return; // vanished while dialog was open

  pushHistory(state);
  markDirty();
  const removedInstanceIds = state.removeFolder(id);
  for (const removedId of removedInstanceIds) {
    viewer.removeInstance(removedId);
  }
  updateUI();
}

// --------------------------------------------------------------------
// Instance tree rendering (folders + instances)
// --------------------------------------------------------------------
//
// The old flat list (with per-row Dup/Del buttons) is now a tree:
// folder rows carry a collapse chevron and hide their whole subtree
// when collapsed; instance rows indent under their folder. Dup/Del
// buttons are gone - Ctrl+D and Delete operate on the selected row
// instead, which keeps rows to just a name and reads far cleaner.

// { kind: 'instance' | 'folder', id } while a row drag is in flight;
// null otherwise. Module-scoped (rather than dataTransfer-only) because
// dragover handlers need to inspect the payload to decide drop validity,
// and dataTransfer.getData() is unreadable during dragover by spec.
let dragPayload = null;

function clearDropHighlights() {
  for (const el of instanceListEl.querySelectorAll('.drop-target')) {
    el.classList.remove('drop-target');
  }
}

function currentParentOf(payload) {
  if (payload.kind === 'instance') {
    // 'instance' payloads cover model instances AND editor entities -
    // both live in the same tree with the same parenting rules.
    const node = state.getInstance(payload.id) || state.getEntity(payload.id);
    return node ? node.parentId : null;
  }
  const folder = state.getFolder(payload.id);
  return folder ? folder.parentId : null;
}

/** Would dropping the in-flight payload into `parentId` (null = root) be
 * a legal, non-no-op move? Blocks folder-into-own-subtree cycles. */
function canDropInto(parentId) {
  if (!dragPayload) return false;
  if (dragPayload.kind === 'folder' && parentId !== null) {
    if (state.isFolderInside(parentId, dragPayload.id)) return false; // includes parentId === dragged folder itself
  }
  return currentParentOf(dragPayload) !== parentId;
}

function dropInto(parentId) {
  if (!canDropInto(parentId)) {
    dragPayload = null;
    clearDropHighlights();
    return;
  }
  const payload = dragPayload;
  dragPayload = null;

  pushHistory(state);
  markDirty();
  if (payload.kind === 'instance') {
    const node = state.getInstance(payload.id) || state.getEntity(payload.id);
    if (node) node.parentId = parentId;
  } else {
    state.getFolder(payload.id).parentId = parentId;
  }
  // Expand the receiving folder so the moved row is immediately visible -
  // dropping into a collapsed folder that swallows the row invisibly
  // reads as the drop having failed.
  if (parentId !== null) state.getFolder(parentId).collapsed = false;
  updateUI();
}

function makeRowDraggable(li, kind, id) {
  li.draggable = true;
  li.addEventListener('dragstart', (evt) => {
    dragPayload = { kind, id };
    evt.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag with an empty dataTransfer; the
    // string itself is never read back (see dragPayload's comment).
    evt.dataTransfer.setData('text/plain', `${kind}:${id}`);
  });
  li.addEventListener('dragend', () => {
    dragPayload = null;
    clearDropHighlights();
  });
}

/**
 * Swap a row's name span for an inline text input (double-click rename).
 * `commit` receives the trimmed value on Enter/blur and applies it (or
 * declines a no-op); Escape cancels. Either way the tree re-renders,
 * which also restores the span - no manual DOM cleanup needed.
 */
function startRename(nameSpan, initialValue, commit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = initialValue;
  // Suspend row dragging for the duration of the rename: click-dragging
  // to select text inside the input would otherwise start an HTML5 drag
  // of the whole row (the li is draggable). The rebuild after finish()
  // restores a fresh draggable row.
  const row = nameSpan.closest('li');
  if (row) row.draggable = false;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false; // guards the blur that fires when updateUI() removes the input mid-finish
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (apply) commit(input.value.trim());
    updateUI();
  };

  input.addEventListener('keydown', (evt) => {
    // The window-level shortcut handler ignores INPUT focus already, but
    // stopping propagation here also keeps Delete/Backspace/Ctrl+D from
    // even reaching it while a rename is being typed.
    evt.stopPropagation();
    if (evt.key === 'Enter') finish(true);
    else if (evt.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (evt) => evt.stopPropagation());
  input.addEventListener('dblclick', (evt) => evt.stopPropagation());
}

// Collider rows use the same cool blue as the viewport wireframes
// (viewer.js's COLLIDER_OVERLAY_COLOR) so a row and its box read as the same
// object. Deliberately outside ENTITY_KINDS' palette - a collision box is not
// an entity kind, it is a child of an instance.
const COLLIDER_ROW_COLOR = '#4a9eda';

const TREE_INDENT_PX = 16; // per-depth left padding
const TREE_ROW_BASE_PX = 8; // matches .item-list li's own horizontal padding

function buildFolderRow(folder, depth) {
  const li = document.createElement('li');
  li.className = 'tree-folder' + (folder.id === state.selectedFolderId ? ' is-selected' : '');
  li.style.paddingLeft = `${TREE_ROW_BASE_PX + depth * TREE_INDENT_PX}px`;

  const chevron = document.createElement('button');
  chevron.className = 'tree-chevron';
  chevron.textContent = folder.collapsed ? '▸' : '▾'; // ▸ / ▾
  chevron.title = folder.collapsed ? 'Expand' : 'Collapse';
  chevron.addEventListener('click', (evt) => {
    evt.stopPropagation(); // collapse toggle must not also select the folder
    folder.collapsed = !folder.collapsed; // view preference - deliberately NOT pushed to undo history
    updateUI();
  });
  li.appendChild(chevron);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'item-name tree-folder-name';
  nameSpan.textContent = folder.name;
  li.appendChild(nameSpan);

  // Recursive contents count (instances + entities) so a collapsed
  // folder still communicates how much it's hiding.
  const count = state.getFolderContentsCount(folder.id);
  const countSpan = document.createElement('span');
  countSpan.className = 'tree-count';
  countSpan.textContent = String(count);
  li.appendChild(countSpan);

  li.addEventListener('click', () => {
    // Skip the rebuild when already selected - beyond being wasted work,
    // a rebuild between the two clicks of a double-click would replace
    // this li and could swallow the dblclick rename trigger.
    if (state.selectedFolderId === folder.id) return;
    state.selectedFolderId = folder.id;
    state.selectedInstanceId = null;
    viewer.selectInstance(null);
    updateUI();
  });

  li.addEventListener('dblclick', (evt) => {
    if (evt.target === chevron) return;
    startRename(nameSpan, folder.name, (value) => {
      if (value.length === 0 || value === folder.name) return;
      pushHistory(state);
      markDirty();
      folder.name = value;
    });
  });

  makeRowDraggable(li, 'folder', folder.id);

  // Folder rows are drop targets: dropping a row here re-parents it into
  // this folder.
  li.addEventListener('dragover', (evt) => {
    if (!canDropInto(folder.id)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = 'move';
    li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (evt) => {
    evt.preventDefault();
    evt.stopPropagation(); // don't let the page-level root-drop handler also fire
    li.classList.remove('drop-target');
    dropInto(folder.id);
  });

  return li;
}

function buildInstanceRow(inst, depth) {
  const li = document.createElement('li');
  li.className = 'tree-instance' + (inst.id === state.selectedInstanceId ? ' is-selected' : '');
  // Extra indent past the folder rows' chevron column so instance names
  // line up with their parent folder's NAME rather than its chevron.
  li.style.paddingLeft = `${TREE_ROW_BASE_PX + depth * TREE_INDENT_PX + 18}px`;

  // Leading type icon, Roblox-Studio style: <icon> <space> <name>, so every
  // instance row opens with a fixed-width glyph and the names line up. A model
  // whose .glb carries animation clips gets the red "animated" marker; every
  // other model gets a neutral generic square. (Entities have their own
  // colored dot in buildEntityRow.)
  const icon = document.createElement('span');
  icon.className = 'instance-icon';
  if (viewer.hasAnimations(inst.model)) {
    icon.classList.add('anim-marker');
    icon.textContent = '▶';
    icon.title = 'Animated model (has animation clips)';
  } else {
    icon.textContent = '■';
    icon.title = 'Model instance';
  }
  li.appendChild(icon);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'item-name';
  nameSpan.textContent = instanceDisplayName(inst);
  nameSpan.title = `${inst.model} #${inst.id}`; // real identity stays discoverable under a rename
  li.appendChild(nameSpan);

  li.addEventListener('click', () => {
    if (state.selectedInstanceId === inst.id) return; // see buildFolderRow's comment
    state.selectedInstanceId = inst.id;
    state.selectedFolderId = null;
    viewer.selectInstance(inst.id);
    updateUI();
  });

  li.addEventListener('dblclick', () => {
    // Prefill with the current DISPLAY name so renaming feels like
    // editing what's on screen; committing it unchanged (or clearing it)
    // stores null, i.e. "no custom name", rather than freezing the
    // default label as a real name.
    startRename(nameSpan, instanceDisplayName(inst), (value) => {
      const newName = value.length === 0 || value === `${inst.model} #${inst.id}` ? null : value;
      if (newName === inst.name) return;
      pushHistory(state);
      markDirty();
      inst.name = newName;
    });
  });

  makeRowDraggable(li, 'instance', inst.id);

  // Dropping onto an instance row means "put it next to this one" -
  // adopt the row's parent. Makes deep-folder drops easier than hitting
  // the folder row itself.
  li.addEventListener('dragover', (evt) => {
    if (dragPayload && dragPayload.kind === 'instance' && dragPayload.id === inst.id) return;
    if (!canDropInto(inst.parentId)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = 'move';
  });
  li.addEventListener('drop', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dropInto(inst.parentId);
  });

  return li;
}

/**
 * Row for an editor entity (trigger/spawn/...): like an instance row
 * but with the kind's colored dot in front of the name, so the special
 * objects read apart from model instances at a glance.
 */
function buildEntityRow(ent, depth) {
  const def = ENTITY_KINDS[ent.kind];
  const li = document.createElement('li');
  li.className = 'tree-instance tree-entity' + (ent.id === state.selectedInstanceId ? ' is-selected' : '');
  li.style.paddingLeft = `${TREE_ROW_BASE_PX + depth * TREE_INDENT_PX + 18}px`;

  const dot = document.createElement('span');
  dot.className = 'entity-dot';
  dot.style.color = def ? def.color : 'inherit';
  dot.textContent = '●';
  li.appendChild(dot);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'item-name';
  nameSpan.textContent = entityDisplayName(ent);
  nameSpan.title = `${def ? def.label : ent.kind} #${ent.id}`;
  li.appendChild(nameSpan);

  li.addEventListener('click', () => {
    if (state.selectedInstanceId === ent.id) return; // see buildFolderRow's comment
    state.selectedInstanceId = ent.id;
    state.selectedFolderId = null;
    viewer.selectInstance(ent.id);
    updateUI();
  });

  li.addEventListener('dblclick', () => {
    startRename(nameSpan, entityDisplayName(ent), (value) => {
      const defaultLabel = `${def ? def.label : ent.kind} #${ent.id}`;
      const newName = value.length === 0 || value === defaultLabel ? null : value;
      if (newName === ent.name) return;
      pushHistory(state);
      markDirty();
      ent.name = newName;
    });
  });

  makeRowDraggable(li, 'instance', ent.id); // shares the instance payload kind - same tree rules

  li.addEventListener('dragover', (evt) => {
    if (dragPayload && dragPayload.kind === 'instance' && dragPayload.id === ent.id) return;
    if (!canDropInto(ent.parentId)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = 'move';
  });
  li.addEventListener('drop', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dropInto(ent.parentId);
  });

  return li;
}

/** Display label for a collider row: its mesh-derived name, or a fallback. */
function colliderDisplayName(col) {
  return col.name || `Box #${col.id}`;
}

/**
 * Row for a collision box, nested under the instance that owns it.
 *
 * NOT DRAGGABLE, unlike every other row type. A collider's parent is not a
 * tree-organisation choice like a folder is - it is the local space the box's
 * center and size are expressed in. Dragging one onto a different instance
 * would silently reinterpret its numbers against a different origin and
 * rotation, teleporting it. Re-parenting a box means deleting it and adding
 * one where you want it.
 *
 * A disabled box still draws its row (struck through) rather than
 * disappearing: `enabled` is the INITIAL runtime state and a trigger can flip
 * it, so an off box is authored data, not an absence.
 */
function buildColliderRow(col, depth) {
  const li = document.createElement('li');
  li.className = 'tree-instance tree-collider' + (col.id === state.selectedInstanceId ? ' is-selected' : '');
  li.style.paddingLeft = `${TREE_ROW_BASE_PX + depth * TREE_INDENT_PX + 18}px`;

  const dot = document.createElement('span');
  dot.className = 'entity-dot';
  dot.style.color = COLLIDER_ROW_COLOR;
  dot.textContent = '▣';
  li.appendChild(dot);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'item-name';
  nameSpan.textContent = colliderDisplayName(col);
  if (col.enabled === false) nameSpan.style.textDecoration = 'line-through';
  nameSpan.title = `Collision box, id ${col.colliderId} (addressable by triggers)`;
  li.appendChild(nameSpan);

  li.addEventListener('click', () => {
    if (state.selectedInstanceId === col.id) return;
    state.selectedInstanceId = col.id;
    state.selectedFolderId = null;
    // Selecting a box forces a view mode on: you cannot position something
    // you cannot see, and silently doing nothing because a viewport control
    // happens to be Off reads as the feature being broken. FOCUS is the
    // right default here - you have just said which object you care about,
    // and translucent is the mode you can actually fit a box in.
    if (viewer.getCollisionViewMode() === viewer.COLLISION_VIEW_OFF) {
      setCollisionViewMode(viewer.COLLISION_VIEW_FOCUS);
    }
    updateUI();          // rebuilds the overlay, which re-attaches the gizmo
    viewer.selectCollider(col.id);
  });

  li.addEventListener('dblclick', () => {
    startRename(nameSpan, colliderDisplayName(col), (value) => {
      const newName = value.length === 0 ? null : value;
      if (newName === col.name) return;
      pushHistory(state);
      markDirty();
      col.name = newName;
    });
  });

  const del = document.createElement('button');
  del.className = 'row-btn';
  del.textContent = '×';
  del.title = 'Delete this collision box';
  del.addEventListener('click', (evt) => {
    evt.stopPropagation();
    pushHistory(state);
    markDirty();
    state.removeCollider(col.id);
    updateUI();
  });
  li.appendChild(del);

  return li;
}

function renderInstanceList() {
  instanceListEl.innerHTML = '';

  // Depth-first walk from the root: each level lists its folders first
  // (matching how file explorers sort), then its instances, then its
  // editor entities. Collapsed folders simply don't recurse - that IS
  // the descendant hiding.
  const renderLevel = (parentId, depth) => {
    for (const folder of state.folders.filter((f) => f.parentId === parentId)) {
      instanceListEl.appendChild(buildFolderRow(folder, depth));
      if (!folder.collapsed) renderLevel(folder.id, depth + 1);
    }
    for (const inst of state.instances.filter((i) => i.parentId === parentId)) {
      instanceListEl.appendChild(buildInstanceRow(inst, depth));
      // Collision boxes nest under the instance that owns them. Instances
      // were previously leaves - only folders recursed - so this is the
      // first thing in the tree that can have a model instance as a parent.
      // Not collapsible: a couple of boxes is not a subtree worth hiding,
      // and seeing them is the point of authoring them.
      for (const col of state.collidersFor(inst.id)) {
        instanceListEl.appendChild(buildColliderRow(col, depth + 1));
      }
    }
    for (const ent of state.entities.filter((e) => e.parentId === parentId)) {
      instanceListEl.appendChild(buildEntityRow(ent, depth));
    }
  };
  renderLevel(null, 0);
}

// Dropping on the Instances page background (outside any row) moves the
// dragged row back to the root level.
const tabInstancesPage = document.getElementById('tab-instances');
tabInstancesPage.addEventListener('dragover', (evt) => {
  if (!canDropInto(null)) return;
  evt.preventDefault();
  evt.dataTransfer.dropEffect = 'move';
});
tabInstancesPage.addEventListener('drop', (evt) => {
  evt.preventDefault();
  dropInto(null);
});

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
    // The transform fields are shared between model instances and editor
    // entities (spawn/light/etc.), so resolve either - getInstance() alone
    // returns null for an entity and crashed on the [group] read.
    const node = state.getInstance(id) || state.getEntity(id);
    if (node) viewer.setInstanceTransform(id, { [group]: node[group] });
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

/**
 * Checkbox counterpart to wireInstanceField, for boolean instance fields.
 *
 * DELIBERATELY SEPARATE rather than a third mode inside applyInstanceField().
 * That function is built around a numeric pipeline - parse the string, reject
 * NaN, round, then branch on palette-vs-transform to decide which viewer
 * update to fire - and a checkbox shares none of it: `.checked` is already a
 * boolean, can't be NaN, and drives no viewport update yet (the collider
 * wireframe overlay will change that, and is the natural place to hook in).
 * Threading a boolean through the numeric path would mean guarding every one
 * of those steps against a case they weren't written for.
 *
 * Only 'change' is wired, not 'input': a checkbox fires both together, so
 * listening to both would push two undo entries per click.
 */
function wireInstanceCheckbox(inputEl, path) {
  inputEl.addEventListener('change', () => {
    const id = state.selectedInstanceId;
    if (id === null) return;

    pushHistory(state);
    markDirty();
    state.setInstanceField(id, path, inputEl.checked);
    updateUI();
  });
}

wireInstanceCheckbox(fCollide, 'collide');

// ---- Animation fields ----
// The Animation section is only visible for a selected model instance whose
// model carries clips, so these handlers can assume the selection IS such an
// instance - but each still guards on getInstance() so a stray change event
// (e.g. from a disabled control) on an entity selection can't write an `anim`
// block onto something that has none.
function commitAnimField(path, value) {
  const id = state.selectedInstanceId;
  if (id === null || !state.getInstance(id)) return;
  pushHistory(state);
  markDirty();
  state.setInstanceField(id, path, value);
  updateUI();
}

fAnimDefault.addEventListener('change', () => {
  // Empty option value is the "None" sentinel -> null clip (play nothing).
  commitAnimField('anim.clip', fAnimDefault.value || null);
});
fAnimLoop.addEventListener('change', () => {
  commitAnimField('anim.loop', fAnimLoop.checked);
});
fAnimAutoplay.addEventListener('change', () => {
  commitAnimField('anim.autoplay', fAnimAutoplay.checked);
});
// Speed is numeric: only 'change' (blur/Enter) is wired, so each committed
// value is one undo entry. A non-positive or unparseable entry snaps back to
// 1.0 rather than shipping a zero/negative rate the runtime can't use.
fAnimSpeed.addEventListener('change', () => {
  let v = parseFloat(fAnimSpeed.value);
  if (!Number.isFinite(v) || v <= 0) v = 1;
  commitAnimField('anim.speed', round3(v));
});

// ---- Auto Box / Add Box ----
// viewer.js owns the loaded glTF, so it is the only place that knows a
// model's per-mesh bounds; state owns the boxes. app.js is the seam, exactly
// as it is for palette rows and the collider overlay.
const btnAutoBox = document.getElementById('f-auto-box');
const btnAddBox = document.getElementById('f-add-box');
const colliderCountHintEl = document.getElementById('collider-count-hint');

btnAutoBox.addEventListener('click', () => {
  const inst = state.selectedInstanceId !== null ? state.getInstance(state.selectedInstanceId) : null;
  if (!inst) return;

  const bounds = viewer.getModelMeshBounds(inst.model);
  if (!bounds || bounds.length === 0) {
    // The model isn't loaded (project opened without reopening the assets
    // folder), so there are no bounds to fit to. Say so rather than
    // silently producing nothing or a meaningless unit box.
    showWarning(
      `Can't Auto Box "${inst.model}" - its geometry isn't loaded in this session. ` +
      'Reopen the assets folder, then try again.'
    );
    return;
  }

  pushHistory(state);
  markDirty();
  const made = state.autoBoxInstance(inst.id, bounds);
  updateUI();
  showInfo(
    `Seeded ${made.length} collision box${made.length === 1 ? '' : 'es'} from ` +
    `${made.map((c) => c.name).join(', ')}. Drag them into shape and delete what you don't need.`
  );
});

/**
 * Wire one Center/Size numeric field of the selected collision box.
 *
 * Separate from wireInstanceField() for the same reason wireInstanceCheckbox()
 * is: that function resolves state.selectedInstanceId as an instance or entity
 * and routes viewport updates by field group, none of which applies here.
 *
 * Size is clamped to a small positive minimum. A zero or negative extent makes
 * a box that can never contain anything - it would sit in the tree looking
 * authored while being silently inert, which is exactly the failure the
 * runtime's own ">= 1" guarantee exists to prevent.
 */
const MIN_BOX_SIZE = 0.01;
function wireColliderField(inputEl, group, axis) {
  const apply = (pushUndo) => {
    const col = state.getCollider(state.selectedInstanceId);
    if (!col) return;

    let value = round3(parseFloat(inputEl.value));
    if (Number.isNaN(value)) return;
    if (group === 'size' && value < MIN_BOX_SIZE) value = MIN_BOX_SIZE;

    if (pushUndo) {
      pushHistory(state);
      markDirty();
    }
    col[group][axis] = value;
    refreshColliderOverlay();
  };

  inputEl.addEventListener('input', () => apply(false));
  inputEl.addEventListener('change', () => { apply(true); updateUI(); });
}

wireColliderField(cCenterX, 'center', 'x');
wireColliderField(cCenterY, 'center', 'y');
wireColliderField(cCenterZ, 'center', 'z');
wireColliderField(cSizeX, 'size', 'x');
wireColliderField(cSizeY, 'size', 'y');
wireColliderField(cSizeZ, 'size', 'z');

cEnabled.addEventListener('change', () => {
  const col = state.getCollider(state.selectedInstanceId);
  if (!col) return;
  pushHistory(state);
  markDirty();
  col.enabled = cEnabled.checked;
  updateUI();
});

btnAddBox.addEventListener('click', () => {
  const inst = state.selectedInstanceId !== null ? state.getInstance(state.selectedInstanceId) : null;
  if (!inst) return;

  pushHistory(state);
  markDirty();
  const c = state.addCollider(inst.id, { name: 'Box' });
  state.selectedInstanceId = c.id;   // select it so it can be dragged immediately
  updateUI();
});

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
    // Gizmo drags apply to model instances and editor entities alike.
    const node = state.getInstance(id) || state.getEntity(id);
    if (!node) return;
    node.pos = round3Axes(transform.pos);
    node.rot = round3Axes(transform.rot);
    if (transform.scale) node.scale = round3Axes(transform.scale);
  }
  refreshTransformFields();
  // Live during the drag, not just on release: a collider box that lags the
  // object it describes is worse than no box, since the whole point is
  // judging clearances while positioning. This fires many times per drag but
  // rebuilds only tens of 12-line wireframes, and no-ops when the overlay is
  // off - which is the common case.
  refreshColliderOverlay();
});

viewer.onSelectionChange((id) => {
  // Any viewport pick replaces whatever was selected in the tree,
  // including a selected folder (folders have no viewport presence, so
  // there's nothing viewport-side to keep them selected FOR).
  state.selectedFolderId = null;
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
// Fog panel
// ==========================================================================
//
// Stage-level, like the camera panel above - fog has no position and there
// is exactly one per stage, so it is not an entity kind. Each control maps
// 1:1 onto a main.c global (see FOG_DEFAULTS in stage_state.js).
//
// THE ONE THING THIS PANEL DOES THAT THE CAMERA PANEL DOESN'T is clamp on
// commit. main.c's fog_clamp_range() exists because near/far feed a
// reciprocal ramp (DQA = 256*near*far/(h*span), DQB = 16777216*far/span) with
// hard int32 limits, and a range outside them doesn't look wrong - it
// INVERTS, fogging near geometry and leaving distant geometry clear. The pad
// editor clamps for exactly this reason; authoring the same values in a tool
// that didn't clamp would just move the failure to hardware, where it is far
// more expensive to diagnose. So the panel physically cannot hold a
// degenerate range: a committed value is corrected in place, and the author
// is told rather than silently overruled.
//
// The correction runs on COMMIT ONLY (the 'change' half of the live/commit
// split), never on the live 'input' pass - clamping mid-drag-scrub would
// fight the drag, snapping the value back under the cursor on every frame
// that strayed out of range.

/** Live readout under Near/Far: what these actually export, in the engine
 *  units main.c's globals hold. Makes the *1024 upscale visible instead of
 *  implicit, so an author reading the fog block in main.c can match numbers
 *  against the tool without doing arithmetic. */
function refreshFogRangeHint() {
  const nearEng = Math.round(state.fog.near * 1024);
  const farEng = Math.round(state.fog.far * 1024);
  fogRangeHint.textContent =
    `Exports as fog_near ${nearEng}, fog_far ${farEng} (engine units). ` +
    `Ramp is linear in 1/z, so fog thickens fastest just past Near.`;
}

/**
 * Commit one fog field. `clampRange` re-runs the near/far clamp afterward
 * (only the two distance fields need it). Mirrors applyCameraField's
 * live-vs-commit contract: pushUndo/fullRerender are the caller's call.
 */
function applyFogField(key, value, { pushUndo, fullRerender, clampRange = false }) {
  if (pushUndo) {
    pushHistory(state);
    markDirty();
  }

  state.fog[key] = value;

  if (clampRange) {
    const before = { near: state.fog.near, far: state.fog.far };
    const after = clampFogViewportRange(state.fog.near, state.fog.far);
    state.fog.near = after.near;
    state.fog.far = after.far;

    // Only shout when the clamp actually moved something, and only on a
    // commit - a live scrub through an illegal range is not a mistake, it's
    // just a cursor passing through.
    if (pushUndo && (after.near !== before.near || after.far !== before.far)) {
      showWarning(
        `Fog range adjusted to ${after.near.toFixed(3)} / ${after.far.toFixed(3)} - the authored values would ` +
        `rail the GTE's depth ramp (|DQA| > ${FOG_LIMITS.DQA_RAIL}) or overflow DQB, which inverts the fog on ` +
        'hardware rather than merely looking wrong. main.c clamps identically at fog_clamp_range().'
      );
    }
  }

  pushFogToViewer();
  refreshFogRangeHint();
  if (fullRerender) updateUI();
}

/** Hand the current fog block to the viewport's PS1 parity preview. */
function pushFogToViewer() {
  viewer.setStageFog(state.fog);
}

fogEnabled.addEventListener('change', () => {
  applyFogField('enabled', fogEnabled.checked, { pushUndo: true, fullRerender: false });
});

fogCull.addEventListener('change', () => {
  applyFogField('cull', fogCull.checked, { pushUndo: true, fullRerender: false });
});

fogDrift.addEventListener('change', () => {
  applyFogField('drift', fogDrift.checked, { pushUndo: true, fullRerender: false });
});

fogColor.addEventListener('change', () => {
  applyFogField('color', fogColor.value, { pushUndo: true, fullRerender: false });
});

fogLayers.addEventListener('change', () => {
  const raw = Math.round(parseFloat(fogLayers.value));
  if (Number.isNaN(raw)) {
    fogLayers.value = state.fog.layers; // reject nonsense, reset visibly
    return;
  }
  // Hard-clamped rather than warned: FOG_MAX_LAYERS is a primitive-budget
  // ceiling, and past ~4 layers the blend is already >94% fog, so a value
  // above it buys nothing the author would miss.
  const clamped = Math.max(0, Math.min(FOG_LIMITS.MAX_LAYERS, raw));
  fogLayers.value = clamped;
  applyFogField('layers', clamped, { pushUndo: true, fullRerender: false });
});

// Near/Far use the same live-vs-commit split as every other numeric field so
// drag-scrub feels identical here: 'input' moves the preview with no undo
// entry and no clamp, 'change' commits, clamps, and warns if it had to.
function wireFogDistanceField(inputEl, key) {
  inputEl.addEventListener('input', () => {
    const value = parseFloat(inputEl.value);
    if (Number.isNaN(value)) return;
    applyFogField(key, value, { pushUndo: false, fullRerender: false });
  });
  inputEl.addEventListener('change', () => {
    const value = parseFloat(inputEl.value);
    if (Number.isNaN(value)) {
      inputEl.value = round3(state.fog[key]);
      return;
    }
    applyFogField(key, value, { pushUndo: true, fullRerender: false, clampRange: true });
    // Write the CLAMPED values back into both fields - the clamp can move
    // far when near was the field edited, and vice versa.
    fogNear.value = round3(state.fog.near);
    fogFar.value = round3(state.fog.far);
  });
}

wireFogDistanceField(fogNear, 'near');
wireFogDistanceField(fogFar, 'far');

// ==========================================================================
// Toolbar: transform mode
// ==========================================================================

// Buttons only REQUEST the mode; the onTransformModeChange callback below
// is the single place that records it and re-renders. That callback also
// fires for viewer.js's own W/E/R shortcuts, so the toolbar highlight can
// never desync from the actual gizmo mode no matter which route changed it
// (previously W/E/R switched the gizmo but left the buttons stale).
for (const [mode, btn] of Object.entries(modeButtons)) {
  btn.addEventListener('click', () => viewer.setTransformMode(mode));
}

viewer.onTransformModeChange((mode) => {
  currentTransformMode = mode;
  updateUI();
});

// Snap settings (toolbar). Grid Snap Increment feeds the Ctrl+drag
// quantization (both TransformControls' translationSnap and the
// surface-drag rounding); the seam-snap tickbox toggles flush
// bounding-box snapping against neighboring instances during any
// translate drag. Neither belongs in undo history or the project file -
// they're editor input preferences, like the transform mode itself.
const fSnapIncrement = document.getElementById('f-snap-increment');
const fSeamSnap = document.getElementById('f-seam-snap');

fSnapIncrement.addEventListener('change', () => {
  const value = parseFloat(fSnapIncrement.value);
  if (!Number.isFinite(value) || value <= 0) {
    fSnapIncrement.value = 1; // reject nonsense, reset visibly
    viewer.setSnapIncrement(1);
    return;
  }
  viewer.setSnapIncrement(value);
});

fSeamSnap.addEventListener('change', () => {
  viewer.setSeamSnapEnabled(fSeamSnap.checked);
});

// ==========================================================================
// Toolbar: view group (editing orbit camera only - NOT the exported PS1
// camera gizmo, which is handled separately by the "Camera panel" section
// above via wireCameraField()).
// ==========================================================================

btnViewFront.addEventListener('click', () => viewer.setViewportView('front'));
btnViewTop.addEventListener('click', () => viewer.setViewportView('top'));
btnViewSide.addEventListener('click', () => viewer.setViewportView('side'));
btnViewReset.addEventListener('click', () => viewer.resetViewportCamera());
document.getElementById('view-grid').addEventListener('click', () => viewer.toggleGridVisible());

// ---- Collision view (Off / All / Focus) ----
// viewer.js has no access to editor state, so app.js decides which instances
// are collidable, which boxes exist, and what "focused" resolves to - same
// division of labour as palette rows.
const collisionModeButtons = {
  [viewer.COLLISION_VIEW_OFF]: document.getElementById('collision-off'),
  [viewer.COLLISION_VIEW_ALL]: document.getElementById('collision-all'),
  [viewer.COLLISION_VIEW_FOCUS]: document.getElementById('collision-focus'),
};

function setCollisionViewMode(mode) {
  viewer.setCollisionViewMode(mode);
  for (const [m, btn] of Object.entries(collisionModeButtons)) {
    btn.classList.toggle('is-active', Number(m) === mode);
  }
  refreshColliderOverlay(); // rebuild now, not on the next unrelated re-render
}

for (const [mode, btn] of Object.entries(collisionModeButtons)) {
  btn.addEventListener('click', () => setCollisionViewMode(Number(mode)));
}

/**
 * The instance FOCUS mode should show. Selecting either an instance or one of
 * its boxes focuses that instance - picking a box out of the tree must not
 * hide the thing the box belongs to, which is the one object you need to see
 * while fitting it.
 */
function focusedInstanceId() {
  if (state.selectedInstanceId === null) return null;
  if (state.getInstance(state.selectedInstanceId)) return state.selectedInstanceId;
  const col = state.getCollider(state.selectedInstanceId);
  return col ? col.parentInstanceId : null;
}

/** Push the current collision picture into the viewer, if a view mode is on. */
function refreshColliderOverlay() {
  if (viewer.getCollisionViewMode() === viewer.COLLISION_VIEW_OFF) return;

  // Authored boxes grouped by owning instance. The viewer draws these INSTEAD
  // of the automatic per-mesh fallback wherever an instance has any, matching
  // what the runtime will do.
  const authored = new Map();
  for (const c of state.colliders) {
    if (!authored.has(c.parentInstanceId)) authored.set(c.parentInstanceId, []);
    authored.get(c.parentInstanceId).push(c);
  }

  viewer.refreshColliderOverlay(
    new Set(state.instances.filter((inst) => inst.collide !== false).map((inst) => inst.id)),
    authored,
    state.selectedInstanceId,
    focusedInstanceId()
  );
}

// Live gizmo drags on a collision box. The viewer reports center/size in the
// owning instance's local space, which is exactly what state stores - no
// conversion, because the box mesh is unit geometry parented to the instance.
//
// Size is floored here as well as in the numeric field: a gizmo scale handle
// dragged through zero would otherwise author a negative extent, which the
// exporter's Math.abs would silently turn back into a positive one - a box
// that quietly stops matching its handles.
viewer.onColliderChange((id, transform) => {
  const col = state.getCollider(id);
  if (!col || !transform) return;
  col.center = { ...transform.center };
  col.size = {
    x: Math.max(Math.abs(transform.size.x), MIN_BOX_SIZE),
    y: Math.max(Math.abs(transform.size.y), MIN_BOX_SIZE),
    z: Math.max(Math.abs(transform.size.z), MIN_BOX_SIZE),
  };
  refreshTransformFields(); // keep the Center/Size numbers live during the drag
});

// Viewport shading toggle (top-right overlay, Blender-style): Editor =
// unlit full-bright textures, PS1 = live preview of the runtime's GTE
// lighting from this stage's authored Light entities (see viewer.js's
// "PS1 lighting parity preview" section for exactly what is emulated).
// Editor preference only - not undo history, not the project file.
const shadingEditorBtn = document.getElementById('shading-editor');
const shadingPs1Btn = document.getElementById('shading-ps1');

function setViewportShading(ps1) {
  viewer.setPS1LightingEnabled(ps1);
  shadingEditorBtn.classList.toggle('is-active', !ps1);
  shadingPs1Btn.classList.toggle('is-active', ps1);
}

shadingEditorBtn.addEventListener('click', () => setViewportShading(false));
shadingPs1Btn.addEventListener('click', () => setViewportShading(true));

// Missing=White (View group): render missing-texture materials solid white
// instead of magenta. Pairs with the PS1 shading preview as a brightness
// probe (an untextured white face shows the raw lit colour). Editor
// preference only, like the shading toggle.
const fMissingWhite = document.getElementById('f-missing-white');
fMissingWhite.addEventListener('change', () => {
  viewer.setMissingTextureWhite(fMissingWhite.checked);
});

// ==========================================================================
// Toolbar: file group - Load / Save / Export
// ==========================================================================

btnSaveProject.addEventListener('click', () => {
  const json = buildProjectJson(state);
  downloadProjectFile(json, 'development.StageGen');
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
  // (dirHandle, materialsMap) is NOT restored - see stage_project.js
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
    // v6 field. `!== false` means a v1-v5 file - which has no `collide` key
    // at all - loads every instance SOLID. See the version note in
    // stage_project.js: that is the intended default, and it is why
    // reopening an old project is worth an audit pass.
    collide: inst.collide !== false,
    // v2 fields - `?? null` also quietly flattens any pre-v2 file into
    // "no custom names, everything at root" instead of erroring.
    name: inst.name ?? null,
    parentId: inst.parentId ?? null,
    pos: { ...inst.pos },
    rot: { ...inst.rot },
    scale: { ...inst.scale },
    // v8 field. A v1-v7 project has no `anim` key; normalizeAnim backfills
    // clip=None (no default animation), which is what those stages already did.
    anim: normalizeAnim(inst.anim),
  }));
  // v7 field. A v1-v6 project has none, which leaves every instance on the
  // automatic per-primitive AABB fallback - exactly what those files already
  // shipped with, so an old project opens unchanged.
  state.colliders = (parsed.colliders || [])
    // Drop any box whose owning instance didn't survive the load rather than
    // keeping an orphan that can never be selected, edited or exported.
    .filter((c) => parsed.instances.some((inst) => inst.id === c.parentInstanceId))
    .map((c) => ({
      id: c.id,
      parentInstanceId: c.parentInstanceId,
      name: c.name ?? null,
      colliderId: c.colliderId ?? 0,
      enabled: c.enabled !== false,
      center: { x: 0, y: 0, z: 0, ...(c.center || {}) },
      size: { x: 1, y: 1, z: 1, ...(c.size || {}) },
    }));
  // Re-seat the id counter above whatever the file used, so the next box
  // added can't reuse a loaded box's id. Same repair the spawn/sound
  // namespaces already do.
  state.nextColliderId = Math.max(parsed.nextColliderId ?? 0, state.maxColliderId() + 1);

  state.folders = (parsed.folders || []).map((folder) => ({
    id: folder.id,
    name: folder.name || 'Folder',
    parentId: folder.parentId ?? null,
    collapsed: !!folder.collapsed,
  }));
  // v3 field: editor entities. Unknown kinds (from a future version) are
  // dropped rather than crashing the tree render; props merge over the
  // kind's defaults so a schema addition gets its default on old files.
  state.entities = (parsed.entities || [])
    .filter((ent) => ENTITY_KINDS[ent.kind])
    .map((ent) => {
      const defaults = {};
      for (const propDef of ENTITY_KINDS[ent.kind].props) {
        defaults[propDef.key] = propDef.default;
      }
      return {
        id: ent.id,
        kind: ent.kind,
        name: ent.name ?? null,
        parentId: ent.parentId ?? null,
        pos: { x: 0, y: 0, z: 0, ...ent.pos },
        rot: { x: 0, y: 0, z: 0, ...ent.rot },
        scale: { x: 1, y: 1, z: 1, ...ent.scale },
        props: { ...defaults, ...ent.props },
      };
    });
  state.camera.pos = { ...parsed.camera.pos };
  state.camera.rot = { ...parsed.camera.rot };
  // Fog arrived in project format v4. Merging over FOG_DEFAULTS (rather than
  // requiring the block) means a v1-v3 file loads with main.c's compiled-in
  // fog values - which is precisely the fog those stages shipped with, so
  // nothing about how they render changes. Same no-shim policy as folders/
  // entities in v2/v3.
  state.fog = { ...FOG_DEFAULTS, ...(parsed.fog || {}) };
  state.selectedInstanceId = null;
  state.selectedFolderId = null;
  state.nextId =
    parsed.nextId ||
    Math.max(
      0,
      ...state.instances.map((i) => i.id),
      ...state.folders.map((f) => f.id),
      ...state.entities.map((e) => e.id)
    ) + 1;
  state.nextSpawnId =
    parsed.nextSpawnId ??
    Math.max(-1, ...state.entities.map((e) => (Number.isFinite(e.props.spawnId) ? e.props.spawnId : -1))) + 1;
  // Sound IDs arrived in project format v5. A v1-v4 file has none, so the
  // counter is derived from whatever ids the schema-default merge just
  // handed the loaded Sound entities - max + 1, exactly the same recovery
  // the spawn counter above uses. Deriving rather than defaulting to 0
  // matters: starting at 0 against existing entities would mint duplicates
  // immediately, and a trigger reference is only as good as its id.
  state.nextSoundId = parsed.nextSoundId ?? 0;

  // Fill in and de-duplicate every unique id, then re-seat both counters.
  // Load-bearing for older files: a v1-v4 project has no soundId at all, so
  // the schema-default merge above just gave every Sound the same 0 - which
  // would make a trigger's "sound 0" reference resolve to whichever emitter
  // came first. Files that were already correct pass through untouched.
  state.repairUniqueIds();

  // Loading a whole new project makes the PREVIOUS project's undo history
  // meaningless (undoing "into" a different loaded file would be
  // confusing, not useful), so history starts fresh here.
  clearHistory();
  isDirty = false; // freshly-loaded project == nothing unsaved yet

  // Auto-load every model this project's instances reference, PROVIDED
  // the assets folder is already open this session (i.e. its entry
  // exists in window.__stageGenDiscoveredModels - populated by
  // handleRootFolderHandle() when "Open Assets Folder" was used, at any
  // point before or after this project load). Previously the user had to
  // manually click each model name in the sidebar list one at a time
  // after loading a project, even when the exact folder those models
  // live in was already open and fully scanned - loadModelData() already
  // does the real work (parse .glb, decode .tim textures, register
  // the template), this just calls it automatically for every name the
  // project actually needs instead of waiting for a click per model.
  const referencedModelNames = new Set(state.instances.map((inst) => inst.model));
  const discovered = window.__stageGenDiscoveredModels || [];
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

btnExportStage.addEventListener('click', () => {
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

  // Music slot check: the runtime plays the FIRST music entity with
  // Autoplay ticked (Autoplay is music's enable toggle - unticked
  // tracks are authored-but-disabled). More than one enabled track
  // means later ones will be silently ignored, so surface it here at
  // author time instead of letting it fail silently on hardware. Warn,
  // don't block - same policy as palette warnings above.
  const enabledMusic = (state.entities || []).filter(
    (ent) =>
      ent.kind === 'sound' &&
      ent.props.mode === 'music' &&
      ent.props.autoplay !== false &&
      (ent.props.sample || '').trim() !== ''
  );
  if (enabledMusic.length > 1) {
    showWarning(
      `Multiple music entities have Autoplay enabled (${enabledMusic
        .map((e) => e.name || e.props.sample.trim())
        .join(', ')}). Only the first will play - untick Autoplay on the others to disable them.`
    );
  }

  // Fog checks: things that are legal but probably not what was meant -
  // zero quad layers (textured geometry silently won't fog), culling with
  // too few layers to hide the pop, and a non-neutral fog colour (which
  // needs a matching FOG_COL_* edit in main.c, since the screen clear colour
  // is derived from the same constant). Warn, don't block, same policy as
  // palette rows and the music-slot check above.
  const fogWarnings = state.validateFog();
  if (fogWarnings.length > 0) {
    showWarning(fogWarnings.join('\n\n'));
  }

  // Switch Scene triggers with no destination. The runtime resolves
  // targetStage late (by name, like model names) and counts a miss as
  // unresolved rather than crashing - but an EMPTY target is never a typo
  // the runtime can help with, it just means the author hasn't filled it in
  // yet. Catch it here where the fix is one field away. Warn, don't block:
  // a half-authored door shouldn't stop the rest of the stage exporting.
  const danglingDoors = (state.entities || []).filter(
    (ent) =>
      ent.kind === 'trigger' &&
      ent.props.action === 'switchScene' &&
      (ent.props.targetStage || '').trim() === ''
  );
  if (danglingDoors.length > 0) {
    showWarning(
      `${danglingDoors.length} Switch Scene trigger(s) have no Target Stage set ` +
      `(${danglingDoors.map((e) => e.name || e.props.event || `#${e.id}`).join(', ')}). ` +
      'They are exported but will never fire - fill in the destination stage folder name.'
    );
  }

  // Upon Enter SFX references that no longer resolve. A trigger can be left
  // pointing at a Sound that was since deleted, had its sample cleared, or
  // was switched to Music mode - none of which touches the trigger, so the
  // dangling reference is invisible in the panel (the dropdown just shows
  // "(None)"). The exporter collapses these to -1 so nothing broken ships;
  // this says so out loud, because silently dropping an authored sound is
  // exactly the kind of change someone should get to disagree with.
  const liveSoundIds = new Set(state.listTriggerableSounds().map((s) => s.soundId));
  const danglingSfx = (state.entities || []).filter(
    (ent) =>
      ent.kind === 'trigger' &&
      ent.props.action === 'switchScene' &&
      Number.isFinite(ent.props.onEnterSoundId) &&
      ent.props.onEnterSoundId >= 0 &&
      !liveSoundIds.has(ent.props.onEnterSoundId)
  );
  if (danglingSfx.length > 0) {
    showWarning(
      `${danglingSfx.length} Switch Scene trigger(s) reference an Upon Enter SFX that no longer exists ` +
      `(${danglingSfx.map((e) => e.name || e.props.event || `#${e.id}`).join(', ')}). ` +
      'The sound was deleted, had its sample cleared, or was switched to Music mode. ' +
      'Exported as no sound - re-pick one if that was not intended.'
    );
  }

  // Collide audit nudge. `collide` DEFAULTS TRUE, which is right for level
  // geometry and wrong for foliage, decals and ceiling detail - and an
  // instance placed before the field existed carries the default silently.
  // A stage where EVERY instance is solid is the signature of a stage nobody
  // has audited yet, so say so once, at the moment it would ship.
  //
  // Gated on >1 instance: a one-object test stage being fully solid is not a
  // signal, it's arithmetic. Warn, don't block - same policy as every check
  // above, and "all solid" is a perfectly legal thing to mean.
  const collidableCount = state.instances.filter((inst) => inst.collide !== false).length;
  if (state.instances.length > 1 && collidableCount === state.instances.length) {
    showWarning(
      `All ${collidableCount} instances are set to Collide. That is the default, so this ` +
      'may just mean the stage has not been audited yet - untick Collide on foliage, ' +
      'decals and detail geometry the player should walk through.'
    );
  }

  const json = buildStageJson(state);
  downloadStageJson(json, 'stage.json');
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
    collide: inst.collide !== false,
    name: inst.name ?? null,
    parentId: inst.parentId ?? null,
    pos: { ...inst.pos },
    rot: { ...inst.rot },
    scale: { ...inst.scale },
    anim: normalizeAnim(inst.anim),
  }));
  // The other half of history.js's snapshot(). Without this, undo restores
  // the instances but silently drops every collider on the stage.
  state.colliders = (snapshot.colliders || []).map((c) => ({
    id: c.id,
    parentInstanceId: c.parentInstanceId,
    name: c.name,
    colliderId: c.colliderId,
    enabled: c.enabled !== false,
    center: { ...c.center },
    size: { ...c.size },
  }));
  state.nextColliderId = snapshot.nextColliderId ?? state.nextColliderId;
  state.folders = (snapshot.folders || []).map((folder) => ({ ...folder }));
  state.entities = (snapshot.entities || []).map((ent) => ({
    id: ent.id,
    kind: ent.kind,
    name: ent.name,
    parentId: ent.parentId,
    pos: { ...ent.pos },
    rot: { ...ent.rot },
    scale: { ...ent.scale },
    props: { ...ent.props },
  }));
  state.camera.pos = { ...snapshot.camera.pos };
  state.camera.rot = { ...snapshot.camera.rot };
  state.fog = { ...FOG_DEFAULTS, ...(snapshot.fog || {}) };
  state.selectedInstanceId = snapshot.selectedInstanceId;
  state.selectedFolderId = snapshot.selectedFolderId ?? null;
  state.nextId = snapshot.nextId;
  state.nextSpawnId = snapshot.nextSpawnId ?? state.nextSpawnId;
  state.nextSoundId = snapshot.nextSoundId ?? state.nextSoundId;

  resyncViewportFromState();
  updateUI();
}

window.addEventListener('keydown', (event) => {
  const tag = document.activeElement && document.activeElement.tagName;
  // Don't hijack Ctrl+Z/Delete/Ctrl+D while editing a number field - e.g.
  // Backspace needs to delete a character in a focused input, not the
  // selected 3D instance, and Ctrl+Z inside a field should probably use
  // the browser's own native text-undo rather than the stage history.
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
  const isRedo =
    ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z') ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y');
  const isDuplicate = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd';
  const isCopy = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'c';
  const isPaste = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'v';
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
    if (event.key === 'c' || event.key === 'C') {
      // Cycle Off -> All -> Focus -> Off. A cycle rather than a toggle
      // because there are three states and reaching the third shouldn't
      // require going back to the mouse.
      setCollisionViewMode((viewer.getCollisionViewMode() + 1) % 3);
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
    if (state.getInstance(state.selectedInstanceId)) {
      duplicateInstance(state.selectedInstanceId);
    } else if (state.getEntity(state.selectedInstanceId)) {
      duplicateEntity(state.selectedInstanceId);
    } else if (state.getCollider(state.selectedInstanceId)) {
      // Ctrl+D on a box is the main way to build a wall out of several -
      // duplicate, nudge, repeat.
      pushHistory(state);
      markDirty();
      const clone = state.duplicateCollider(state.selectedInstanceId);
      if (clone) state.selectedInstanceId = clone.id;
      updateUI();
    }
  } else if (isCopy) {
    // Only claim Ctrl+C when we actually have a node to copy; otherwise let
    // the browser's own copy (e.g. of selected page text) proceed.
    if (state.selectedInstanceId === null) return;
    event.preventDefault();
    copySelection();
  } else if (isPaste) {
    event.preventDefault();
    pasteSelection();
  } else if (isDelete) {
    // Backspace's browser default is "navigate back" on some pages when
    // focus isn't in a text field - preventDefault() unconditionally here
    // (not just when something is actually selected) to make sure that
    // never fires while the user is working in the viewport.
    event.preventDefault();
    if (state.selectedInstanceId !== null) {
      if (state.getInstance(state.selectedInstanceId)) {
        deleteInstance(state.selectedInstanceId);
      } else if (state.getCollider(state.selectedInstanceId)) {
        // No confirm dialog, unlike instances and folders: a box is cheap to
        // re-add, Auto Box makes several at once so pruning is routine, and
        // Ctrl+Z restores it. A prompt per box would make the normal
        // workflow tedious.
        pushHistory(state);
        markDirty();
        state.removeCollider(state.selectedInstanceId);
        updateUI();
      } else {
        deleteEntity(state.selectedInstanceId);
      }
    } else if (state.selectedFolderId !== null) {
      // With per-row Del buttons gone, the Delete key is the only way to
      // remove a folder - it takes the whole subtree with it (confirmed
      // first, with the contained-instance count spelled out).
      deleteFolder(state.selectedFolderId);
    }
  }
});

// ==========================================================================
// Central re-render
// ==========================================================================

/**
 * Rebuild the entity Parameters section for the selected entity from
 * its ENTITY_KINDS schema: checkboxes for bools, number inputs for
 * int/number, text inputs for strings, dropdowns for selects (propDef
 * carries an `options: [{ value, label }]` list; the committed prop
 * value is the option's `value` string). A propDef may also carry
 * `showIf: (props) => bool` - the field is skipped entirely while the
 * predicate is false (e.g. sound interval bounds only exist in Random
 * Interval mode); committing a select re-renders the section so those
 * dependent fields appear/disappear immediately. Committing a change pushes one
 * undo entry, writes the prop, and forwards it to the viewer so live
 * visuals (summon patrol ring, billboard tracking/through-walls) update
 * immediately.
 *
 * Skipped entirely while focus is INSIDE the section - every change
 * event funnels through updateUI() paths that land back here, and
 * rebuilding the input the user is actively typing in would yank focus
 * and eat keystrokes. The skipped rebuild costs nothing: the focused
 * input already shows what the user typed, and state already holds it.
 */
function renderEntityProps(ent) {
  if (entityPropsBodyEl.contains(document.activeElement)) return;

  const def = ENTITY_KINDS[ent.kind];
  if (!def) return;
  entityPropsTitleEl.textContent = `${def.label} Parameters`;
  entityPropsBodyEl.innerHTML = '';

  for (const propDef of def.props) {
    // Conditionally-relevant fields (showIf) are skipped while their
    // predicate is false - the stored prop value is untouched, it just
    // isn't editable (or exported as meaningful) in that state.
    if (propDef.showIf && !propDef.showIf(ent.props)) continue;

    const commit = (rawValue, inputEl) => {
      let value = rawValue;
      if (propDef.type === 'int') value = parseInt(rawValue, 10);
      else if (propDef.type === 'number') value = parseFloat(rawValue);
      // A select's DOM value is always a STRING. Most selects store strings
      // ('loop', 'switchScene'), but one that references an entity by id
      // must store a NUMBER, or it would compare unequal to the id it came
      // from everywhere downstream - and export as "3" rather than 3.
      else if (propDef.type === 'select' && propDef.numericValue) value = parseInt(rawValue, 10);
      if ((propDef.type === 'int' || propDef.type === 'number') && !Number.isFinite(value)) {
        inputEl.value = ent.props[propDef.key]; // reject nonsense, restore visibly
        return;
      }
      if (value === ent.props[propDef.key]) return;

      pushHistory(state);
      markDirty();
      ent.props[propDef.key] = value;
      viewer.updateEntityProps(ent.id, ent.props);

      // A select OR a bool can change which showIf fields are relevant (Play
      // Mode -> interval bounds; Blur -> Blur Amount) - rebuild the section
      // so they appear/disappear immediately.
      //
      // BOOLS WERE MISSING HERE, which is why ticking Blur or Ghost Trails
      // left their sub-fields hidden until you deselected and reselected the
      // object. Every gating prop on a Post-Process Volume is a checkbox, so
      // the whole entity read as broken.
      //
      // Numbers and text are deliberately NOT in this list: they commit on
      // every change event, and rebuilding the DOM under a field someone is
      // still typing in is how you eat keystrokes. Only the two types that
      // actually gate anything rebuild.
      //
      // Blur first: renderEntityProps skips the rebuild while focus sits
      // inside the section (that same anti-keystroke-eating guard), which
      // would otherwise swallow this very refresh - the checkbox you just
      // clicked holds focus.
      if (propDef.type === 'select' || propDef.type === 'bool') {
        if (inputEl && typeof inputEl.blur === 'function') inputEl.blur();
        renderEntityProps(ent);
      }

      // Unique-ID collisions are soft-validated (warn, don't block), same
      // philosophy as palette rows: the author may be mid-renumber. Keyed by
      // prop name, so spawn/summon share one pool and sounds get their own.
      if (propDef.uniqueId) {
        const taken = state.isUniqueIdTaken(propDef.key, value, ent.id);
        inputEl.classList.toggle('field-warning', taken);
        if (taken) {
          showWarning(
            `${propDef.label} ${value} is already used by another entity. ` +
            'References to it (e.g. a trigger\'s Upon Enter SFX) will resolve to whichever comes first.'
          );
        }
      }
    };

    if (propDef.type === 'bool') {
      const label = document.createElement('label');
      label.className = 'checkbox-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!ent.props[propDef.key];
      checkbox.addEventListener('change', () => commit(checkbox.checked, checkbox));
      const text = document.createElement('span');
      text.textContent = propDef.label;
      label.appendChild(checkbox);
      label.appendChild(text);
      entityPropsBodyEl.appendChild(label);
    } else if (propDef.type === 'select') {
      const label = document.createElement('label');
      label.className = 'field-full';
      label.textContent = propDef.label;
      const select = document.createElement('select');
      // Options are either a STATIC list on the schema (play modes, light
      // types - fixed vocabularies) or built LIVE from current editor state
      // via optionsFrom (the Upon Enter SFX list of this stage's Sound
      // entities). renderEntityProps runs on every updateUI, i.e. after any
      // mutation, so a live list reflects an added/renamed/deleted Sound
      // straight away with no extra plumbing.
      const options = propDef.optionsFrom
        ? propDef.optionsFrom(state)
        : (propDef.options || []);
      for (const opt of options) {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        select.appendChild(optionEl);
      }
      // An unknown stored value falls back to the DEFAULT rather than
      // silently committing whatever the browser picked first. For a live
      // list this is the DANGLING REFERENCE case - the Sound a trigger
      // pointed at was deleted or made music - and showing "(None)" is the
      // honest answer: the reference no longer resolves.
      const current = ent.props[propDef.key];
      const valid = options.some((opt) => opt.value === current);
      select.value = valid ? current : propDef.default;
      select.addEventListener('change', () => commit(select.value, select));
      label.appendChild(select);
      entityPropsBodyEl.appendChild(label);
    } else if (propDef.type === 'color') {
      // Native color swatch. The committed value is the browser's
      // lowercase '#rrggbb' hex string (commit treats it like a string -
      // no numeric parse), which persists verbatim in the project file and
      // round-trips through the schema-default merge on load.
      const label = document.createElement('label');
      label.className = 'field-full';
      label.textContent = propDef.label;
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'color-field';
      input.value = ent.props[propDef.key] ?? '#ffffff';
      input.addEventListener('change', () => commit(input.value, input));
      label.appendChild(input);
      entityPropsBodyEl.appendChild(label);

      // OPTIONAL NUMERIC R/G/B, editing the SAME hex prop as the swatch
      // above. Two representations of one value, deliberately - not two
      // props that have to be kept in step. A swatch is good for choosing a
      // mood and useless for hitting an exact number, which PS1 work is full
      // of (a tint that has to match a texture's palette, a value carried
      // over from another stage).
      //
      // Each box commits the whole recomposed hex string, so the swatch and
      // the numbers can never disagree: there is only one stored value and
      // both editors write it.
      if (propDef.withRgbFields) {
        const hex = ent.props[propDef.key] ?? '#ffffff';
        const cur = [
          parseInt(hex.slice(1, 3), 16) || 0,
          parseInt(hex.slice(3, 5), 16) || 0,
          parseInt(hex.slice(5, 7), 16) || 0,
        ];

        const grid = document.createElement('div');
        grid.className = 'field-grid3';
        ['R', 'G', 'B'].forEach((axis, i) => {
          const cell = document.createElement('label');
          cell.textContent = axis;
          const box = document.createElement('input');
          box.type = 'number';
          box.step = '1';
          box.min = '0';
          box.max = '255';
          box.value = cur[i];
          box.addEventListener('change', () => {
            let v = parseInt(box.value, 10);
            if (!Number.isFinite(v)) return;
            v = Math.max(0, Math.min(255, v));
            const next = cur.slice();
            next[i] = v;
            const toHex = (n) => n.toString(16).padStart(2, '0');
            commit(`#${toHex(next[0])}${toHex(next[1])}${toHex(next[2])}`, box);
          });
          cell.appendChild(box);
          grid.appendChild(cell);
        });
        entityPropsBodyEl.appendChild(grid);
      }
    } else {
      const label = document.createElement('label');
      label.className = 'field-full';
      label.textContent = propDef.label;
      const input = document.createElement('input');
      if (propDef.type === 'string') {
        input.type = 'text';
        input.value = ent.props[propDef.key] ?? '';
      } else {
        input.type = 'number';
        input.step = propDef.type === 'int' ? '1' : '0.1';
        input.value = ent.props[propDef.key];
      }
      if (propDef.uniqueId) {
        input.classList.toggle(
          'field-warning',
          state.isUniqueIdTaken(propDef.key, ent.props[propDef.key], ent.id)
        );
      }
      input.addEventListener('change', () => commit(input.value, input));
      label.appendChild(input);
      entityPropsBodyEl.appendChild(label);
    }
  }
}

/**
 * Rewrite ONLY the numeric transform/camera/palette input fields from
 * state. Extracted from updateUI() so the continuous gizmo-drag path
 * (viewer.onTransformChange above) can refresh what the drag actually
 * changes without rebuilding the whole sidebar DOM per mouse-move.
 */
/**
 * Populate the Animation section for a model instance whose .glb carries
 * clips. Rebuilds the Default-Animation dropdown (None + every clip name in
 * authored order), reflects the stored selection, and disables loop/speed/
 * autoplay while the selection is None (they only mean something once a clip
 * is chosen). Only called when viewer.hasAnimations(inst.model) is true, so
 * the option list is never empty of real clips.
 */
function refreshAnimationFields(inst) {
  const clips = viewer.getModelAnimations(inst.model);
  const anim = inst.anim || {};

  // Rebuild options fresh each time: the selected instance (and therefore the
  // clip set) changes on every selection, and the list is short.
  fAnimDefault.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'None';
  fAnimDefault.appendChild(noneOpt);
  for (const name of clips) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    fAnimDefault.appendChild(opt);
  }

  // If the stored clip is gone (model re-exported without it), show None but
  // flag it - the state value is left untouched until the author recommits.
  const storedMissing = !!anim.clip && !clips.includes(anim.clip);
  fAnimDefault.value = anim.clip && !storedMissing ? anim.clip : '';

  const active = !!fAnimDefault.value;
  fAnimLoop.checked = anim.loop !== false;
  fAnimSpeed.value = Number.isFinite(anim.speed) && anim.speed > 0 ? anim.speed : 1;
  fAnimAutoplay.checked = anim.autoplay !== false;

  fAnimLoop.disabled = !active;
  fAnimSpeed.disabled = !active;
  fAnimAutoplay.disabled = !active;

  if (storedMissing) {
    animHintEl.textContent = `Saved clip "${anim.clip}" is no longer in this model - pick another.`;
    animHintEl.classList.remove('hidden');
  } else if (!active) {
    animHintEl.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} available.`;
    animHintEl.classList.remove('hidden');
  } else {
    animHintEl.classList.add('hidden');
  }
}

function refreshTransformFields() {
  const selectedInst = state.selectedInstanceId !== null ? state.getInstance(state.selectedInstanceId) : null;
  const selectedEnt = !selectedInst && state.selectedInstanceId !== null ? state.getEntity(state.selectedInstanceId) : null;
  const selectedCol = !selectedInst && !selectedEnt && state.selectedInstanceId !== null
    ? state.getCollider(state.selectedInstanceId) : null;
  const selected = selectedInst || selectedEnt;

  // A collision box owns the whole Properties dock while selected: it has no
  // Transform or Appearance of its own, so showing those (belonging to
  // nothing, or worse to the previously selected object) would be misleading.
  colliderFieldsEl.classList.toggle('hidden', !selectedCol);
  if (selectedCol) {
    const owner = state.getInstance(selectedCol.parentInstanceId);
    colliderTargetLabelEl.textContent = colliderDisplayName(selectedCol);
    colliderTargetLabelEl.title = owner
      ? `Collision box on ${instanceDisplayName(owner)}`
      : 'Collision box';

    cCenterX.value = round3(selectedCol.center.x);
    cCenterY.value = round3(selectedCol.center.y);
    cCenterZ.value = round3(selectedCol.center.z);
    cSizeX.value = round3(selectedCol.size.x);
    cSizeY.value = round3(selectedCol.size.y);
    cSizeZ.value = round3(selectedCol.size.z);
    cEnabled.checked = selectedCol.enabled !== false;

    // The id is what a future trigger action addresses this box by, so it is
    // shown rather than hidden as bookkeeping - you need to be able to read
    // it off to wire anything to it.
    cIdHint.textContent =
      `Collider ID ${selectedCol.colliderId} - triggers address this box by that number.`;
  }

  // The Properties dock swaps between the "no selection" placeholder and
  // the object sections; the Stage Camera section below them is always
  // visible regardless. Model instances show Appearance (palette),
  // editor entities show their kind's Parameters section instead.
  // A collider counts as a selection for the placeholder's purposes - its own
  // block above is what's showing - but it must NOT open instance-fields,
  // which describes an instance it isn't.
  propsNoSelectionEl.classList.toggle('hidden', !!selected || !!selectedCol);
  if (selectedCol) {
    instanceFieldsEl.classList.add('hidden');
  } else if (selected) {
    instanceFieldsEl.classList.remove('hidden');
    appearanceSectionEl.classList.toggle('hidden', !selectedInst);
    // Collision is model-instance-only: an entity is a marker with no
    // geometry, and a trigger's volume is authored by its scale rather than
    // by a solidity flag.
    collisionSectionEl.classList.toggle('hidden', !selectedInst);
    // Animation is model-instance-only AND only for models whose .glb actually
    // carried clips - a static model has nothing to author here.
    const instHasAnim = !!selectedInst && viewer.hasAnimations(selectedInst.model);
    animationSectionEl.classList.toggle('hidden', !instHasAnim);
    entityPropsSectionEl.classList.toggle('hidden', !selectedEnt);

    if (selectedInst) {
      propsTargetLabelEl.textContent = instanceDisplayName(selectedInst);
      propsTargetLabelEl.title = `${selectedInst.model} #${selectedInst.id}`; // real identity survives a rename
    } else {
      const def = ENTITY_KINDS[selectedEnt.kind];
      propsTargetLabelEl.textContent = entityDisplayName(selectedEnt);
      propsTargetLabelEl.title = `${def ? def.label : selectedEnt.kind} #${selectedEnt.id}`;
    }

    fPosX.value = round3(selected.pos.x);
    fPosY.value = round3(selected.pos.y);
    fPosZ.value = round3(selected.pos.z);
    fRotX.value = round3(selected.rot.x);
    fRotY.value = round3(selected.rot.y);
    fRotZ.value = round3(selected.rot.z);
    fScaleX.value = round3(selected.scale.x);
    fScaleY.value = round3(selected.scale.y);
    fScaleZ.value = round3(selected.scale.z);

    if (selectedInst) {
      fPalette.value = selectedInst.palette;
      fCollide.checked = selectedInst.collide !== false;

      // Reflect the model's real CLUT row bound on the input itself (QOL):
      // max clamps the spinner arrows/validation to valid rows, while the
      // warning styling still flags values typed past it (max on a number
      // input doesn't block typing, so both remain useful).
      const maxPalette = state.getMaxPaletteForInstance(selectedInst.id);
      fPalette.max = Math.max(0, maxPalette - 1);
      fPalette.classList.toggle('field-warning', selectedInst.palette >= maxPalette);

      // Which collision this instance actually ships with. The fallback is
      // invisible in the tree (it has no rows), so without this line an
      // instance using it looks identical to one with no collision at all.
      const boxes = state.collidersFor(selectedInst.id);
      if (selectedInst.collide === false) {
        colliderCountHintEl.textContent = 'Not solid. Authored boxes are kept but ignored.';
      } else if (boxes.length > 0) {
        const off = boxes.filter((c) => c.enabled === false).length;
        colliderCountHintEl.textContent =
          `${boxes.length} authored box${boxes.length === 1 ? '' : 'es'}` +
          (off > 0 ? `, ${off} starting disabled.` : '.');
      } else {
        colliderCountHintEl.textContent =
          'No authored boxes - falling back to one automatic box per mesh.';
      }

      // Populate the Animation section only when it's actually showing (model
      // carries clips); otherwise its stale contents stay hidden and unread.
      if (instHasAnim) refreshAnimationFields(selectedInst);
    }

    if (selectedEnt) {
      renderEntityProps(selectedEnt);
    }
  } else {
    instanceFieldsEl.classList.add('hidden');
  }

  camPosX.value = round3(state.camera.pos.x);
  camPosY.value = round3(state.camera.pos.y);
  camPosZ.value = round3(state.camera.pos.z);
  camRotX.value = round3(state.camera.rot.x);
  camRotY.value = round3(state.camera.rot.y);
  camRotZ.value = round3(state.camera.rot.z);

  fogEnabled.checked = !!state.fog.enabled;
  fogNear.value = round3(state.fog.near);
  fogFar.value = round3(state.fog.far);
  fogColor.value = state.fog.color;
  fogLayers.value = state.fog.layers;
  fogCull.checked = !!state.fog.cull;
  fogDrift.checked = !!state.fog.drift;
  refreshFogRangeHint();
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
//   #define MAX_STAGE_OBJECTS 32
//   #define MAX_TEXTURES      32
//   #define MAX_MODEL_TRIS    256
const MAINC_LIMITS = {
  models: 16,
  stageObjects: 32,
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
 * stage here IS a broken stage there.
 */
function renderMaincPanel(uniqueTextureCount) {
  // main.c's MAX_MODELS bounds its model table - count DISTINCT models
  // actually referenced by placed instances (what a stage load consumes),
  // not how many happen to be loaded in this editor session.
  const modelsUsed = new Set(state.instances.map((inst) => inst.model)).size;
  const objectsUsed = state.instances.length;

  maincModelsLabel.textContent = `${modelsUsed} / ${MAINC_LIMITS.models}`;
  maincModelsLabel.classList.toggle('limit-danger', modelsUsed > MAINC_LIMITS.models);

  maincObjectsLabel.textContent = `${objectsUsed} / ${MAINC_LIMITS.stageObjects}`;
  maincObjectsLabel.classList.toggle('limit-danger', objectsUsed > MAINC_LIMITS.stageObjects);

  maincTexturesLabel.textContent = `${uniqueTextureCount} / ${MAINC_LIMITS.textures}`;
  maincTexturesLabel.classList.toggle('limit-danger', uniqueTextureCount > MAINC_LIMITS.textures);

  const warnings = [];
  if (objectsUsed > MAINC_LIMITS.stageObjects) {
    warnings.push(`Too many instances: main.c only loads ${MAINC_LIMITS.stageObjects} stage objects.`);
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
  // least one instance has been placed - an empty stage.json with zero
  // objects is technically valid JSON but not a useful export target, so
  // we gate on there being something to actually export.
  btnExportStage.disabled = !(state.models.size > 0 && state.instances.length > 0);

  if (window.__stageGenDiscoveredModels) {
    renderModelList(window.__stageGenDiscoveredModels);
  }

  renderInstanceList();

  refreshTransformFields();

  // Collider boxes follow instance transforms, the Collide flag, and the
  // instance set - all of which are exactly what a re-render means. No-ops
  // when the overlay is off.
  refreshColliderOverlay();

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
// Fog Near/Far are world distances in the same viewport units as position,
// so they share POSITION_SENSITIVITY. Scrubbing these is the whole point of
// the panel - fog is a look you dial in by eye against the PS1 preview, not
// a number you can reason your way to. (fogLayers is deliberately NOT
// scrubbable, for the same reason fPalette isn't: it's a 0-6 integer where
// landing on a specific value matters more than sweeping through the range.)
[fogNear, fogFar].forEach((el) =>
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
// Left dock tabs (.NET-style tab strip: Assets | Instances | VRAM)
// ==========================================================================
//
// Pure show/hide switching - every page's DOM stays alive (and its ids
// stay queryable) whether or not it's the visible tab, so none of the
// existing render functions above needed to change for the tabbed layout.
// data-tab on each button names the page element id it reveals.

const dockTabButtons = Array.from(document.querySelectorAll('.dock-tab[data-tab]'));

for (const tabBtn of dockTabButtons) {
  tabBtn.addEventListener('click', () => {
    for (const btn of dockTabButtons) {
      btn.classList.toggle('is-active', btn === tabBtn);
      document.getElementById(btn.dataset.tab).classList.toggle('hidden', btn !== tabBtn);
    }
  });
}

// ==========================================================================
// Shortcuts popover (toolbar "?")
// ==========================================================================

const btnShortcuts = document.getElementById('btn-shortcuts');
const shortcutsPopoverEl = document.getElementById('shortcuts-popover');

btnShortcuts.addEventListener('click', (evt) => {
  evt.stopPropagation(); // keep the document-level close handler below from instantly re-hiding it
  const opening = shortcutsPopoverEl.classList.contains('hidden');
  if (opening) {
    // Anchor just under the "?" button, wherever the toolbar wrapped to.
    const rect = btnShortcuts.getBoundingClientRect();
    shortcutsPopoverEl.style.top = `${Math.round(rect.bottom + 6)}px`;
  }
  shortcutsPopoverEl.classList.toggle('hidden');
  btnShortcuts.classList.toggle('is-active', opening);
});

// Click anywhere outside (including the viewport) dismisses it - it's
// reference material, not a mode, so it should never need explicit closing.
document.addEventListener('click', (evt) => {
  if (shortcutsPopoverEl.classList.contains('hidden')) return;
  if (shortcutsPopoverEl.contains(evt.target)) return;
  shortcutsPopoverEl.classList.add('hidden');
  btnShortcuts.classList.remove('is-active');
});

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
// Seed the viewport from the initial StageState BEFORE the first paint -
// the constructor pre-places entities (the default directional "Sun"), and
// nothing else calls resync at boot, so without this they'd exist in state
// (and the tree) but never render in 3D.
resyncViewportFromState();
updateUI();
