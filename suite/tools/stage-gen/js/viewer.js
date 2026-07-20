/*
 * viewer.js
 *
 * Three.js viewport module for stage-gen. This is a module-level singleton
 * (there is only ever one <canvas id="viewport-canvas"> on the page), so
 * rather than exporting a class we keep viewer state in module-scope
 * variables and export plain functions that operate on it - simpler for
 * app.js to consume than threading a viewer instance through everything.
 *
 * COORDINATE SPACE NOTE: everything in this module operates in "viewport
 * space", which is the SAME space the source glTF models were authored in
 * (Blender: Forward=-Z, Up=Y). Three.js's default world orientation is
 * already Y-up, so no special camera/stage rotation is needed to make the
 * viewport "feel like Blender" - we just don't apply the renderer-space
 * coordinate remap here at all. That remap only happens at export time,
 * in stage_export.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const CAMERA_GIZMO_ID = '__camera__';

// ---- module-level viewer state ----
let renderer = null;
let stage = null;
let editCamera = null; // the camera we look through while editing (not the exported PS1 camera)
let orbitControls = null;
let transformControls = null;
let raycaster = null;
let canvas = null;

// ---- axis gizmo (Blender-style orientation cube, top-right overlay) ----
let gizmoRenderer = null;
let gizmoStage = null;
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

// ---- lighting modes (editor default vs PS1 parity preview) ----
// The shading toggle (top-right viewport overlay, Blender-style) swaps
// instance materials between unlit MeshBasicMaterial (editor) and a custom
// shader implementing the runtime's exact GTE transfer function (PS1).
// See the "PS1 lighting parity preview" section below for the semantics.
let editorAmbientLight = null;
let editorDirLight = null;
let ps1LightingEnabled = false;

// Missing-texture display colour: magenta by default (the classic flag
// colour), toggleable to solid white via the "Missing=White" toolbar
// check. Under the PS1 preview a WHITE untextured face renders the raw lit
// colour itself, making it a live probe of the exact brightness the
// runtime would output (PS1 untextured prims ARE the lit colour).
let missingTextureWhite = false;

// Shared GTE-lighting uniforms, referenced (never copied) by every PS1
// preview material, so updatePS1LightsFromEntities() updates ONE place per
// frame and every material sees it. Directions are unit vectors TOWARD
// each light in viewport space; colours are authored RGB pre-multiplied by
// authored intensity (1.0 == stage-gen Intensity 1.0 == runtime eff 256);
// slots beyond the stage's authored directionals stay black, the exact
// analogue of a zeroed GTE light-matrix row.
const PS1_MAX_PREVIEW_SPHERES = 8; // mirrors main.c's MAX_SPHERE_LIGHTS

const ps1LightUniforms = {
  psAmbient: { value: new THREE.Color(0, 0, 0) },
  psLightDir: {
    value: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)],
  },
  psLightColor: {
    value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)],
  },
  // Spherical (point) lights: position in viewport units, colour *
  // intensity (black == unused slot), range in viewport units (0 ==
  // infinite, matching the authored Range field).
  psSphPos: {
    value: Array.from({ length: PS1_MAX_PREVIEW_SPHERES }, () => new THREE.Vector3()),
  },
  psSphColor: {
    value: Array.from({ length: PS1_MAX_PREVIEW_SPHERES }, () => new THREE.Color(0, 0, 0)),
  },
  psSphRange: {
    value: new Array(PS1_MAX_PREVIEW_SPHERES).fill(0),
  },
};

// modelName -> triangle count of the parsed template (computed once at
// load time in loadModelIntoStage, displayed in the sidebar model list).
const modelTriCounts = new Map();

// modelName -> parsed template Object3D (never added to `stage` directly, only cloned)
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
 * flipY = FALSE - the glTF era flips the convention vs the old OBJ path.
 * Traced end-to-end against py_convert_assets.py (the only other place in
 * the toolchain that touches V), not guessed:
 * ----------------------------------------------------------------------
 *   1. GLTFLoader reads the TEXCOORD_0 accessor RAW into the mesh's `uv`
 *      attribute. glTF's UV origin is the TOP-left, i.e. v=0 is the TOP of
 *      the texture - the OPPOSITE of raw OBJ, where v=0 was the bottom.
 *   2. py_convert_assets.py's glTF reader stores UVs UNCHANGED - `(u, v)`
 *      with no 1-v flip (the OBJ reader flipped to `(u, 1-v)`; glTF is
 *      already top-left, so it must not). So on the PS1 side, glTF v=0
 *      samples .tim row 0.
 *   3. decodeTim() yields pixel rows in the file's own top-to-bottom order,
 *      so row 0 IS the top of the texture. We want mesh v=0 (glTF top) to
 *      sample .tim row 0 (top) - the SAME orientation, zero flips apart.
 *   4. THREE.DataTexture with flipY = false uploads the buffer as-is, so
 *      uv (0,0) maps to data row 0. That gives mesh v=0 -> .tim row 0,
 *      matching step 3. (This is also exactly how GLTFLoader treats a
 *      glTF's OWN embedded textures - flipY=false - so our .tim swap-in
 *      stays consistent with everything else GLTFLoader produces.)
 *
 * The old OBJ path used flipY = true because raw OBJ v=0 was the BOTTOM and
 * the Python converter applied its own (u, 1-v). Both of those flipped in
 * the glTF migration, so this flipped too. DataTexture defaults to
 * flipY=false anyway, but it is set explicitly here to make the reasoning
 * above correct-by-construction regardless of Three.js version defaults.
 */
function buildDataTexture(decodedTim, row) {
  const rgba = decodedTim.getRGBATextureForRow(row);
  const texture = new THREE.DataTexture(rgba, decodedTim.width, decodedTim.height, THREE.RGBAFormat);
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Initialize the renderer, stage, cameras, lights, grid, and controls.
 * Call once at app startup with the main viewport <canvas> and the small
 * overlay <canvas> the axis orientation gizmo renders into (top-right
 * corner, see tool.css #viewport-gizmo-canvas).
 */
export function initViewer(canvasEl, gizmoCanvasEl) {
  canvas = canvasEl;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  stage = new THREE.Scene();
  stage.background = new THREE.Color(0x1a1a1e);

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
  stage.add(grid);

  // Editor rig: bright, even, always-on. Inert in practice - model
  // instances use MeshBasicMaterial (unlit) in editor mode and the PS1
  // preview's custom shader reads its own uniforms, not scene lights -
  // but kept so any future lit built-in material behaves sensibly.
  editorAmbientLight = new THREE.AmbientLight(0xffffff, 0.6);
  stage.add(editorAmbientLight);
  editorDirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  editorDirLight.position.set(5, 10, 7.5);
  stage.add(editorDirLight);

  transformControls = new TransformControls(editCamera, canvas);
  stage.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);

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
  stage.add(cameraGizmo);

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

  // Keep custom OBJ markers a fixed world size by counter-scaling them
  // against their entity's transform, so a large trigger volume or patrol
  // radius doesn't inflate its clickable marker (the finicky-selection fix).
  for (const inst of instances.values()) {
    if (!inst.customMarker) continue;
    const s = inst.object3D.scale;
    inst.customMarker.scale.set(
      s.x ? 1 / s.x : 1,
      s.y ? 1 / s.y : 1,
      s.z ? 1 / s.z : 1
    );
  }

  // PS1 parity preview: re-derive the Three.js light rig from the stage's
  // authored Light entities every frame. This is deliberately per-frame
  // rather than event-driven - it's a handful of map lookups over a small
  // instances map, and it means dragging a Sun's rotation gizmo (or
  // scrubbing its intensity field) relights the viewport live with zero
  // extra plumbing through app.js.
  if (ps1LightingEnabled) updatePS1LightsFromEntities();

  renderer.render(stage, editCamera);
  renderAxisGizmo();
}

// ==========================================================================
// Axis orientation gizmo (Blender-style, top-right viewport overlay)
// ==========================================================================
//
// Six colored balls on the end of three axis stalks (+X/-X/+Y/-Y/+Z/-Z),
// rendered in its OWN small stage/camera/renderer that always mirrors the
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

  gizmoStage = new THREE.Scene();

  // Orthographic so the gizmo doesn't get perspective-distorted at this
  // tiny size, and fixed at a constant distance from the origin - only
  // its ROTATION is updated per-frame (copied from editCamera), never its
  // position/zoom, which is what makes it read as "a compass" rather than
  // a second navigable viewport.
  gizmoCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  gizmoCamera.position.set(0, 0, 4);

  gizmoStage.add(new THREE.AmbientLight(0xffffff, 1.0));

  // Thin stalks from the origin to each axis ball, so the gizmo reads as
  // "spokes" rather than 6 disconnected floating dots (matches Blender's
  // own look).
  for (const axis of GIZMO_AXES) {
    const stalkGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      axis.dir.clone().multiplyScalar(0.9),
    ]);
    const stalk = new THREE.Line(stalkGeom, new THREE.LineBasicMaterial({ color: axis.color }));
    gizmoStage.add(stalk);

    const ballGeom = new THREE.SphereGeometry(0.28, 16, 16);
    const ballMat = new THREE.MeshBasicMaterial({ color: axis.color });
    const ball = new THREE.Mesh(ballGeom, ballMat);
    ball.position.copy(axis.dir).multiplyScalar(0.9);
    gizmoStage.add(ball);

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
  if (!gizmoRenderer || !gizmoStage || !gizmoCamera || !editCamera) return;

  // Copy ONLY the main camera's orientation (via lookAt from a fixed
  // distance along the same direction), not its position - see this
  // section's header comment for why.
  const dir = new THREE.Vector3();
  editCamera.getWorldDirection(dir);
  gizmoCamera.position.copy(dir).multiplyScalar(-4);
  gizmoCamera.lookAt(0, 0, 0);
  gizmoCamera.up.copy(editCamera.up);

  gizmoRenderer.render(gizmoStage, gizmoCamera);
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
 * SAME stage rather than resetting zoom too).
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

  // Entity markers (triggers, spawns, summons, billboards, sounds) draw
  // large translucent volumes / radius rings whose raycast footprint is
  // far bigger than their real "marker". Meshes tagged userData.noPick are
  // those volumes - they must never win a click, or you'd select an entity
  // just by clicking empty space inside its volume (the reported bug).
  // Skip them so selection falls through to the first PICKABLE hit (the
  // entity's own solid core / wireframe outline, or whatever's behind it).
  const firstPickable = hits.find((h) => !h.object.userData.noPick);
  if (!firstPickable) {
    if (selectionChangeCallback) selectionChangeCallback(null);
    return;
  }

  // Walk up from the hit mesh to find which top-level tracked object it
  // belongs to (instance root or the camera gizmo itself).
  let hitObject = firstPickable.object;
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
// World-space bounding box of an entity marker's PICKABLE meshes only -
// i.e. the solid core the user actually clicks, skipping decorative pieces
// tagged userData.noPick (range rings, glow shells, spot cones, aim rods),
// which can be metres across and would otherwise dominate the box. Falls
// back to the whole-group box if a marker somehow has no pickable mesh.
function pickableWorldBox(obj) {
  const box = new THREE.Box3();
  let found = false;
  obj.traverse((child) => {
    if (!child.isMesh || child.userData.noPick || child.visible === false) return;
    child.updateWorldMatrix(true, false);
    const childBox = new THREE.Box3().setFromObject(child);
    if (!childBox.isEmpty()) {
      box.union(childBox);
      found = true;
    }
  });
  return found ? box : new THREE.Box3().setFromObject(obj);
}

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
  //
  // For ENTITY markers, snap against ONLY the pickable core (the small
  // bulb/cone/box), not the whole group: decorative pieces like a light's
  // range ring or glow shell are metres wide, and including them made the
  // support distance huge - the marker leapt far off the surface instead of
  // resting flush at the cursor. Real model instances have no noPick pieces,
  // so they keep the full-group box unchanged.
  const bbox = inst.isEntity ? pickableWorldBox(obj) : new THREE.Box3().setFromObject(obj);
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
 * Parse a model's .glb (binary glTF) ArrayBuffer into a reusable template
 * Object3D, resolve its textures, and store it keyed by modelName. The
 * template itself is never added to the stage - addInstance() clones it per
 * placed instance.
 *
 * `resolveByNames(names[])` is an async callback (supplied by app.js, closed
 * over the model's own dirHandle) that maps glTF material names to decoded
 * .tim data - see resolveMaterialsByNames() in mtl_resolver.js. It's injected
 * rather than imported here so viewer.js stays free of filesystem concerns.
 *
 * Returns the resolved Map<materialName, decodedTim|null> so app.js can keep
 * it on state.models (addInstance needs it for per-instance palette rows).
 */
export async function loadModelIntoStage(modelName, glbArrayBuffer, resolveByNames) {
  // GLTFLoader.parse is callback-based; wrap it in a Promise. path is '' -
  // a .glb is self-contained, and its OWN embedded textures are ignored
  // (we swap in PS1 .tim data below), so no external resource base is needed.
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(glbArrayBuffer, '', resolve, reject);
  });
  const group = gltf.scene;

  // Collect every material name the parsed model references. In glTF each
  // primitive has exactly ONE material and GLTFLoader makes one mesh per
  // primitive, so a multi-material Blender object arrives as several
  // single-material meshes - simpler than OBJLoader's material arrays. An
  // untextured primitive's material has an empty name; bucket those as
  // '(none)' to match the PS1 converter's synthetic material.
  const materialNames = [];
  group.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) materialNames.push(m.name || '(none)');
  });

  // Resolve names -> decoded .tim BEFORE building viewer materials, because
  // buildViewerMaterial() looks each one up in the resolved map.
  const materialsMap = await resolveByNames(materialNames);

  // Build the viewer-side replacement material for ONE source material.
  //
  // MeshBasicMaterial (not MeshStandardMaterial): PS1-era assets have no PBR
  // workflow, and Basic avoids lighting-driven color shifts so the viewport
  // matches the flat-shaded PS1 look - it just shows the decoded texture.
  //
  // side: THREE.DoubleSide - Three defaults to backface culling, which would
  // silently hide a mesh whose authored winding comes out "backward" from
  // Three's view. main.c's PS1 renderer does its OWN software winding cull at
  // runtime, so showing both sides here is purely an authoring convenience.
  //
  // material.name is COPIED - load-bearing, not cosmetic:
  // updateInstancePaletteRow() looks materials up BY NAME to rebuild textures
  // for a different CLUT row, so a nameless material breaks palette switching.
  function buildViewerMaterial(sourceMaterial) {
    const matName = sourceMaterial && sourceMaterial.name ? sourceMaterial.name : null;
    const decodedTim = matName ? materialsMap.get(matName) : null;

    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    material.name = matName || '';

    if (decodedTim) {
      material.map = buildDataTexture(decodedTim, 0);
      // PS1 "black = transparent" texels decode with alpha=0. alphaTest
      // discards them without the depth-sorting headaches of transparent=true.
      material.alphaTest = 0.5;
    } else {
      // "Texture missing" flag colour: magenta, or solid white when the
      // Missing=White toggle is on (see setMissingTextureWhite - white is
      // a live brightness probe under the PS1 shading preview). The
      // userData flag is what lets that toggle find these later; it
      // survives Material.clone() and the unlit<->lit conversion.
      material.color.set(missingTextureWhite ? 0xffffff : 0xff00ff);
      material.userData.missingTexture = true;
    }

    return material;
  }

  group.traverse((child) => {
    if (!child.isMesh) return;
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

  return materialsMap;
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
 * add it to the stage, and track it under `id`.
 *
 * `materialsMap` is the SAME Map<materialName, decodedTim|null> that was
 * passed to loadModelIntoStage() for this model (app.js keeps it around on
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

  // Templates are always built with unlit MeshBasicMaterial; if the PS1
  // lighting preview is active, a freshly spawned instance must arrive
  // already converted to lit materials or it would render full-bright
  // amid an otherwise-lit stage.
  if (ps1LightingEnabled) applyLightingModeToObject(object3D, true);

  // Missing-texture flag colour tracks the CURRENT Missing=White toggle,
  // not whichever state happened to be active when this model's template
  // was built.
  applyMissingTextureColor(object3D);

  stage.add(object3D);

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
  // came from the template, which loadModelIntoStage() always builds at
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
// (ids never collide - StageState hands out one shared id sequence), so
// click-selection raycasts, TransformControls attachment, removal, and
// frame-selected all work on them with zero extra plumbing. Entries are
// marked `isEntity: true` so the systems where a marker gizmo must NOT
// behave like world geometry - freecam walking, seam-snap neighbors,
// surface-snap raycast targets - can skip them.
//
// Colors mirror stage_state.js's ENTITY_KINDS (CSS side). Keep in sync.
const ENTITY_COLORS = {
  trigger: 0xff8c42,
  spawn: 0x5dd06a,
  summon: 0xb06ee0,
  particle: 0xffd23c,
  billboard: 0x3ec6dc,
  sound: 0xe05d8a,
  light: 0xffe066,
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

/** Parse an authored '#rrggbb' light color to a THREE-usable hex int,
 * falling back to the Light kind's tint for anything malformed (a
 * half-typed value should never throw or blank the marker). */
function parseLightColor(hex) {
  return (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex))
    ? parseInt(hex.slice(1), 16)
    : ENTITY_COLORS.light;
}

/** Wireframe cone opening along -Z (apex at the origin, i.e. the light),
 * sized by a spot's half-angle and range - the spot's visual cone. Built
 * as EdgesGeometry so it reads as a thin outline, not a solid volume. */
function makeSpotConeGeometry(coneAngleDeg, height) {
  const h = Math.max(0.2, height);
  const half = THREE.MathUtils.degToRad(Math.min(89, Math.max(1, coneAngleDeg)));
  const radius = Math.tan(half) * h;
  const cone = new THREE.ConeGeometry(radius, h, 20, 1, true);
  // Default cone apex points +Y; rotate +Y -> +Z then push back by h/2 so
  // the apex sits at the group origin and the mouth opens toward -Z (the
  // same "forward" the directional pointer uses).
  cone.rotateX(Math.PI / 2);
  cone.translate(0, 0, -h / 2);
  return new THREE.EdgesGeometry(cone);
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
  disc.userData.noPick = true; // ground disc is a visual footprint, not a click target
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
      fill.userData.noPick = true; // huge translucent volume - select via the wireframe edges instead
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
      ring.userData.noPick = true; // patrol radius ring can be huge - not a click target
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
      halo.userData.noPick = true; // wireframe halo is decorative - pick the solid core
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
      plane.userData.noPick = true; // billboard quad - select via its wireframe frame
      group.add(plane);
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.2, 0.8)),
        new THREE.LineBasicMaterial({ color })
      );
      frame.position.y = 0.4;
      group.add(frame);
      break;
    }
    case 'sound': {
      // Speaker-ish marker: solid core sphere + two concentric wireframe
      // "emission" shells, plus a ground-plane radius ring (like summon's
      // patrol ring) that live-tracks the falloff radius prop. Radius 0
      // means "global/non-directional" - the ring is hidden then (see
      // applyEntityPropsToMeshes).
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 12, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
      core.position.y = 0.25;
      group.add(core);
      for (const r of [0.3, 0.44]) {
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(r, 12, 8),
          new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.3 })
        );
        shell.position.y = 0.25;
        shell.userData.noPick = true; // emission shells are decorative - pick the solid core
        group.add(shell);
      }
      const ring = new THREE.LineLoop(
        makeCircleGeometry(Math.max(0, props.radius || 0)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
      );
      ring.name = 'soundRadiusRing';
      ring.position.y = 0.02;
      ring.userData.noPick = true; // falloff radius ring can be huge - not a click target
      ring.visible = (props.radius || 0) > 0;
      group.add(ring);
      break;
    }
    case 'light': {
      // One superset marker for all five light types; applyEntityProps
      // ToMeshes toggles which pieces show and resizes them per lightType
      // (like sound's ring), so switching type in the panel never has to
      // rebuild the group. Pieces:
      //   lightCore     - solid bulb, tinted LIVE with the authored color
      //   lightRangeRing- XZ falloff circle (spherical / spot)
      //   lightDirPointer - forward -Z aim rod (directional / spot)
      //   lightSpotCone - wireframe cone showing a spot's angle + range
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 16, 12),
        new THREE.MeshBasicMaterial({ color: parseLightColor(props.color) })
      );
      core.name = 'lightCore';
      core.position.y = 0.25;
      group.add(core);

      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 16, 12),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.28 })
      );
      glow.position.y = 0.25;
      glow.userData.noPick = true; // decorative halo - pick the solid bulb
      group.add(glow);

      const ring = new THREE.LineLoop(
        makeCircleGeometry(Math.max(0, props.range || 0)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
      );
      ring.name = 'lightRangeRing';
      ring.position.y = 0.02;
      ring.userData.noPick = true; // falloff ring can be huge - not a click target
      group.add(ring);

      const pointer = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
      );
      pointer.name = 'lightDirPointer';
      pointer.position.set(0, 0.25, -0.4);
      pointer.userData.noPick = true; // aim rod is context - pick the bulb
      group.add(pointer);

      const spotCone = new THREE.LineSegments(
        makeSpotConeGeometry(props.coneAngle || 30, props.range || 3),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 })
      );
      spotCone.name = 'lightSpotCone';
      spotCone.position.y = 0.25;
      spotCone.userData.noPick = true; // cone outline is context - pick the bulb
      group.add(spotCone);
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

// --------------------------------------------------------------------------
// Optional custom marker shapes (special/<kind>.glb)
// --------------------------------------------------------------------------
//
// If a .glb sits in stage-gen/special named after an entity kind
// (trigger.glb, spawn.glb, summon.glb, billboard.glb, particle.glb,
// sound.glb), it becomes that entity's PICKABLE marker: rendered translucent
// in the kind's existing ENTITY_COLORS tint, and kept a fixed compact size
// (counter-scaled against the entity's transform every frame - see the
// render loop) so selection stays reliable no matter how big the entity's
// volume/radius is. The original large volume visuals (trigger fill box,
// patrol/falloff rings, billboard quad) stay on-screen as non-pickable
// context; only the custom marker grabs clicks. Missing files fall back to
// the built-in markers with zero fuss.
const _customMarkerCache = new Map(); // kind -> Promise<THREE.Object3D | null>
const _markerLoader = new GLTFLoader();

function loadCustomMarkerTemplate(kind) {
  if (_customMarkerCache.has(kind)) return _customMarkerCache.get(kind);
  const p = new Promise((resolve) => {
    _markerLoader.load(
      `special/${kind}.glb`,
      (gltf) => resolve(gltf.scene), // GLTFLoader hands back { scene, ... }
      undefined,
      () => resolve(null) // absent/unreadable file -> keep built-in marker
    );
  });
  _customMarkerCache.set(kind, p);
  return p;
}

function attachCustomMarker(inst) {
  loadCustomMarkerTemplate(inst.kind).then((template) => {
    if (!template || !instances.has(inst.id)) return; // gone/removed while loading
    const group = inst.object3D;
    const color = ENTITY_COLORS[inst.kind] || 0xffffff;

    // Everything already in the group becomes non-pickable; the solid
    // placeholder cores (Meshes that WERE pickable) are hidden since the
    // custom shape replaces them. Volume outlines / rings stay visible.
    for (const child of [...group.children]) {
      const wasPickable = !child.userData.noPick;
      child.userData.noPick = true;
      if (wasPickable && child.isMesh) child.visible = false;
    }

    const markerMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    });
    const wrapper = new THREE.Group();
    wrapper.name = 'customMarker';
    const marker = template.clone(true);
    marker.traverse((o) => {
      if (o.isMesh) { o.material = markerMat; o.userData.noPick = false; }
    });
    wrapper.add(marker);
    group.add(wrapper);
    inst.customMarker = wrapper; // frame loop keeps this a fixed world size
  });
}

export function addEntityHelper(id, kind, initialTransform = {}, props = {}) {
  const group = new THREE.Group();
  const color = ENTITY_COLORS[kind] || 0xffffff;
  buildEntityMeshes(group, kind, color, props);
  stage.add(group);

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
    id,
    object3D: group,
    modelName: `__entity__${kind}`,
    materialTimData: new Map(),
    currentPaletteRow: 0,
    isEntity: true,
    kind,
    props: { ...props },
  });
  const inst = instances.get(id);
  applyEntityPropsToMeshes(inst);
  attachCustomMarker(inst);
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

  if (inst.kind === 'sound') {
    const ring = inst.object3D.getObjectByName('soundRadiusRing');
    if (ring) {
      const r = Math.max(0, inst.props.radius || 0);
      ring.geometry.dispose();
      ring.geometry = makeCircleGeometry(r);
      ring.visible = r > 0; // 0 = global/non-directional, no falloff circle to show
    }
  }

  if (inst.kind === 'light') {
    const type = inst.props.lightType || 'spherical';
    const range = Math.max(0, inst.props.range || 0);
    const hasRange = (type === 'spherical' || type === 'spot');
    const isSpot = type === 'spot';
    const isDir = type === 'directional';

    // Live color tint on the bulb so the swatch edit is visible at once.
    const core = inst.object3D.getObjectByName('lightCore');
    if (core) core.material.color.setHex(parseLightColor(inst.props.color));

    // Falloff ring: spherical/spot only, and only when range > 0
    // (0 = infinite, nothing meaningful to draw).
    const ring = inst.object3D.getObjectByName('lightRangeRing');
    if (ring) {
      ring.geometry.dispose();
      ring.geometry = makeCircleGeometry(range);
      ring.visible = hasRange && range > 0;
    }

    // Aim rod: directional + spot cast along the entity's -Z.
    const pointer = inst.object3D.getObjectByName('lightDirPointer');
    if (pointer) pointer.visible = isDir || isSpot;

    // Spot cone outline, rebuilt from angle + range (fallback height 3
    // when range is infinite so the cone is still visible).
    const spotCone = inst.object3D.getObjectByName('lightSpotCone');
    if (spotCone) {
      spotCone.visible = isSpot;
      if (isSpot) {
        spotCone.geometry.dispose();
        spotCone.geometry = makeSpotConeGeometry(
          inst.props.coneAngle || 30,
          range > 0 ? range : 3
        );
      }
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
 * instances from a freshly-restored StageState snapshot (project load,
 * undo/redo) - it needs a way to enumerate "what's currently shown" from
 * outside this module, since `instances` itself is module-private.
 */
export function getTrackedInstanceIds() {
  return Array.from(instances.keys());
}

/**
 * Like getTrackedInstanceIds(), but returns each tracked id's identity
 * (model name for instances, kind for entities) so callers can tell whether
 * a still-tracked id now represents something DIFFERENT. resyncViewport
 * FromState() uses this to purge a mesh whose id was reused for another
 * model/kind on project load - otherwise it would keep the old visual and
 * only overwrite its transform, leaking the previous stage's objects into
 * the loaded one.
 */
export function getTrackedInstanceMeta() {
  return new Map(
    Array.from(instances.entries()).map(([id, inst]) => [
      id,
      { isEntity: !!inst.isEntity, modelName: inst.modelName, kind: inst.kind },
    ])
  );
}

export function removeInstance(id) {
  const inst = instances.get(id);
  if (!inst) return;

  if (currentTransformTarget === id) {
    transformControls.detach();
    currentTransformTarget = null;
  }

  stage.remove(inst.object3D);
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
      // The PS1 preview material samples via its uniform, with .map kept
      // as a bookkeeping mirror (see buildPS1LitMaterial) - update both.
      if (mat.isShaderMaterial) mat.uniforms.map.value = mat.map;
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
// PS1 lighting parity preview ("PS1" shading toggle, top-right overlay)
// ==========================================================================
//
// Emulates what THIS stage will look like under the runtime's GTE lighting
// path (main.c: load_stage_lights + compute_object_lighting via gte_ncs -
// see PS1_GTE_LIGHTING_SEMANTICS.txt sections 5-6), so an author can grasp
// the shipped look without leaving the tool. What is emulated, and what is
// deliberately NOT:
//
//   - AUTHORED LIGHTS ONLY, exactly like the runtime: up to THREE
//     directional Light entities (the GTE light matrix has three rows;
//     the runtime consumes the first three in stage order, so this
//     preview takes the first three in the same order) plus AMBIENT
//     entities summed into one ambient term. A stage with no authored
//     directionals genuinely goes directional-less here too - there is no
//     recovery sun (semantics doc 5.7), and deleting the seeded "Sun"
//     shows exactly the unlit stage the runtime would render.
//   - ONE-SIDED, NO-FALLOFF directionals with the runtime's EXACT transfer
//     function, implemented in a custom shader (not a stock Three.js lit
//     material, whose curve is half as hot and lacks the intermediate
//     clamp). Derived from the GTE register math (unit colour bake
//     channel<<7, 1024-magnitude normals, MAC>>4 output):
//
//       lit   = min(BK + sum_i( 2 * colour_i * intensity_i * max(0, N.L_i) ), 1.0)
//       final = texel * lit * 255/128     (textured - PS1 modulation, 128 == 1.0)
//       final = lit                       (untextured - flat prims ARE the lit colour)
//
//     Consequences, matching the console: a fully-facing face saturates
//     at intensity*dot == 0.5 (authored 1.0 white is deliberately "hot");
//     brightness rises linearly until the per-channel clamp; the VISUAL
//     ceiling lands around 4x intensity (runtime INT=1024) because by
//     then everything down to dot=1/8 is already clamped white - only
//     grazing faces still respond. Faces away from every light fall to
//     the ambient floor (black if no ambient is authored), like gte_ncs.
//   - SPHERICAL (point) lights contribute per fragment with the same 2x
//     curve times a linear range falloff (doc 8.3):
//
//       lit += 2 * colour * intensity * clamp(1 - dist/range, 0, 1) * max(0, N.L)
//
//     Per-fragment falloff is exactly what STATIC-mobility lights (the
//     default) will bake to per vertex offline. The runtime's interim
//     dynamic path instead evaluates direction + attenuation once per
//     OBJECT and packs only the brightest spheres into the GTE slots the
//     authored directionals left free - so in-game, point light is
//     flatter across large meshes and capped at 3 simultaneous lights
//     per object; this preview is the bake-accurate reference.
//   - SPOT / DEBUG lights contribute NOTHING, because they contribute
//     nothing at runtime today (spot awaits the offline vertex bake -
//     semantics doc section 8). When that lands, this preview should grow
//     to match it.
//   - MATERIALS swap MeshBasicMaterial (unlit full-bright, the editor
//     look) <-> the custom GTE shader above. Smooth vertex normals give a
//     Gouraud-style result, matching the runtime's use_vertex_light mode.
//     Non-uniform scale skews normals here exactly like it does on the
//     console (both use the plain rotation, not inverse-transpose - doc
//     5.7).
//   - MISSING-TEXTURE materials render untextured (no modulation). With
//     the "Missing=White" toolbar toggle they turn solid white, which
//     under this preview displays the raw lit colour - a live probe for
//     the exact brightness the runtime would output.
//   - ENTITY MARKERS (spawn cones, trigger boxes, the light bulbs
//     themselves...) stay unlit on purpose: they are editor UI, not stage
//     geometry, and must stay readable in a pitch-black stage.
//
// NOT gamma/dither/wobble-accurate - this previews the LIGHTING model,
// not the console's rasterizer.

const PS1_LIT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    // World-space normal via the model matrix's rotation. Non-uniform
    // scale would want the inverse-transpose; ignored DELIBERATELY to
    // match the runtime, which ignores it too (semantics doc 5.7).
    vWorldNormal = mat3(modelMatrix) * normal;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PS1_LIT_FRAG = /* glsl */ `
  uniform sampler2D map;        // real texture, or the 1x1 white fallback
  uniform float uAlphaTest;     // PS1 black==transparent texel discard
  uniform float texFactor;      // 255/128 textured (PS1 modulation), 1 untextured
  uniform vec3 baseColor;       // material tint (white / missing-texture flag)
  uniform vec3 psAmbient;       // BK back colour, 0..1
  uniform vec3 psLightDir[3];   // unit vectors TOWARD each light
  uniform vec3 psLightColor[3]; // authored colour * intensity (black == unused)
  uniform vec3 psSphPos[${PS1_MAX_PREVIEW_SPHERES}];    // spherical: world position
  uniform vec3 psSphColor[${PS1_MAX_PREVIEW_SPHERES}];  // spherical: colour * intensity
  uniform float psSphRange[${PS1_MAX_PREVIEW_SPHERES}]; // spherical: range, 0 == infinite
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vec4 texel = texture2D(map, vUv);
    if (texel.a < uAlphaTest) discard;

    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n; // DoubleSide: light the visible side

    // The GTE lighting sum: ambient + 2*colour*intensity*max(0,dot),
    // clamped per channel - the same one-sided clamp-at-255 gte_ncs does.
    vec3 lit = psAmbient;
    for (int i = 0; i < 3; i++)
      lit += psLightColor[i] * (2.0 * max(dot(n, psLightDir[i]), 0.0));

    // Spherical (point) lights: same 2x curve, times a linear range
    // falloff (doc 8.3). Evaluated per fragment, which previews the
    // OFFLINE VERTEX BAKE static lights are destined for; the runtime's
    // interim dynamic path evaluates direction/attenuation once per
    // OBJECT and competes for free GTE slots, so in-game dynamic point
    // light is flatter across large meshes than this preview.
    for (int i = 0; i < ${PS1_MAX_PREVIEW_SPHERES}; i++) {
      vec3 toLight = psSphPos[i] - vWorldPos;
      float dist = max(length(toLight), 1e-5);
      float atten = psSphRange[i] > 0.0
        ? clamp(1.0 - dist / psSphRange[i], 0.0, 1.0)
        : 1.0;
      lit += psSphColor[i] * (2.0 * atten * max(dot(n, toLight / dist), 0.0));
    }

    lit = min(lit, vec3(1.0));

    gl_FragColor = vec4(baseColor * texel.rgb * lit * texFactor, 1.0);
    #include <colorspace_fragment>
  }
`;

// 1x1 white fallback so the sampler uniform is always bound; also what
// makes an untextured material's texel term a no-op. Never disposed.
let whiteFallbackTexture = null;

function getWhiteFallbackTexture() {
  if (!whiteFallbackTexture) {
    whiteFallbackTexture = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat
    );
    whiteFallbackTexture.needsUpdate = true;
  }
  return whiteFallbackTexture;
}

/** Build one PS1-preview material. Light state comes from the SHARED
 * ps1LightUniforms objects (referenced, not cloned), so per-frame light
 * updates reach every material without touching them individually. */
function buildPS1LitMaterial(srcColor, map, alphaTest, side) {
  const material = new THREE.ShaderMaterial({
    vertexShader: PS1_LIT_VERT,
    fragmentShader: PS1_LIT_FRAG,
    side,
    uniforms: {
      map: { value: map || getWhiteFallbackTexture() },
      uAlphaTest: { value: map ? alphaTest || 0 : 0 },
      texFactor: { value: map ? 255 / 128 : 1 },
      baseColor: { value: srcColor.clone() },
      psAmbient: ps1LightUniforms.psAmbient,
      psLightDir: ps1LightUniforms.psLightDir,
      psLightColor: ps1LightUniforms.psLightColor,
      psSphPos: ps1LightUniforms.psSphPos,
      psSphColor: ps1LightUniforms.psSphColor,
      psSphRange: ps1LightUniforms.psSphRange,
    },
  });
  // Bookkeeping mirrors of the Basic material's properties, so palette-row
  // rebuilds (which read/assign .map), disposal, and conversion back to
  // Basic don't need special cases beyond "is it a ShaderMaterial".
  material.map = map || null;
  material.alphaTest = alphaTest || 0;
  return material;
}

const _ps1AimDir = new THREE.Vector3();

/**
 * Re-derive the PS1 rig from the stage's authored Light entities. Runs
 * every frame while the preview is active (see renderLoop) so gizmo drags
 * and property scrubs on lights relight the viewport live.
 */
function updatePS1LightsFromEntities() {
  const directionals = [];
  const spheres = [];
  let ar = 0;
  let ag = 0;
  let ab = 0;

  // instances is a Map and Maps iterate in insertion order, which matches
  // the state's entity order - the same order stage_export.js emits and
  // the runtime's load_stage_lights() consumes its first three
  // directionals from. So "first 3 here" == "first 3 on the console".
  for (const inst of instances.values()) {
    if (!inst.isEntity || inst.kind !== 'light') continue;
    if (inst.props.disabled) continue; // per-light Disabled tickbox: authored off, same skip the runtime does
    const type = inst.props.lightType || 'spherical';
    const intensity = Math.max(0, inst.props.intensity ?? 1);

    if (type === 'directional') {
      if (directionals.length < 3) directionals.push({ inst, intensity });
    } else if (type === 'ambient') {
      // Ambients SUM into one back-colour term, exactly like the runtime
      // folding every authored ambient into BK (clamped per channel).
      const c = new THREE.Color(parseLightColor(inst.props.color));
      ar += c.r * intensity;
      ag += c.g * intensity;
      ab += c.b * intensity;
    } else if (type === 'spherical') {
      // Both mobilities preview identically: per-fragment falloff IS what
      // static lights bake to, and the runtime's interim dynamic path
      // approximates the same math per object (see the shader comment).
      if (spheres.length < PS1_MAX_PREVIEW_SPHERES) spheres.push({ inst, intensity });
    }
    // spot / debug: intentionally ignored - they are not lit by the
    // runtime yet either (see this section's header comment).
  }

  ps1LightUniforms.psAmbient.value.setRGB(Math.min(1, ar), Math.min(1, ag), Math.min(1, ab));

  for (let i = 0; i < 3; i++) {
    const colorU = ps1LightUniforms.psLightColor.value[i];
    const dirU = ps1LightUniforms.psLightDir.value[i];
    const entry = directionals[i];
    if (!entry) {
      colorU.setRGB(0, 0, 0); // unused GTE light-matrix row == zeroed
      continue;
    }

    // Colour * intensity, the shader's per-light coefficient. Authored 0
    // stays a valid "off" (black coefficient, light contributes nothing).
    colorU.setHex(parseLightColor(entry.inst.props.color)).multiplyScalar(entry.intensity);

    // The light AIMS along its marker's world -Z (the dirPointer rod, the
    // same forward convention stage_export.js's lightDirFromRot encodes);
    // the shader wants the unit vector TOWARD the light, i.e. its negation.
    entry.inst.object3D.updateWorldMatrix(true, false);
    _ps1AimDir.set(0, 0, -1).transformDirection(entry.inst.object3D.matrixWorld);
    dirU.copy(_ps1AimDir).negate();
  }

  for (let i = 0; i < PS1_MAX_PREVIEW_SPHERES; i++) {
    const colorU = ps1LightUniforms.psSphColor.value[i];
    const entry = spheres[i];
    if (!entry) {
      colorU.setRGB(0, 0, 0); // unused slot: black coefficient == no light
      continue;
    }
    colorU.setHex(parseLightColor(entry.inst.props.color)).multiplyScalar(entry.intensity);
    entry.inst.object3D.updateWorldMatrix(true, false);
    entry.inst.object3D.getWorldPosition(ps1LightUniforms.psSphPos.value[i]);
    ps1LightUniforms.psSphRange.value[i] = Math.max(0, entry.inst.props.range || 0);
  }
}

/** Build the unlit/lit counterpart of one instance material, carrying over
 * everything load-bearing: name (palette-row rebuilds look materials up BY
 * NAME - see updateInstancePaletteRow), map, alphaTest (PS1 black=
 * transparent texels), side, color (including the missing-texture flag
 * colour), and userData (which carries the missingTexture flag itself). */
function buildCounterpartMaterial(mat, lit) {
  const srcColor = mat.isShaderMaterial ? mat.uniforms.baseColor.value : mat.color;
  let next;
  if (lit) {
    next = buildPS1LitMaterial(srcColor, mat.map || null, mat.alphaTest || 0, mat.side);
  } else {
    next = new THREE.MeshBasicMaterial({ color: srcColor.clone(), side: mat.side });
    next.map = mat.map || null;
    next.alphaTest = mat.alphaTest || 0;
  }
  next.name = mat.name;
  next.userData = { ...mat.userData };
  next.needsUpdate = true;
  return next;
}

/** Swap every mesh material on one instance between unlit (editor) and lit
 * (PS1 preview). The old material is disposed but its texture map is NOT -
 * it transfers to the replacement (removeInstance still owns final map
 * disposal). Already-correct materials pass through untouched, so this is
 * cheap to call redundantly. */
function applyLightingModeToObject(object3D, lit) {
  object3D.traverse((child) => {
    if (!child.isMesh) return;
    const convert = (m) => {
      if (lit ? m.isShaderMaterial : m.isMeshBasicMaterial) return m;
      const next = buildCounterpartMaterial(m, lit);
      m.dispose();
      return next;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(convert)
      : convert(child.material);
  });
}

/**
 * Enable/disable the PS1 lighting parity preview. Swaps which rig is
 * visible and converts every MODEL instance's materials (entity markers
 * are editor UI and stay unlit - see the section header). Returns the
 * resulting state so the caller can reflect it in the toggle UI.
 */
export function setPS1LightingEnabled(enabled) {
  const next = !!enabled;
  if (next === ps1LightingEnabled) return ps1LightingEnabled;
  ps1LightingEnabled = next;

  for (const inst of instances.values()) {
    if (inst.isEntity) continue;
    applyLightingModeToObject(inst.object3D, next);
  }

  if (next) updatePS1LightsFromEntities();
  return ps1LightingEnabled;
}

/** Whether the PS1 lighting parity preview is currently active. */
export function isPS1LightingEnabled() {
  return ps1LightingEnabled;
}

/** Recolour every missing-texture material on one instance to match the
 * CURRENT Missing=White toggle. Works on both material types. */
function applyMissingTextureColor(object3D) {
  const hex = missingTextureWhite ? 0xffffff : 0xff00ff;
  object3D.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m.userData.missingTexture) continue;
      if (m.isShaderMaterial) m.uniforms.baseColor.value.setHex(hex);
      else m.color.setHex(hex);
    }
  });
}

/**
 * Toggle how missing-texture materials display: magenta flag colour
 * (default) or solid white. White is the useful probe under the PS1
 * preview: an untextured white face shows the raw lit colour, i.e. the
 * exact brightness the runtime's flat prims would output. Returns the
 * resulting state for the UI.
 */
export function setMissingTextureWhite(enabled) {
  missingTextureWhite = !!enabled;
  for (const inst of instances.values()) {
    if (inst.isEntity) continue;
    applyMissingTextureColor(inst.object3D);
  }
  return missingTextureWhite;
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
 * Collect every mesh currently placed in the stage that walk-mode's ground
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
// runs once per stage change instead of 60x/sec.
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
