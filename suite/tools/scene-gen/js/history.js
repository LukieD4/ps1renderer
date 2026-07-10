/*
 * history.js
 *
 * Snapshot-based undo/redo for scene-gen's editor state.
 *
 * ----------------------------------------------------------------------
 * WHY SNAPSHOTS, NOT COMMAND OBJECTS
 * ----------------------------------------------------------------------
 * A "command pattern" undo stack (each action pushes a {do, undo} pair)
 * is more memory-efficient, but scene_state.js's SceneState is already
 * fully JSON-serializable plain data (instances, camera, nextId,
 * selectedInstanceId - see its own header comment: no live handles or
 * Three.js objects live on state itself, those stay in viewer.js). That
 * makes snapshotting trivial and, more importantly, ROBUST: every future
 * mutation automatically gets undo support for free just by wrapping it
 * in pushHistory()/no code changes needed elsewhere, rather than having
 * to hand-write a paired inverse for every single state-mutating action
 * (easy to forget one and silently break undo for it). Scene sizes in
 * this tool (tens of instances, not thousands) make the extra memory of
 * full snapshots a non-issue.
 *
 * The one thing snapshots do NOT cover is viewer.js's live Three.js scene
 * graph (Object3D instances, materials, textures) - that's not
 * serializable and doesn't need to be, since app.js already has a proven
 * pattern for resyncing the viewport FROM a plain SceneState snapshot:
 * the project-load handler (see app.js's fileLoadProject listener) does
 * exactly that. applyHistorySnapshot() below reuses that same resync
 * approach: clear every current instance from the viewport, then re-add
 * one per instance in the restored snapshot for any model already loaded
 * in state.models.
 */

const MAX_HISTORY = 100; // cap so undo doesn't grow unbounded over a long session

let undoStack = [];
let redoStack = [];

// Guard against re-entrant snapshotting: applyHistorySnapshot() below
// mutates `state` (the same object every other mutation touches), and if
// that mutation path were to ALSO call pushHistory() (it doesn't today,
// but this guard makes that mistake harmless rather than corrupting the
// stacks with a snapshot-of-a-snapshot), the push is skipped while a
// restore is in progress.
let isRestoring = false;

/**
 * Deep-clone a SceneState's serializable fields into a plain snapshot
 * object. Deliberately does NOT use structuredClone/JSON round-trip on
 * the whole `state` object, since state.models is a Map of large,
 * non-serializable data (dirHandle, decoded .tim Uint8Arrays) that must
 * never be part of undo/redo - only instances/camera/nextId/
 * selectedInstanceId are.
 */
function snapshot(state) {
  return {
    instances: state.instances.map((inst) => ({
      id: inst.id,
      model: inst.model,
      palette: inst.palette,
      pos: { ...inst.pos },
      rot: { ...inst.rot },
      scale: { ...inst.scale },
    })),
    camera: {
      pos: { ...state.camera.pos },
      rot: { ...state.camera.rot },
    },
    selectedInstanceId: state.selectedInstanceId,
    nextId: state.nextId,
  };
}

/**
 * Call this BEFORE making a mutation you want to be undoable. Pushes the
 * CURRENT (pre-mutation) state onto the undo stack. Any pending redo
 * history is cleared - once the user makes a new change after undoing,
 * the old "future" is no longer reachable, matching every conventional
 * undo/redo implementation (browsers, editors, etc.).
 */
export function pushHistory(state) {
  if (isRestoring) return;

  undoStack.push(snapshot(state));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

/**
 * Pop the most recent snapshot off the undo stack and apply it, pushing
 * the state we were just AT onto the redo stack first (so redo can bring
 * it back). Returns true if an undo actually happened.
 */
export function undo(state, applySnapshot) {
  if (undoStack.length === 0) return false;

  redoStack.push(snapshot(state));
  const previous = undoStack.pop();

  isRestoring = true;
  applySnapshot(previous);
  isRestoring = false;

  return true;
}

/**
 * Inverse of undo(): pop the most recent snapshot off the redo stack and
 * apply it, pushing the current state onto the undo stack first.
 */
export function redo(state, applySnapshot) {
  if (redoStack.length === 0) return false;

  undoStack.push(snapshot(state));
  const next = redoStack.pop();

  isRestoring = true;
  applySnapshot(next);
  isRestoring = false;

  return true;
}

/**
 * Reset both stacks - called when a brand new project is loaded, since
 * undoing "into" a different loaded project's history would be
 * meaningless and confusing.
 */
export function clearHistory() {
  undoStack = [];
  redoStack = [];
}
