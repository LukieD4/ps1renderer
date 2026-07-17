/*
 * viewer.js
 *
 * Three.js viewport module for scene-gen. This is a module-level singleton
 * (there is only ever one <canvas id="viewport-canvas"> on the page), so
 * rather than exporting a class we keep viewer state in module-scope
 * variables and export plain functions that operate on it - simpler for
 * app.js to consume than threading a viewer instance through everything.
 *
 * COORDINATE SPACE NOTE: everything in this module operates in "viewport
 * space", which is the SAME space the source .obj files were authored in
 * (Blender: Forward=-Z, Up=Y). Three.js's default world orientation is
 * already Y-up, so no special camera/scene rotation is needed to make the
 * viewport "feel like Blender" - we just don't apply the renderer-space
 * coordinate remap here at all. That remap only happens at export time,
 * in scene_export.js.
 */

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const CAMERA_GIZMO_ID = '__camera__';

// ---- module-level viewer state ----
let renderer = null;
let scene = null;
let editCamera = null; // the camera we look through while editing (not the exported PS1 camera)
let orbitControls = null;
let transformControls = null;
let raycaster = null;
let canvas = null;

// ---- axis gizmo (Blender-style orientation cube, top-right overlay) ----
let gizmoRenderer = null;
let gizmoScene = null;
let gizmoCamera = null;
let gizmoCanvas = null;
let gizmoRaycaster = null;
const gizmoAxisMeshes = []; // { mesh, dir: THREE.Vector3, label } - the 6 clickable axis balls

// Default orbit framing, reused by "Reset View" and as the starting pose.
// Kept as a named constant (not just inlined into initViewer()) so
// resetViewportCamera() can restore exactly this later without duplicating
// the numbers.
const DEFAULT_VIEW = { position: new THREE.Vector3(6, 5, 10), target: new THREE.Vector3(0, 0, 0) };

let cameraGizmo = null; // small cone mesh representing the exported PS1 camera's transform
let grid = null; // GridHelper, kept module-level so toggleGridVisible() can reach it

// modelName -> triangle count of the parsed template (computed once at
// load time in loadModelIntoScene, displayed in the sidebar model list).
const modelTriCounts = new Map();

// modelName -> parsed template Object3D (never added to `scene` directly, only cloned)
const modelTemplates = new Map();

// instanceId -> { object3D, modelName, materialTimData: Map<materialName, decodedTim> }
const instances = new Map();

let selectionChangeCallback = null;
let transformChangeCallback = null;
let dragStartCallback = null; // fired once when a gizmo drag BEGINS (see onDragStart() below) - used by app.js's undo history

let currentTransformTarget = null; // 'id' of whatever TransformControls is currently attached to (or CAMERA_GIZMO_ID)

// See the 'dragging-changed' listener in initViewer() for why this exists:
// swallows the single synthetic 'click' event that follows a gizmo drag's
// mouseup, so releasing a drag doesn't reassign selection to whatever
// geometry happens to be under the cursor at the drop point.
let suppressNextClick = false;

/**
 * Build a THREE.DataTexture from a decoded .tim's RGBA pixel data for a
 * given palette row. NearestFilter is used (not linear) to preserve the
 * PS1's blocky, unfiltered look rather than smoothing texels together.
 *
 * ----------------------------------------------------------------------
 * flipY - traced end-to-end against py_convert_assets.py (the ONLY other
 * place in this whole toolchain that touches V), not guessed:
 * ----------------------------------------------------------------------
 *   1. OBJLoader.parse() (used in loadModelIntoScene() below) loads 'vt'
 *      lines completely RAW, with zero modification. Raw OBJ V uses the
 *      OBJ/Blender convention: v=0 is the BOTTOM of the texture as the
 *      artist sees it in their image editor.
 *   2. py_convert_assets.py's get_split_vertex() (the PS1-side model
 *      converter - the only authority on what "the .tim's pixel rows"
 *      are supposed to mean) explicitly flips every UV it emits:
 *          split_vert_uvs.append((u, 1.0 - v))
 *      with the comment "OBJ UV convention has v=0 at the BOTTOM ...
 *      the PS1 GPU has v=0 at the TOP". So row 0 of the .tim's pixel
 *      data (and tim_reader.js's decodeTim(), which reads rows in the
 *      file's own top-to-bottom order) corresponds to v=1 in RAW OBJ UV
 *      space, not v=0.
 *   3. Therefore: raw OBJ v=0 (bottom of the artist's image, and what
 *      OBJLoader's untouched UVs actually carry) must sample the LAST
 *      row of the decoded .tim buffer, and v=1 must sample row 0 - i.e.
 *      the geometry's UV space and the .tim's pixel-row space are
 *      OPPOSITE conventions, one full vertical flip apart.
 *   4. THREE.Texture's default (flipY = true) is exactly that flip: it
 *      samples v=0 from the LAST row of the raw pixel buffer and v=1
 *      from row 0. That is the correct behavior here, matching step 3 -
 *      NOT an unwanted double-flip. (An earlier fix in this file set
 *      flipY = false believing decodeTim()'s already-top-down row order
 *      meant no further flip was needed; that reasoning skipped step 2 -
 *      the Python converter's OWN flip - which is what actually governs
 *      what "row 0" means relative to the geometry's raw UVs. flipY must
 *      stay at Three's default of true.)
 *
 * DataTexture does not flip by default in older Three versions the way
 * regular image-loaded textures do, so flipY is set explicitly to true
 * here rather than left implicit, to make this correct-by-construction
 * regardless of Three.js version defaults.
 */
function buildDataTexture(decodedTim, row) {
  const rgba = decodedTim.getRGBATextureForRow(row);
  const texture = new THREE.DataTexture(rgba, decodedTim.width, decodedTim.height, THREE.RGBAFormat);
  texture.flipY = true;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Initialize the renderer, scene, cameras, lights, grid, and controls.
 * Call once at app startup with the main viewport <canvas> and the small
 * overlay <canvas> the axis orientation gizmo renders into (top-right
 * corner, see tool.css #viewport-gizmo-canvas).
 */
export function initViewer(canvasEl, gizmoCanvasEl) {
  canvas = canvasEl;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1e);

  editCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
  editCamera.position.set(6, 5, 10);
  editCamera.lookAt(0, 0, 0);

  orbitControls = new OrbitControls(editCamera, canvas);
  orbitControls.target.set(0, 0, 0);
  orbitControls.update();

  // GridHelper: 20 units spanning, 1-unit divisions. 1 grid unit == 1
  // Blender/OBJ unit == 1024 exported PS1 units, so this grid gives the
  // artist a sense of scale that lines up with the export math.
  grid = new THREE.GridHelper(20, 20);
  scene.add(grid);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7.5);
  scene.add(dirLight);

  transformControls = new TransformControls(editCamera, canvas);
  scene.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);

  // Hold Ctrl while dragging = snap to grid (1 unit, matching the
  // GridHelper's 1-unit divisions and therefore 1024 exported PS1 units).
  // Two mechanisms cover the two drag styles:
  //   - TransformControls' built-in translationSnap handles the axis
  //     arrows and plane squares (it quantizes while the modifier is
  //     held, live, mid-drag - the standard Blender-like feel).
  //   - The surface-snap drag (white center square) reads ctrlSnapHeld
  //     directly in applySurfaceSnapDrag(), rounding the landed X/Z to
  //     whole units while leaving Y surface-derived, so a Ctrl-snapped
  //     crate still sits flat on the shelf it landed on.
  // The window blur listener clears the state so alt-tabbing away with
  // Ctrl held can't leave snapping stuck on.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Control') {
      ctrlSnapHeld = true;
      transformControls.translationSnap = snapIncrement;
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Control') {
      ctrlSnapHeld = false;
      transformControls.translationSnap = null;
    }
  });
  window.addEventListener('blur', () => {
    ctrlSnapHeld = false;
    transformControls.translationSnap = null;
  });

  // Standard TransformControls pattern: while the user is dragging a
  // gizmo handle, OrbitControls must be disabled, otherwise the orbit
  // drag and the gizmo drag fight over the same mouse input and the
  // camera spins uncontrollably while trying to move/rotate an object.
  //
  // This listener ALSO fixes the "releasing a drag reassigns selection to
  // whatever's behind the object" bug: mouse-down + mouse-up on the canvas
  // always fires a native 'click' event on release, even when that
  // mouse-down/up pair was actually a gizmo drag, not an intentional
  // click-to-select. onCanvasClick (below) raycasts from the RELEASE
  // position, so that stray click picks whatever geometry happens to be
  // under the cursor at drop time - frequently something other than (or
  // "behind") the object that was just being dragged, which is exactly
  // the reported symptom. suppressNextClick latches true the instant a
  // drag starts and is consumed (reset to false) by the very next click,
  // so the synthetic post-drag click is swallowed while genuine clicks
  // afterward behave normally.
  transformControls.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value;
    if (event.value) {
      suppressNextClick = true;
      // Fire exactly once per drag GESTURE (not per frame - 'objectChange'
      // below fires continuously while dragging), so app.js's undo history
      // can snapshot the pre-drag state once and let the whole drag be a
      // single undoable step, instead of every intermediate mouse-move
      // position becoming its own undo entry.
      if (dragStartCallback) dragStartCallback(currentTransformTarget);
    }
  });

  transformControls.addEventListener('objectChange', () => {
    if (!currentTransformTarget || !transformChangeCallback) return;

    // SURFACE-SNAP DRAG: the white center square of the translate gizmo
    // (TransformControls' 'XYZ' handle) normally moves the object in the
    // camera-facing screen plane - which makes it trivially easy to fling
    // an object into the void/sky with no depth reference. Rewired here:
    // while THAT handle (and only that handle - the per-axis arrows and
    // plane squares behave exactly as before) is being dragged on an
    // instance, the object instead follows the cursor's raycast onto the
    // faces of every OTHER instance (floor, shelf, another crate...),
    // resting flat on the hit face via its bounding box. TransformControls
    // has already applied its own screen-plane position for this event;
    // applySurfaceSnapDrag() overwrites it before the state callback below
    // reads the transform, so the state/UI only ever see the snapped
    // position.
    if (
      transformControls.mode === 'translate' &&
      transformControls.axis === 'XYZ' &&
      currentTransformTarget !== CAMERA_GIZMO_ID
    ) {
      applySurfaceSnapDrag(currentTransformTarget);
    }

    // Seam snap (sidebar tickbox): after whichever positioning path ran
    // above - surface-snap drag or TransformControls' own axis/plane
    // translation - pull the dragged object flush against neighboring
    // objects' bounding boxes so touching faces meet with zero gap and
    // zero overlap. Runs last so it wins over grid rounding when both
    // are active (a seam within the threshold beats a grid line).
    if (
      seamSnapEnabled &&
      transformControls.mode === 'translate' &&
      currentTransformTarget !== CAMERA_GIZMO_ID
    ) {
      applySeamSnap(currentTransformTarget);
    }

    if (currentTransformTarget === CAMERA_GIZMO_ID) {
      transformChangeCallback(CAMERA_GIZMO_ID, getCameraTransform());
    } else {
      transformChangeCallback(currentTransformTarget, getInstanceTransform(currentTransformTarget));
    }
  });

  // PS1 camera gizmo: a simple wireframe cone standing in for the
  // exported camera's position/rotation. A full THREE.CameraHelper wants
  // a real camera object wired into the render pipeline, which is more
  // machinery than we need just to show "here's where the PS1 camera is
  // and which way it points" - a cone pointing along -Z is enough.
  const gizmoGeometry = new THREE.ConeGeometry(0.3, 0.8, 8);
  gizmoGeometry.rotateX(Math.PI / 2); // point the cone's tip along -Z (matches Blender forward)
  const gizmoMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc00, wireframe: true });
  cameraGizmo = new THREE.Mesh(gizmoGeometry, gizmoMaterial);
  cameraGizmo.position.set(0, 2, 8);
  cameraGizmo.rotation.x = THREE.MathUtils.degToRad(-20);
  scene.add(cameraGizmo);

  raycaster = new THREE.Raycaster();
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('click', onCanvasClick);

  // Keep the cursor's normalized device coords continuously up to date -
  // the surface-snap drag (see applySurfaceSnapDrag) needs to raycast
  // from wherever the mouse currently is DURING a TransformControls drag,
  // and TransformControls' own events don't expose the pointer position.
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    lastPointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
  });

  if (gizmoCanvasEl) initAxisGizmo(gizmoCanvasEl);

  window.addEventListener('resize', () => {
    handleResize();
    handleGizmoResize();
  });
  handleResize();

  // W/E/R shortcuts for transform mode. Owned here (rather than app.js)
  // since viewer.js already owns the TransformControls instance.
  //
  // NOTE: while freecam is active, W is claimed by FPS-style forward
  // movement instead (see initFreecam() below) - the transform-mode
  // shortcut branch below explicitly skips itself when freecamActive is
  // true so W/E/R don't fight between "move camera forward" and "switch
  // gizmo mode" at the same time.
  window.addEventListener('keydown', (event) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack typing in number fields
    if (freecamActive) return;

    if (event.key === 'w' || event.key === 'W') setTransformMode('translate');
    else if (event.key === 'e' || event.key === 'E') setTransformMode('rotate');
    else if (event.key === 'r' || event.key === 'R') setTransformMode('scale');
  });

  initFreecam();

  renderLoop();
}

function handleResize() {
  if (!canvas || !renderer || !editCamera) return;
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  renderer.setSize(width, height, false);
  editCamera.aspect = width / height;
  editCamera.updateProjectionMatrix();
}

let lastFrameTime = performance.now();

function renderLoop() {
  requestAnimationFrame(renderLoop);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // clamp so a tab-switch stall doesn't fling the camera
  lastFrameTime = now;

  if (freecamActive) {
    updateFreecam(dt);
  } else {
    orbitControls.update();
  }

  // Live billboard preview: any billboard entity with trackCamera on
  // yaw-follows the edit camera every frame (Y-axis billboarding, the
  // PS1 sprite convention), offset by its pivotAngle prop. This
  // deliberately overrides manual Y rotation while tracking is enabled -
  // that IS what the flag means at runtime.
  for (const inst of instances.values()) {
    if (!inst.isEntity || inst.kind !== 'billboard' || !inst.props.trackCamera) continue;
    const obj = inst.object3D;
    obj.rotation.y =
      Math.atan2(editCamera.position.x - obj.position.x, editCamera.position.z - obj.position.z) +
      THREE.MathUtils.degToRad(inst.props.pivotAngle || 0);
  }

  renderer.render(scene, editCamera);
  renderAxisGizmo();
}

// ==========================================================================
// Axis orientation gizmo (Blender-style, top-right viewport overlay)
// ==========================================================================
//
// Six colored balls on the end of three axis stalks (+X/-X/+Y/-Y/+Z/-Z),
// rendered in its OWN small scene/camera/renderer that always mirrors the
// main editCamera's ORIENTATION (not position - the gizmo camera is fixed
// at a constant distance looking at the origin, only its rotation is
// copied every frame) - exactly like Blender's viewport gizmo: it shows
// you which way you're facing, and clicking a ball snaps the main
// orbit camera to look straight down that axis.

const GIZMO_AXES = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xff4d4d, label: 'X' },
  { dir: new THREE.Vector3(-1, 0, 0), color: 0x802626, label: '-X' },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x4dff4d, label: 'Y' },
  { dir: new THREE.Vector3(0, -1, 0), color: 0x268026, label: '-Y' },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x4d88ff, label: 'Z' },
  { dir: new THREE.Vector3(0, 0, -1), color: 0x264880, label: '-Z' },
];

function initAxisGizmo(gizmoCanvasEl) {
  gizmoCanvas = gizmoCanvasEl;

  gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
  gizmoRenderer.setPixelRatio(window.devicePixelRatio || 1);

  gizmoScene = new THREE.Scene();

  // Orthographic so the gizmo doesn't get perspective-distorted at this
  // tiny size, and fixed at a constant distance from the origin - only
  // its ROTATION is updated per-frame (copied from editCamera), never its
  // position/zoom, which is what makes it read as "a compass" rather than
  // a second navigable viewport.
  gizmoCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  gizmoCamera.position.set(0, 0, 4);

  gizmoScene.add(new THREE.AmbientLight(0xffffff, 1.0));

  // Thin stalks from the origin to each axis ball, so the gizmo reads as
  // "spokes" rather than 6 disconnected floating dots (matches Blender's
  // own look).
  for (const axis of GIZMO_AXES) {
    const stalkGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      axis.dir.clone().multiplyScalar(0.9),
    ]);
    const stalk = new THREE.Line(stalkGeom, new THREE.LineBasicMaterial({ color: axis.color }));
    gizmoScene.add(stalk);

    const ballGeom = new THREE.SphereGeometry(0.28, 16, 16);
    const ballMat = new THREE.MeshBasicMaterial({ color: axis.color });
    const ball = new THREE.Mesh(ballGeom, ballMat);
    ball.position.copy(axis.dir).multiplyScalar(0.9);
    gizmoScene.add(ball);

    gizmoAxisMeshes.push({ mesh: ball, dir: axis.dir, label: axis.label });
  }

  gizmoRaycaster = new THREE.Raycaster();
  gizmoCanvas.addEventListener('click', onGizmoClick);

  handleGizmoResize();
}

function handleGizmoResize() {
  if (!gizmoCanvas || !gizmoRenderer) return;
  const size = gizmoCanvas.clientWidth || 90;
  gizmoRenderer.setSize(size, size, false);
}

function renderAxisGizmo() {
  if (!gizmoRenderer || !gizmoScene || !gizmoCamera || !editCamera) return;

  // Copy ONLY the main camera's orientation (via lookAt from a fixed
  // distance along the same direction), not its position - see this
  // section's header comment for why.
  const dir = new THREE.Vector3();
  editCamera.getWorldDirection(dir);
  gizmoCamera.position.copy(dir).multiplyScalar(-4);
  gizmoCamera.lookAt(0, 0, 0);
  gizmoCamera.up.copy(editCamera.up);

  gizmoRenderer.render(gizmoScene, gizmoCamera);
}

function onGizmoClick(event) {
  const rect = gizmoCanvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  gizmoRaycaster.setFromCamera(ndc, gizmoCamera);
  const hits = gizmoRaycaster.intersectObjects(gizmoAxisMeshes.map((a) => a.mesh));
  if (hits.length === 0) return;

  const hitEntry = gizmoAxisMeshes.find((a) => a.mesh === hits[0].object);
  if (!hitEntry) return;

  snapViewportCameraToAxis(hitEntry.dir);
}

/**
 * Snap the editing orbit camera to look straight down the given axis
 * direction, preserving the current distance from the orbit target (so
 * "Front"/"Top"/"Side"/clicking a gizmo ball all feel like re-framing the
 * SAME scene rather than resetting zoom too).
 *
 * ----------------------------------------------------------------------
 * WHY THIS NEVER TOUCHES editCamera.up (fixes the "drunk controls" bug)
 * ----------------------------------------------------------------------
 * OrbitControls builds an internal quaternion basis FROM object.up ONCE,
 * at construction time, and reuses that cached basis for every subsequent
 * drag gesture - it has no code path that re-reads object.up later. The
 * previous version of this function called editCamera.up.set(...) to dodge
 * the gimbal-lock case (looking straight down +Y/-Y, where forward and up
 * would go parallel), which desynced the camera's actual up vector from
 * OrbitControls' cached basis - every drag after clicking the Top/Bottom
 * gizmo ball then rotated around the WRONG axis, exactly the "drunk
 * controls" behavior reported. OrbitControls' up vector must never change
 * after construction; it stays fixed at (0,1,0) for this camera's entire
 * lifetime. The gimbal-lock case is instead avoided by nudging the target
 * position itself a hair off the exact vertical axis, which keeps forward
 * and up from ever going fully parallel without ever touching `up`.
 */
function snapViewportCameraToAxis(direction) {
  if (!editCamera || !orbitControls) return;

  const distance = editCamera.position.distanceTo(orbitControls.target);
  const snapDir = direction.clone();

  // Tiny epsilon nudge on the X axis when looking straight down +Y/-Y -
  // keeps the camera's forward vector a hair off parallel with the fixed
  // (0,1,0) up vector, avoiding degenerate lookAt/orbit math without ever
  // reassigning editCamera.up (see header comment for why that matters).
  if (Math.abs(direction.y) > 0.999) {
    snapDir.x += 0.0001;
    snapDir.normalize();
  }

  const newPos = orbitControls.target.clone().addScaledVector(snapDir, distance);
  editCamera.position.copy(newPos);
  orbitControls.update();
}

/**
 * Reset the editing orbit camera to its default startup framing.
 */
export function resetViewportCamera() {
  if (!editCamera || !orbitControls) return;
  editCamera.position.copy(DEFAULT_VIEW.position);
  orbitControls.target.copy(DEFAULT_VIEW.target);
  orbitControls.update();
}

/**
 * Snap the editing orbit camera to a named preset view ('front' | 'top' |
 * 'side'), matching Blender's Numpad 1/7/3 views. Uses the SAME axis-snap
 * logic as clicking the gizmo, just with a fixed direction instead of
 * whichever ball was clicked.
 */
export function setViewportView(preset) {
  const DIRS = {
    front: new THREE.Vector3(0, 0, 1), // looking down -Z, matches Blender's Numpad 1
    top: new THREE.Vector3(0, 1, 0), // looking down -Y, matches Blender's Numpad 7
    side: new THREE.Vector3(1, 0, 0), // looking down -X, matches Blender's Numpad 3
  };
  const dir = DIRS[preset];
  if (!dir) {
    console.warn(`setViewportView: unknown preset "${preset}"`);
    return;
  }
  snapViewportCameraToAxis(dir);
}

// Pixel distance (down-position to up-position) beyond which a
// mousedown-then-mouseup pair on the canvas is treated as a camera-orbit
// DRAG rather than a genuine click-to-select. Matches the same
// disambiguation pattern drag_scrub.js uses for numeric fields.
const CLICK_DRAG_THRESHOLD_PX = 5;

let canvasMouseDownPos = null; // {x, y} at the most recent mousedown, or null

function onCanvasMouseDown(event) {
  canvasMouseDownPos = { x: event.clientX, y: event.clientY };
}

function onCanvasClick(event) {
  if (suppressNextClick) {
    suppressNextClick = false;
    canvasMouseDownPos = null;
    return;
  }

  // OrbitControls listens to raw mousedown/mousemove/mouseup on this same
  // canvas to rotate the edit camera, and does NOT expose a "was that a
  // drag" flag of its own - the browser still fires a native 'click' on
  // mouseup regardless of whether the mouse moved in between, so orbiting
  // the camera and releasing over an object was reassigning selection to
  // whatever ended up under the cursor (the reported "still accidentally
  // clicking on objects" bug - the SAME class of problem the
  // suppressNextClick/TransformControls fix above already solved for
  // gizmo drags, just for OrbitControls' camera-orbit drag instead). If
  // the mouse moved more than the threshold between this click's
  // mousedown and now, treat it as the tail end of an orbit drag and
  // skip the raycast/selection entirely.
  if (canvasMouseDownPos) {
    const dist = Math.hypot(event.clientX - canvasMouseDownPos.x, event.clientY - canvasMouseDownPos.y);
    canvasMouseDownPos = null;
    if (dist > CLICK_DRAG_THRESHOLD_PX) return;
  }

  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  raycaster.setFromCamera(ndc, editCamera);

  const targets = [cameraGizmo];
  const idByObject = new Map();
  idByObject.set(cameraGizmo, CAMERA_GIZMO_ID);

  for (const [id, inst] of instances.entries()) {
    targets.push(inst.object3D);
    idByObject.set(inst.object3D, id);
  }

  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length === 0) {
    if (selectionChangeCallback) selectionChangeCallback(null);
    return;
  }

  // Walk up from the hit mesh to find which top-level tracked object it
  // belongs to (instance root or the camera gizmo itself).
  let hitObject = hits[0].object;
  let matchedId = null;
  while (hitObject) {
    if (idByObject.has(hitObject)) {
      matchedId = idByObject.get(hitObject);
      break;
    }
    hitObject = hitObject.parent;
  }

  if (selectionChangeCallback) selectionChangeCallback(matchedId);
}

// ==========================================================================
// Surface-snap drag (white center square of the translate gizmo)
// ==========================================================================

// Simulated world bounding box: no matter what the cursor/raycast does,
// a snap-dragged object can never leave this volume - the requested
// safety net against objects flying off into the void/sky/horizon. Sized
// generously relative to the 20-unit grid so it never fights legitimate
// layouts, while still keeping everything findable.
const SNAP_DRAG_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-60, -60, -60),
  new THREE.Vector3(60, 60, 60)
);

// Ground fallback: when the cursor isn't over any other instance's face,
// the drag slides the object along the world floor (y=0, where the grid
// lives) instead of the camera-facing screen plane. This is what makes
// empty-space drags feel grounded rather than depth-ambiguous.
const SNAP_DRAG_GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const snapDragRaycaster = new THREE.Raycaster();
const lastPointerNdc = new THREE.Vector2();

// True while Ctrl is held - toggled by the keydown/keyup/blur listeners
// in initViewer(). Read by applySurfaceSnapDrag() for grid quantization;
// the axis/plane handles get the same behavior via TransformControls'
// own translationSnap, set in the same listeners.
let ctrlSnapHeld = false;

// Grid snap increment (viewport units) used by Ctrl-drag snapping - both
// TransformControls' translationSnap and the surface-drag rounding.
// Configurable from the sidebar's "Grid Snap" field via setSnapIncrement().
let snapIncrement = 1;

/**
 * Set the Ctrl-drag grid snap increment. Values <= 0 / NaN fall back to
 * 1. If Ctrl is currently held mid-drag, the live translationSnap is
 * updated too so the change applies immediately.
 */
export function setSnapIncrement(value) {
  snapIncrement = Number.isFinite(value) && value > 0 ? value : 1;
  if (ctrlSnapHeld && transformControls) transformControls.translationSnap = snapIncrement;
}

// ---- seam snap ("touch seamlessly to vertices") ----
//
// When enabled (sidebar tickbox), any translate drag pulls the dragged
// object's world AABB flush against nearby instances' AABBs: within
// SEAM_SNAP_THRESHOLD units, a face-to-face gap closes to EXACTLY zero
// (house A touches house B, no overlap and no sliver of daylight), and
// nearly-aligned edges line up exactly (a row of houses sharing a
// frontline). Axis-aligned boxes rather than true per-vertex matching -
// right for this pipeline's box-y architectural assets and cheap enough
// to run on every drag event.
let seamSnapEnabled = false;
const SEAM_SNAP_THRESHOLD = 0.35; // units within which edges attract

export function setSeamSnapEnabled(enabled) {
  seamSnapEnabled = !!enabled;
}

/**
 * Nudge the dragged instance so its AABB sits flush with neighboring
 * instances' AABBs. Per axis, candidate snaps are: TOUCH (my min to your
 * max / my max to your min - closes the gap between adjacent objects)
 * and ALIGN (min-to-min / max-to-max - lines edges up). A candidate on
 * one axis only applies if the two boxes actually overlap on the OTHER
 * two axes - otherwise distant, unrelated objects would yank the drag
 * around. The smallest in-threshold delta per axis wins.
 */
function applySeamSnap(id) {
  const inst = instances.get(id);
  if (!inst) return;
  const obj = inst.object3D;

  const dragged = new THREE.Box3().setFromObject(obj);
  if (dragged.isEmpty()) return;

  const AXES = ['x', 'y', 'z'];
  const best = { x: null, y: null, z: null }; // smallest |delta| per axis

  const overlaps = (boxA, boxB, axis) =>
    boxA.min[axis] < boxB.max[axis] && boxA.max[axis] > boxB.min[axis];

  for (const [otherId, other] of instances.entries()) {
    if (otherId === id) continue;
    if (other.isEntity) continue; // entity markers must not attract seam snapping
    const box = new THREE.Box3().setFromObject(other.object3D);
    if (box.isEmpty()) continue;

    for (const axis of AXES) {
      const [oa, ob] = AXES.filter((a) => a !== axis);
      // Require real adjacency on the other two axes - either already
      // overlapping, or within snapping distance of overlapping.
      if (!overlaps(dragged, box, oa) || !overlaps(dragged, box, ob)) continue;

      const candidates = [
        box.max[axis] - dragged.min[axis], // touch: my low side against your high side
        box.min[axis] - dragged.max[axis], // touch: my high side against your low side
        box.min[axis] - dragged.min[axis], // align low edges
        box.max[axis] - dragged.max[axis], // align high edges
      ];
      for (const delta of candidates) {
        if (Math.abs(delta) > SEAM_SNAP_THRESHOLD) continue;
        if (best[axis] === null || Math.abs(delta) < Math.abs(best[axis])) {
          best[axis] = delta;
        }
      }
    }
  }

  for (const axis of AXES) {
    if (best[axis] !== null) obj.position[axis] += best[axis];
  }
}

/**
 * Place the dragged instance flat onto whatever surface is under the
 * cursor. "Flat" means: its world bounding box rests against the hit
 * face, offset along the face's world normal by the box's support
 * distance (sum of half-extents weighted by |normal| per axis - the
 * exact distance at which an AABB touches a plane). So dragging a crate
 * over the floor sits it ON the floor, over a shelf sits it ON the
 * shelf, over another crate stacks it ON that crate; dragging over a
 * wall face rests it AGAINST the wall.
 *
 * The dragged instance's own meshes are excluded from the raycast
 * (otherwise the object would "hit itself" as it follows the cursor).
 * If neither another instance nor the ground plane is under the cursor
 * (e.g. aiming at the sky), the object simply stays where it is - no
 * position is ever derived from a depth-less screen-plane guess.
 *
 * Returns true if a surface (instance face or ground plane) was under
 * the ray and the object was placed against it, false on the sky/void
 * path. The gizmo-drag caller ignores this; the asset-placement exports
 * below use it to decide whether a fallback position is needed.
 */
function applySurfaceSnapDrag(id) {
  const inst = instances.get(id);
  if (!inst) return false;
  const obj = inst.object3D;

  snapDragRaycaster.setFromCamera(lastPointerNdc, editCamera);

  // Raycast against every OTHER instance's meshes. Entity markers are
  // excluded - a dragged crate must never come to rest ON a trigger
  // volume or spawn cone, only on real world geometry.
  const targets = [];
  for (const [otherId, other] of instances.entries()) {
    if (otherId === id) continue;
    if (other.isEntity) continue;
    other.object3D.traverse((child) => {
      if (child.isMesh) targets.push(child);
    });
  }

  let hitPoint = null;
  const hitNormal = new THREE.Vector3(0, 1, 0);

  const hits = targets.length > 0 ? snapDragRaycaster.intersectObjects(targets, false) : [];
  if (hits.length > 0 && hits[0].face) {
    hitPoint = hits[0].point.clone();
    // Face normal is in the hit object's local space - bring it to world
    // space, and flip it toward the camera if the ray struck a backface
    // (DoubleSide materials make backface hits possible) so the object
    // always lands on the side the user can actually see.
    hitNormal.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld).normalize();
    if (hitNormal.dot(snapDragRaycaster.ray.direction) > 0) hitNormal.negate();
  } else {
    // No model under the cursor - fall back to the world floor.
    const planePoint = new THREE.Vector3();
    if (snapDragRaycaster.ray.intersectPlane(SNAP_DRAG_GROUND_PLANE, planePoint)) {
      hitPoint = planePoint;
      hitNormal.set(0, 1, 0);
    }
  }

  if (!hitPoint) {
    // Aiming at the sky/void: hold the object at its current (already
    // valid) position rather than letting it fly off - just re-clamp.
    obj.position.copy(SNAP_DRAG_BOUNDS.clampPoint(obj.position, new THREE.Vector3()));
    return false;
  }

  // Current world bounding box -> where the object's ORIGIN sits relative
  // to the box center, and the box's support distance along the normal.
  // Recomputed per event (not cached at drag start) so mid-drag scale/
  // rotation state is always respected; Box3.setFromObject over one
  // instance is cheap at this tool's model sizes.
  const bbox = new THREE.Box3().setFromObject(obj);
  if (bbox.isEmpty()) return false;
  const center = bbox.getCenter(new THREE.Vector3());
  const halfExt = bbox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const centerOffset = center.sub(obj.position); // origin -> bbox-center offset

  // Support distance of an AABB along a unit normal: how far the box
  // center must sit from the plane for the box to just touch it.
  const supportDist =
    halfExt.x * Math.abs(hitNormal.x) +
    halfExt.y * Math.abs(hitNormal.y) +
    halfExt.z * Math.abs(hitNormal.z);

  const newPos = hitPoint
    .addScaledVector(hitNormal, supportDist)
    .sub(centerOffset);

  // Ctrl held: quantize the landed position to the grid (snapIncrement
  // units, configurable in the sidebar) on X/Z. Y stays exactly as the
  // surface placement computed it - rounding Y would lift the object off
  // (or sink it into) whatever it just landed on, defeating the "rests
  // flat on the hit face" guarantee.
  if (ctrlSnapHeld) {
    newPos.x = Math.round(newPos.x / snapIncrement) * snapIncrement;
    newPos.z = Math.round(newPos.z / snapIncrement) * snapIncrement;
  }

  obj.position.copy(SNAP_DRAG_BOUNDS.clampPoint(newPos, new THREE.Vector3()));
  return true;
}

// ==========================================================================
// Asset placement (drag an asset onto the viewport / double-click an asset)
// ==========================================================================

/**
 * Place a just-created instance at the surface under a SCREEN point
 * (client coordinates, e.g. from a drop event) - the exact same "rests
 * flat against whatever face is there, ground plane as fallback,
 * Ctrl-grid quantization, world-bounds clamp" behavior as the translate
 * gizmo's center-square surface drag, because it IS that code:
 * applySurfaceSnapDrag() aimed through an explicit point instead of the
 * live cursor. Returns the instance's resulting transform (for app.js to
 * copy back into state), or null if the point aimed at sky/void and no
 * placement could be derived - the caller decides the fallback then.
 */
export function placeInstanceAtScreenPoint(id, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  lastPointerNdc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const placed = applySurfaceSnapDrag(id);
  return placed ? getInstanceTransform(id) : null;
}

/**
 * Place a just-created instance "in the center of the viewport, at a
 * safe distance" (the double-click-an-asset path): first try the same
 * surface placement as above but aimed through the viewport's center -
 * so it lands ON whatever the user is currently looking at. If the
 * center of the view is sky/void, fall back to the orbit pivot
 * (orbitControls.target): it's by definition a comfortable, visible
 * working distance in front of the camera, and the object is rested on
 * the ground plane at that X/Z rather than floating at the pivot's
 * height. Returns the resulting transform.
 */
export function placeInstanceAtViewCenter(id) {
  const inst = instances.get(id);
  if (!inst) return null;

  lastPointerNdc.set(0, 0);
  if (!applySurfaceSnapDrag(id)) {
    const obj = inst.object3D;
    obj.position.set(orbitControls.target.x, 0, orbitControls.target.z);
    const bbox = new THREE.Box3().setFromObject(obj);
    if (!bbox.isEmpty()) {
      obj.position.y -= bbox.min.y; // lift so the box's underside rests exactly on y=0
    }
    obj.position.copy(SNAP_DRAG_BOUNDS.clampPoint(obj.position, new THREE.Vector3()));
  }
  return getInstanceTransform(id);
}

/**
 * Parse an .obj's text and materialsMap into a reusable template Object3D,
 * stored keyed by modelName. The template itself is never added to the
 * scene - addInstance() clones it per placed instance.
 */
export function loadModelIntoScene(modelName, objText, materialsMap) {
  // ------------------------------------------------------------------
  // STRAY EDGE/POINT SANITIZATION (confirmed root cause of the "faces
  // not filled / wireframe only / falling through the grass in walk
  // mode" bug, reproduced with honda.obj vs honda_broke.obj):
  //
  // A stray edge in Blender (an edge not part of any face - often left
  // behind by a stray vertex pair) exports as an OBJ 'l' (line) element.
  // OBJLoader's addLineGeometry() sets the WHOLE object's geometry type
  // to 'Line', and parse() then builds the entire 'o' block as
  // THREE.LineSegments instead of a Mesh - every face in the object is
  // discarded, it renders as wireframe only, and walk-mode's ground
  // raycast (which only collects isMesh objects) finds nothing to stand
  // on. ONE stray edge poisons the whole object.
  //
  // 'l' and 'p' (point) elements only ever REFERENCE vertices - removing
  // these lines shifts no v/vt/vn indices - so stripping them is safe.
  // The stray vertices themselves remain in the file but are harmless
  // (unreferenced). The count is returned so the caller can warn the
  // artist that the source asset should be cleaned (Blender: Select All
  // -> Mesh > Clean Up > Delete Loose).
  // ------------------------------------------------------------------
  const strayElements = objText.match(/^[lp][ \t]/gm);
  const strayElementCount = strayElements ? strayElements.length : 0;
  if (strayElementCount > 0) {
    objText = objText.replace(/^[lp][ \t].*$/gm, '');
  }

  const loader = new OBJLoader();
  const group = loader.parse(objText);

  // Build the viewer-side replacement material for ONE source material.
  //
  // MeshBasicMaterial chosen over MeshStandardMaterial: PS1-era assets
  // have no PBR workflow (no roughness/metalness maps), and Basic
  // avoids any lighting-driven color shifts that would make the
  // viewport preview diverge from the flat-shaded PS1 look - it just
  // shows the decoded texture as-is.
  //
  // side: THREE.DoubleSide - Three defaults to FrontSide (backface
  // culled), which silently makes a mesh invisible-but-present if its
  // authored winding order comes out "backward" from Three's
  // perspective (confirmed root cause of a reported "grass texture
  // doesn't load" bug: the .tim decoded as 100% opaque, correct pixel
  // data, but the ground mesh's triangles were being culled entirely,
  // reading as transparent). main.c's own PS1 renderer does its OWN
  // software backface cull at runtime (see draw_object_into_ot()'s
  // cross-product winding test) using whatever winding the export
  // pipeline actually produces, so scene-gen showing both sides here is
  // purely an editing-time convenience - it doesn't need to match the
  // PS1 runtime's culling 1:1, and erring toward "always visible while
  // authoring" is much less confusing than a mesh silently vanishing.
  //
  // material.name is COPIED from the source material - this is load-
  // bearing, not cosmetic: updateInstancePaletteRow() looks materials up
  // in materialTimData BY NAME to rebuild textures for a different CLUT
  // row. The previous version of this code dropped the name (a fresh
  // MeshBasicMaterial's name is ''), which made palette-row switching
  // silently no-op on every instance.
  function buildViewerMaterial(sourceMaterial) {
    const matName = sourceMaterial && sourceMaterial.name ? sourceMaterial.name : null;
    const decodedTim = matName ? materialsMap.get(matName) : null;

    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    material.name = matName || '';

    if (decodedTim) {
      material.map = buildDataTexture(decodedTim, 0);
      // PS1 "black = transparent" texels decode with alpha=0 (see
      // tim_reader.js's decodeColor16). Without alphaTest those texels
      // render as opaque black in the viewport (Basic materials ignore
      // texture alpha unless transparent/alphaTest is set); alphaTest
      // discards them without the depth-sorting headaches of
      // transparent=true.
      material.alphaTest = 0.5;
    } else {
      material.color.set(0xff00ff); // magenta = "texture missing" flag color
    }

    return material;
  }

  group.traverse((child) => {
    if (!child.isMesh) return;

    // MULTI-MATERIAL MESHES: OBJLoader emits child.material as an ARRAY
    // (not a single Material) whenever one OBJ object uses more than one
    // usemtl - which is exactly what Blender's default export produces
    // for a model like House (House0 faces + Grass0 faces in one "o"
    // block). The geometry carries .groups mapping triangle ranges to
    // material indices. The previous code assumed a single material:
    // reading `.name` off the array yielded undefined, and replacing the
    // array with ONE unnamed material discarded the per-group material
    // assignment entirely - the second material's (Grass0's) triangle
    // group effectively lost its faces. Mapping the array 1:1 keeps the
    // geometry groups' materialIndex references valid.
    child.material = Array.isArray(child.material)
      ? child.material.map(buildViewerMaterial)
      : buildViewerMaterial(child.material);
  });

  modelTemplates.set(modelName, group);

  // Triangle count for the sidebar model list (QOL): computed once here
  // rather than per-render, since template geometry never changes after
  // load. Handles both indexed and non-indexed BufferGeometries.
  let triCount = 0;
  group.traverse((child) => {
    if (!child.isMesh) return;
    const geom = child.geometry;
    const posAttr = geom.getAttribute('position');
    if (!posAttr) return;
    triCount += (geom.index ? geom.index.count : posAttr.count) / 3;
  });
  modelTriCounts.set(modelName, Math.round(triCount));

  // Number of stray 'l'/'p' elements that had to be stripped (see the
  // sanitization block at the top) - callers use this to warn the artist.
  return strayElementCount;
}

/**
 * Triangle count of a loaded model template, or null if not loaded.
 * Display-only (sidebar model list).
 */
export function getModelTriCount(modelName) {
  return modelTriCounts.has(modelName) ? modelTriCounts.get(modelName) : null;
}

/**
 * Show/hide the ground grid. Returns the new visibility state so the
 * caller can reflect it in the UI without tracking a duplicate flag.
 */
export function toggleGridVisible() {
  if (!grid) return true;
  grid.visible = !grid.visible;
  return grid.visible;
}

/**
 * Re-frame the editing orbit camera on one instance (QOL, "." shortcut -
 * like Blender's View Selected). Keeps the current viewing DIRECTION and
 * just moves the target to the instance's bounding-box center, backing
 * the camera off proportionally to the instance's size.
 */
export function frameInstance(id) {
  const inst = instances.get(id);
  if (!inst || !editCamera || !orbitControls) return;

  const box = new THREE.Box3().setFromObject(inst.object3D);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const dir = new THREE.Vector3().subVectors(editCamera.position, orbitControls.target);
  if (dir.lengthSq() === 0) dir.set(0, 0.5, 1);
  dir.normalize();

  orbitControls.target.copy(center);
  editCamera.position.copy(center).addScaledVector(dir, size * 1.5);
  orbitControls.update();
}

/**
 * Clone the stored template for `modelName`, apply the initial transform,
 * add it to the scene, and track it under `id`.
 *
 * `materialsMap` is the SAME Map<materialName, decodedTim|null> that was
 * passed to loadModelIntoScene() for this model (app.js keeps it around on
 * state.models). We store it per-instance (materialTimData) rather than
 * relying on a shared reference, because updateInstancePaletteRow() needs
 * the raw decoded CLUT/index data to rebuild a DataTexture for whichever
 * row is selected, and that raw data is not recoverable from a
 * THREE.Material alone (a Material only ever holds ONE baked-out texture,
 * not the full set of palette rows it could be rebuilt from).
 */
export function addInstance(id, modelName, initialTransform = {}, materialsMap = null) {
  const template = modelTemplates.get(modelName);
  if (!template) {
    console.warn(`viewer.addInstance: no template loaded for model "${modelName}"`);
    return null;
  }

  const object3D = template.clone(true);

  // Materials must be deep-cloned per instance (not shared with the
  // template or with other instances of the same model) because palette
  // row selection is per-instance: calling updateInstancePaletteRow() on
  // one instance must not change the texture on other instances of the
  // same model that happen to be showing a different row.
  object3D.traverse((child) => {
    if (!child.isMesh) return;
    // Multi-material meshes carry an ARRAY of materials (one per geometry
    // group) - clone each element rather than calling .clone() on the
    // array itself (which would throw).
    child.material = Array.isArray(child.material)
      ? child.material.map((m) => m.clone())
      : child.material.clone();
  });

  scene.add(object3D);

  const materialTimData = materialsMap ? new Map(materialsMap) : new Map();

  const pos = { x: 0, y: 0, z: 0, ...(initialTransform.pos || {}) };
  const rot = { x: 0, y: 0, z: 0, ...(initialTransform.rot || {}) };
  const scaleV = { x: 1, y: 1, z: 1, ...(initialTransform.scale || {}) };

  object3D.position.set(pos.x, pos.y, pos.z);
  object3D.rotation.set(
    THREE.MathUtils.degToRad(rot.x),
    THREE.MathUtils.degToRad(rot.y),
    THREE.MathUtils.degToRad(rot.z)
  );
  object3D.scale.set(scaleV.x, scaleV.y, scaleV.z);

  // currentPaletteRow starts at 0 because the cloned material's texture
  // came from the template, which loadModelIntoScene() always builds at
  // row 0 (see its own comment) - so a freshly added instance is
  // genuinely showing row 0 until updateInstancePaletteRow() says
  // otherwise. This must be set correctly here (not left undefined) for
  // that function's early-out guard to behave right: undefined !== 0
  // would make the very first updateInstancePaletteRow(id, 0) call after
  // creation incorrectly SKIP (thinking nothing changed) rather than
  // no-op for the right reason (row 0 is already what's showing).
  instances.set(id, { object3D, modelName, materialTimData, currentPaletteRow: 0 });
  invalidateWalkableMeshCache();

  return object3D;
}

// ==========================================================================
// Editor entity helpers (Triggers / Spawns / Summons / Particles / Billboards)
// ==========================================================================
//
// Entities are tracked in the SAME `instances` map as model instances
// (ids never collide - SceneState hands out one shared id sequence), so
// click-selection raycasts, TransformControls attachment, removal, and
// frame-selected all work on them with zero extra plumbing. Entries are
// marked `isEntity: true` so the systems where a marker gizmo must NOT
// behave like world geometry - freecam walking, seam-snap neighbors,
// surface-snap raycast targets - can skip them.
//
// Colors mirror scene_state.js's ENTITY_KINDS (CSS side). Keep in sync.
const ENTITY_COLORS = {
  trigger: 0xff8c42,
  spawn: 0x5dd06a,
  summon: 0xb06ee0,
  particle: 0xffd23c,
  billboard: 0x3ec6dc,
};

/** LineLoop circle geometry in the XZ plane (patrol radius rings). */
function makeCircleGeometry(radius, segments = 48) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Cone + base-disc + forward pointer marker shared by spawn/summon. */
function buildSpawnMarker(group, color) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const discMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false,
  });

  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.01; // sit just above the ground plane to avoid z-fighting the grid
  group.add(disc);

  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 12), mat);
  cone.position.y = 0.3;
  group.add(cone);

  // Forward pointer: which way the spawned actor will FACE (-Z, the same
  // "forward" convention as the exported camera). Rotating the entity
  // with the gizmo swings this pointer.
  const pointer = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), mat.clone());
  pointer.position.set(0, 0.1, -0.5);
  group.add(pointer);
}

function buildEntityMeshes(group, kind, color, props) {
  switch (kind) {
    case 'trigger': {
      // Unit cube - the entity's SCALE is the volume's size, so the
      // regular scale gizmo resizes the trigger region directly.
      const fill = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
        })
      );
      group.add(fill);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicMaterial({ color })
      );
      group.add(edges);
      break;
    }
    case 'spawn':
      buildSpawnMarker(group, color);
      break;
    case 'summon': {
      buildSpawnMarker(group, color);
      const ring = new THREE.LineLoop(
        makeCircleGeometry(Math.max(0, props.patrolRadius || 0)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
      );
      ring.name = 'patrolRing';
      ring.position.y = 0.02;
      group.add(ring);
      break;
    }
    case 'particle': {
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.22),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
      core.position.y = 0.25;
      group.add(core);
      const halo = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.36),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 })
      );
      halo.position.y = 0.25;
      group.add(halo);
      break;
    }
    case 'billboard': {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.2, 0.8),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false,
        })
      );
      plane.position.y = 0.4;
      group.add(plane);
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.2, 0.8)),
        new THREE.LineBasicMaterial({ color })
      );
      frame.position.y = 0.4;
      group.add(frame);
      break;
    }
    default: {
      const fallback = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 12, 8),
        new THREE.MeshBasicMaterial({ color })
      );
      group.add(fallback);
    }
  }
}

export function addEntityHelper(id, kind, initialTransform = {}, props = {}) {
  const group = new THREE.Group();
  const color = ENTITY_COLORS[kind] || 0xffffff;
  buildEntityMeshes(group, kind, color, props);
  scene.add(group);

  const pos = { x: 0, y: 0, z: 0, ...(initialTransform.pos || {}) };
  const rot = { x: 0, y: 0, z: 0, ...(initialTransform.rot || {}) };
  const scaleV = { x: 1, y: 1, z: 1, ...(initialTransform.scale || {}) };
  group.position.set(pos.x, pos.y, pos.z);
  group.rotation.set(
    THREE.MathUtils.degToRad(rot.x),
    THREE.MathUtils.degToRad(rot.y),
    THREE.MathUtils.degToRad(rot.z)
  );
  group.scale.set(scaleV.x, scaleV.y, scaleV.z);

  // materialTimData/currentPaletteRow exist so shared instance-map code
  // paths (palette refresh etc.) treat this entry as a harmless no-op.
  instances.set(id, {
    object3D: group,
    modelName: `__entity__${kind}`,
    materialTimData: new Map(),
    currentPaletteRow: 0,
    isEntity: true,
    kind,
    props: { ...props },
  });
  applyEntityPropsToMeshes(instances.get(id));
  return group;
}

/** Push edited props into the live helper visuals: summon patrol ring
 * radius, billboard draw-through-walls (depthTest off = renders on top,
 * previewing exactly what the runtime flag means). */
function applyEntityPropsToMeshes(inst) {
  if (!inst || !inst.isEntity) return;

  if (inst.kind === 'summon') {
    const ring = inst.object3D.getObjectByName('patrolRing');
    if (ring) {
      ring.geometry.dispose();
      ring.geometry = makeCircleGeometry(Math.max(0, inst.props.patrolRadius || 0));
    }
  }

  if (inst.kind === 'billboard') {
    const onTop = !!inst.props.seeThroughWalls;
    inst.object3D.traverse((child) => {
      if (child.material) {
        child.material.depthTest = !onTop;
        child.material.needsUpdate = true;
      }
    });
    // renderOrder puts it after everything else when depth-testing is off,
    // so "through walls" reads correctly instead of depending on draw order.
    inst.object3D.traverse((child) => { child.renderOrder = onTop ? 999 : 0; });
  }
}

export function updateEntityProps(id, props) {
  const inst = instances.get(id);
  if (!inst || !inst.isEntity) return;
  inst.props = { ...props };
  applyEntityPropsToMeshes(inst);
}

/**
 * Returns an array of every instance id currently tracked/rendered in the
 * viewport. Used by app.js's resyncViewportFromState() (see its own
 * comment) to clear the viewport down to nothing before re-adding
 * instances from a freshly-restored SceneState snapshot (project load,
 * undo/redo) - it needs a way to enumerate "what's currently shown" from
 * outside this module, since `instances` itself is module-private.
 */
export function getTrackedInstanceIds() {
  return Array.from(instances.keys());
}

export function removeInstance(id) {
  const inst = instances.get(id);
  if (!inst) return;

  if (currentTransformTarget === id) {
    transformControls.detach();
    currentTransformTarget = null;
  }

  scene.remove(inst.object3D);
  // Dispose anything carrying GPU resources - meshes AND line objects
  // (entity helpers are built from LineSegments/LineLoop as well as
  // meshes; checking only isMesh would leak their geometries).
  inst.object3D.traverse((child) => {
    if (!child.geometry && !child.material) return;
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    }
  });

  instances.delete(id);
  invalidateWalkableMeshCache();
}

/**
 * Attach TransformControls to the given instance's Object3D (or detach if
 * id is null).
 */
export function selectInstance(id) {
  if (id === null) {
    transformControls.detach();
    currentTransformTarget = null;
    return;
  }

  const inst = instances.get(id);
  if (!inst) return;

  transformControls.attach(inst.object3D);
  currentTransformTarget = id;
}

export function selectCameraGizmo() {
  transformControls.attach(cameraGizmo);
  currentTransformTarget = CAMERA_GIZMO_ID;
}

// Notifies app.js whenever the transform mode changes, from ANY entry
// point. Needed because mode changes have two sources: the toolbar
// buttons (app.js) and the W/E/R shortcuts (owned here, see initViewer).
// Before this hook existed, W/E/R switched the gizmo but left the old
// sidebar buttons highlighting a stale mode; now both routes funnel
// through setTransformMode() and app.js re-renders off this callback.
let transformModeCallback = null;

export function onTransformModeChange(callback) {
  transformModeCallback = callback;
}

export function setTransformMode(mode) {
  transformControls.setMode(mode);
  if (transformModeCallback) transformModeCallback(mode);
}

export function getInstanceTransform(id) {
  const inst = instances.get(id);
  if (!inst) return null;

  const obj = inst.object3D;
  return {
    pos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rot: {
      x: THREE.MathUtils.radToDeg(obj.rotation.x),
      y: THREE.MathUtils.radToDeg(obj.rotation.y),
      z: THREE.MathUtils.radToDeg(obj.rotation.z),
    },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
  };
}

export function setInstanceTransform(id, transform) {
  const inst = instances.get(id);
  if (!inst) return;
  const obj = inst.object3D;

  if (transform.pos) {
    if (transform.pos.x !== undefined) obj.position.x = transform.pos.x;
    if (transform.pos.y !== undefined) obj.position.y = transform.pos.y;
    if (transform.pos.z !== undefined) obj.position.z = transform.pos.z;
  }
  if (transform.rot) {
    if (transform.rot.x !== undefined) obj.rotation.x = THREE.MathUtils.degToRad(transform.rot.x);
    if (transform.rot.y !== undefined) obj.rotation.y = THREE.MathUtils.degToRad(transform.rot.y);
    if (transform.rot.z !== undefined) obj.rotation.z = THREE.MathUtils.degToRad(transform.rot.z);
  }
  if (transform.scale) {
    if (transform.scale.x !== undefined) obj.scale.x = transform.scale.x;
    if (transform.scale.y !== undefined) obj.scale.y = transform.scale.y;
    if (transform.scale.z !== undefined) obj.scale.z = transform.scale.z;
  }
}

/**
 * Rebuild the DataTexture for a given instance's materials at the
 * requested palette row. We need the decoded .tim per material (stored in
 * materialTimData at addInstance time) because the row-indexed pixel data
 * lives there - the current THREE.Material only holds whatever texture
 * was last assigned to it, not the underlying CLUT rows.
 *
 * Early-outs if `row` matches the row already applied (tracked via
 * inst.currentPaletteRow) - callers like app.js's resyncViewportFromState()
 * now call this unconditionally on every already-loaded instance whenever
 * ANY model finishes loading (see that function's own comment for why),
 * so this guard is what keeps that cheap: dispose+rebuild only actually
 * happens when the row is genuinely changing, not on every redundant call
 * with the same row an instance is already showing.
 */
export function updateInstancePaletteRow(id, row) {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.currentPaletteRow === row) return;
  inst.currentPaletteRow = row;

  const modelTemplate = modelTemplates.get(inst.modelName);
  if (!modelTemplate) return;

  inst.object3D.traverse((child) => {
    if (!child.isMesh) return;
    // Multi-material meshes carry an ARRAY of materials - rebuild the
    // texture for every named material on the mesh, not just a single one.
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      const matName = mat.name;
      if (!matName) continue;

      // materialTimData was populated at addInstance() time from the
      // model's resolved materialsMap, so the decoded CLUT/index data for
      // every named material on this instance should already be cached here.
      const decodedTim = inst.materialTimData.get(matName);
      if (!decodedTim) {
        console.warn(`updateInstancePaletteRow: no cached tim data for material "${matName}" on instance ${id}`);
        continue;
      }

      if (mat.map) mat.map.dispose();
      mat.map = buildDataTexture(decodedTim, row);
      mat.needsUpdate = true;
    }
  });
}

export function getCameraTransform() {
  return {
    pos: { x: cameraGizmo.position.x, y: cameraGizmo.position.y, z: cameraGizmo.position.z },
    rot: {
      x: THREE.MathUtils.radToDeg(cameraGizmo.rotation.x),
      y: THREE.MathUtils.radToDeg(cameraGizmo.rotation.y),
      z: THREE.MathUtils.radToDeg(cameraGizmo.rotation.z),
    },
  };
}

export function setCameraTransform(transform) {
  if (transform.pos) {
    if (transform.pos.x !== undefined) cameraGizmo.position.x = transform.pos.x;
    if (transform.pos.y !== undefined) cameraGizmo.position.y = transform.pos.y;
    if (transform.pos.z !== undefined) cameraGizmo.position.z = transform.pos.z;
  }
  if (transform.rot) {
    if (transform.rot.x !== undefined) cameraGizmo.rotation.x = THREE.MathUtils.degToRad(transform.rot.x);
    if (transform.rot.y !== undefined) cameraGizmo.rotation.y = THREE.MathUtils.degToRad(transform.rot.y);
    if (transform.rot.z !== undefined) cameraGizmo.rotation.z = THREE.MathUtils.degToRad(transform.rot.z);
  }
}

export function onSelectionChange(callback) {
  selectionChangeCallback = callback;
}

export function onTransformChange(callback) {
  transformChangeCallback = callback;
}

/**
 * Register a callback fired exactly once at the start of each gizmo drag
 * gesture (mouse-down on a TransformControls handle), before any
 * 'objectChange' events for that drag fire. Receives the id (or
 * CAMERA_GIZMO_ID) of whatever is currently attached. See the
 * 'dragging-changed' listener in initViewer() for why this exists
 * (undo history needs a single pre-drag snapshot, not one per frame).
 */
export function onDragStart(callback) {
  dragStartCallback = callback;
}

// ==========================================================================
// Freecam (F key) - FPS-style fly camera, and Blender-style "walk on
// geometry" mode (Space, while freecam is active)
// ==========================================================================
//
// DESIGN NOTES
// ----------------------------------------------------------------------
// Freecam replaces OrbitControls entirely while active (both would fight
// over the same mouse input otherwise) and uses the Pointer Lock API for
// mouse-look, matching how every FPS/Blender-fly-mode implementation
// handles "the mouse just steers a direction, it never needs to leave the
// viewport or show a cursor". Movement is plain WASD + Q/E (down/up) in fly
// mode, translated in the camera's own local space so "forward" always
// means "the direction you're looking", exactly like Blender's Shift+F fly
// navigation.
//
// Walk mode (Space toggle while freecam is active) switches from free 3D
// flight to grounded movement: gravity pulls the camera down each frame,
// and a downward raycast against every loaded instance's geometry finds
// the floor directly beneath the camera and clamps the camera's feet
// (approximated as "camera position minus EYE_HEIGHT") to sit exactly on
// it. Per the request, there is deliberately NO horizontal collision
// (wall/side checking) - only vertical ground-following - so WASD still
// freely moves in any horizontal direction; only the Y coordinate is ever
// overridden by the ground raycast. Walking up an incline/staircase works
// for free out of this same per-frame "find the floor right under me and
// snap to it" approach, since a staircase's floor height simply changes
// smoothly (or in small steps) as the camera's XZ position changes - no
// separate stair-specific logic is needed, PROVIDED the vertical jump
// between one frame's ground height and the next isn't so large it reads
// as teleporting; MAX_STEP_UP_PER_FRAME guards against snapping onto
// clearly-too-tall ledges (which should instead just block/stand at the
// base, falling back to gravity) while still comfortably climbing
// reasonably-sized stair rises frame-to-frame at normal walk speed.

const FREECAM_FLY_SPEED = 6; // units/sec, fly mode
const FREECAM_WALK_SPEED = 4.5; // units/sec, walk mode (horizontal only)
const FREECAM_SPRINT_MULTIPLIER = 2.5; // Shift held
const FREECAM_MOUSE_SENSITIVITY = 0.0025; // radians per pixel of mouse movement
const FREECAM_EYE_HEIGHT = 1; // camera-to-feet offset while walking, roughly human-scale in these viewport units
const FREECAM_GRAVITY = 4; // units/sec^2
const FREECAM_MAX_STEP_UP_PER_FRAME_BASE = 6; // units/sec the ground can rise and still have the camera snap to it (scaled by dt)
const FREECAM_GROUND_RAY_START_OFFSET = 5; // cast the ground ray from this far above the feet, so we don't start the ray from inside/below geometry

let freecamActive = false;
let freecamWalkMode = false;
let freecamYaw = 0;
let freecamPitch = 0;
let freecamVerticalVelocity = 0; // walk-mode gravity accumulator
let freecamPointerLocked = false;

const freecamKeys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false, space: false };
const freecamGroundRaycaster = new THREE.Raycaster();

// Fired whenever freecam or walk mode toggles, with { active, walk } -
// lets app.js show an on-screen indicator so the user always knows which
// input mode owns their keyboard/mouse (easy to forget freecam is on).
let freecamChangeCallback = null;

export function onFreecamChange(callback) {
  freecamChangeCallback = callback;
}

function notifyFreecamChange() {
  if (freecamChangeCallback) freecamChangeCallback({ active: freecamActive, walk: freecamWalkMode });
}

function initFreecam() {
  window.addEventListener('keydown', (event) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((event.key === 'f' || event.key === 'F') && !event.repeat) {
      toggleFreecam();
      return;
    }

    if (!freecamActive) return;

    switch (event.key.toLowerCase()) {
      case 'w': freecamKeys.w = true; break;
      case 'a': freecamKeys.a = true; break;
      case 's': freecamKeys.s = true; break;
      case 'd': freecamKeys.d = true; break;
      case 'q': freecamKeys.q = true; break;
      case 'e': freecamKeys.e = true; break;
      case 'shift': freecamKeys.shift = true; break;
      case ' ':
        // Space TOGGLES walk mode (per spec: "if in freecam and we press
        // Space, we can walk on geometry") rather than acting as a
        // held-down modifier - a single tap flips between flying freely
        // and being grounded, matching Blender's own fly-mode Space
        // behavior for changing gravity state mid-flight.
        event.preventDefault();
        if (!event.repeat) toggleFreecamWalk();
        break;
    }
  });

  window.addEventListener('keyup', (event) => {
    switch (event.key.toLowerCase()) {
      case 'w': freecamKeys.w = false; break;
      case 'a': freecamKeys.a = false; break;
      case 's': freecamKeys.s = false; break;
      case 'd': freecamKeys.d = false; break;
      case 'q': freecamKeys.q = false; break;
      case 'e': freecamKeys.e = false; break;
      case 'shift': freecamKeys.shift = false; break;
    }
  });

  document.addEventListener('pointerlockchange', () => {
    freecamPointerLocked = document.pointerLockElement === canvas;
    // Losing pointer lock unexpectedly (user hit Escape, alt-tabbed, etc.)
    // should drop us cleanly out of freecam rather than leaving a camera
    // that still thinks it owns WASD/mouse input but no longer has the
    // lock to actually receive mouse-move deltas.
    if (!freecamPointerLocked && freecamActive) {
      exitFreecam();
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!freecamActive || !freecamPointerLocked) return;
    freecamYaw -= event.movementX * FREECAM_MOUSE_SENSITIVITY;
    freecamPitch -= event.movementY * FREECAM_MOUSE_SENSITIVITY;
    // Clamp pitch just short of straight up/down - avoids the camera
    // flipping upside-down past the poles (same class of degenerate case
    // orbitControls' own gimbal-lock avoidance deals with elsewhere in
    // this file, here handled by simply not letting pitch reach it).
    const limit = Math.PI / 2 - 0.01;
    freecamPitch = Math.max(-limit, Math.min(limit, freecamPitch));
  });
}

function toggleFreecam() {
  if (freecamActive) {
    exitFreecam();
  } else {
    enterFreecam();
  }
}

function enterFreecam() {
  if (!editCamera) return;

  freecamActive = true;
  freecamWalkMode = false;
  freecamVerticalVelocity = 0;

  // Seed yaw/pitch from the camera's CURRENT orientation so entering
  // freecam never snaps the view to a different direction than what was
  // already on screen - the user should be able to freely orbit around,
  // press F, and keep looking exactly where they were looking.
  const euler = new THREE.Euler().setFromQuaternion(editCamera.quaternion, 'YXZ');
  freecamYaw = euler.y;
  freecamPitch = euler.x;

  orbitControls.enabled = false;
  transformControls.enabled = false;

  canvas.requestPointerLock();
  notifyFreecamChange();
}

function exitFreecam() {
  freecamActive = false;
  freecamWalkMode = false;

  orbitControls.enabled = true;
  transformControls.enabled = true;

  // Freecam may have left the camera in an orientation/position OrbitControls
  // never "chose" itself (it only ever rotates AROUND orbitControls.target).
  // Re-point the orbit target straight ahead of wherever freecam ended up so
  // resuming orbit control continues smoothly from the current view instead
  // of the camera immediately swinging back toward a stale, far-away target.
  const forward = new THREE.Vector3();
  editCamera.getWorldDirection(forward);
  const distance = editCamera.position.distanceTo(orbitControls.target) || 8;
  orbitControls.target.copy(editCamera.position).addScaledVector(forward, distance);
  orbitControls.update();

  if (document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
  notifyFreecamChange();
}

function toggleFreecamWalk() {
  freecamWalkMode = !freecamWalkMode;
  freecamVerticalVelocity = 0;
  notifyFreecamChange();
}

/**
 * Collect every mesh currently placed in the scene that walk-mode's ground
 * raycast should be able to stand on: all instance geometry, plus the grid
 * helper is deliberately EXCLUDED (GridHelper is a LineSegments object, not
 * a walkable surface, and including it would make the raycaster treat an
 * infinitely-thin visual aid as solid ground).
 */
//
// CACHED: previously this re-traversed every instance's whole subtree on
// EVERY walk-mode frame. The set of meshes only actually changes when an
// instance is added or removed, so addInstance()/removeInstance() just
// invalidate the cache (see invalidateWalkableMeshCache) and the traverse
// runs once per scene change instead of 60x/sec.
let walkableMeshCache = null;

function invalidateWalkableMeshCache() {
  walkableMeshCache = null;
}

function collectWalkableMeshes() {
  if (walkableMeshCache) return walkableMeshCache;
  const meshes = [];
  for (const inst of instances.values()) {
    if (inst.isEntity) continue; // marker gizmos are not walkable geometry - you'd stand on a spawn cone
    inst.object3D.traverse((child) => {
      if (child.isMesh) meshes.push(child);
    });
  }
  walkableMeshCache = meshes;
  return meshes;
}

function updateFreecam(dt) {
  if (!editCamera) return;

  // Apply mouse-look every frame regardless of movement keys.
  editCamera.quaternion.setFromEuler(new THREE.Euler(freecamPitch, freecamYaw, 0, 'YXZ'));

  // Build a movement vector in the camera's local space from whichever
  // WASD/QE keys are currently held, matching standard FPS control feel:
  // forward/back and strafe left/right always relative to look direction,
  // Q/E are a world-space (not look-relative) down/up nudge for flying
  // over or under geometry, only meaningful in fly mode (walk mode's Y is
  // fully owned by gravity + the ground raycast instead).
  const forward = new THREE.Vector3();
  editCamera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, editCamera.up).normalize();

  const moveDir = new THREE.Vector3();
  if (freecamKeys.w) moveDir.add(forward);
  if (freecamKeys.s) moveDir.sub(forward);
  if (freecamKeys.d) moveDir.add(right);
  if (freecamKeys.a) moveDir.sub(right);

  if (!freecamWalkMode) {
    // Fly mode: full 3D movement, forward/back also moves vertically if
    // you're looking up/down (Blender fly-mode behavior), Q/E add a pure
    // vertical nudge on top.
    if (freecamKeys.e) moveDir.y += 1;
    if (freecamKeys.q) moveDir.y -= 1;
  } else {
    // Walk mode: horizontal movement only - flatten forward/right onto the
    // XZ plane so looking up/down a slope doesn't speed up/slow down your
    // horizontal walk speed or add unwanted vertical drift; the ground
    // raycast owns Y entirely instead. Q/E are ignored while walking (no
    // free vertical flight while "on the ground").
    moveDir.y = 0;
  }

  if (moveDir.lengthSq() > 0) moveDir.normalize();

  const baseSpeed = freecamWalkMode ? FREECAM_WALK_SPEED : FREECAM_FLY_SPEED;
  const speed = baseSpeed * (freecamKeys.shift ? FREECAM_SPRINT_MULTIPLIER : 1);
  editCamera.position.addScaledVector(moveDir, speed * dt);

  if (freecamWalkMode) {
    applyWalkGravityAndGroundSnap(dt);
  }
}

/**
 * Walk-mode vertical resolution: gravity pulls the camera's feet down each
 * frame; a downward raycast against all instance geometry finds the floor
 * directly below and clamps the feet onto it whenever the feet are at or
 * below ground level (falling) - this is what makes going DOWN a step or
 * slope feel instant/grounded rather than the camera visibly dropping and
 * bouncing on every stair. Going UP a step/incline is handled by the same
 * single raycast: if the found ground point is HIGHER than the current
 * feet position but the rise is within MAX_STEP_UP_PER_FRAME (scaled by
 * dt), the feet snap up onto it directly (this is the "no wall checks,
 * just let you walk up stairs" behavior the request asked for) - a rise
 * bigger than that in one frame is treated as a wall/ledge too tall to
 * step onto and is simply not snapped to (gravity + normal horizontal
 * movement continue instead, so the camera effectively stops rising and
 * either falls back down or keeps walking horizontally along the base).
 *
 * No horizontal collision is performed anywhere in this function, exactly
 * per the request ("realistically don't do wall checks").
 */
function applyWalkGravityAndGroundSnap(dt) {
  const meshes = collectWalkableMeshes();
  const feetY = editCamera.position.y - FREECAM_EYE_HEIGHT;

  let groundY = null;
  if (meshes.length > 0) {
    const rayOrigin = editCamera.position.clone();
    rayOrigin.y = feetY + FREECAM_GROUND_RAY_START_OFFSET;
    freecamGroundRaycaster.set(rayOrigin, new THREE.Vector3(0, -1, 0));
    freecamGroundRaycaster.far = FREECAM_GROUND_RAY_START_OFFSET + 50; // generous downward reach so tall drops still resolve
    const hits = freecamGroundRaycaster.intersectObjects(meshes, false);
    if (hits.length > 0) groundY = hits[0].point.y;
  }

  if (groundY === null) {
    // No ground found under the camera at all (e.g. walked off the edge
    // of all loaded geometry, or no models loaded yet) - just fall freely
    // under gravity rather than being stuck floating or snapping to
    // nothing.
    freecamVerticalVelocity -= FREECAM_GRAVITY * dt;
    editCamera.position.y += freecamVerticalVelocity * dt;
    return;
  }

  const maxStepUp = FREECAM_MAX_STEP_UP_PER_FRAME_BASE * dt * 10; // scaled to feel like a per-frame cap at typical frame rates, not a literal 6 units/sec climb rate
  const rise = groundY - feetY;

  if (rise <= maxStepUp) {
    // Ground is at/below us, or a climbable step/incline just above us -
    // snap feet exactly onto it and zero out any fall velocity (landing).
    editCamera.position.y = groundY + FREECAM_EYE_HEIGHT;
    freecamVerticalVelocity = 0;
  } else {
    // Ground under the current XZ position is a ledge too tall to step
    // onto in one frame - don't teleport up to it; keep falling/holding
    // per gravity so the camera behaves like it's blocked by the rise
    // instead of levitating onto it. (No sideways deflection since we
    // deliberately skip wall/side collision entirely.)
    freecamVerticalVelocity -= FREECAM_GRAVITY * dt;
    editCamera.position.y += freecamVerticalVelocity * dt;
  }
}

/**
 * Whether freecam is currently active. Exposed so app.js can, if useful,
 * reflect freecam state in the UI (e.g. hiding/disabling gizmo-mode
 * buttons that don't apply while flying) without duplicating the state.
 */
export function isFreecamActive() {
  return freecamActive;
}
