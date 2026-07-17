/*
 * history.js
 *
 * Snapshot-based undo/redo for stage-gen's editor state.
 *
 * ----------------------------------------------------------------------
 * WHY SNAPSHOTS, NOT COMMAND OBJECTS
 * ----------------------------------------------------------------------
 * A "command pattern" undo stack (each action pushes a {do, undo} pair)
 * is more memory-efficient, but stage_state.js's StageState is already
 * fully JSON-serializable plain data (instances, camera, nextId,
 * selectedInstanceId - see its own header comment: no live handles or
 * Three.js objects live on state itself, those stay in viewer.js). That
 * makes snapshotting trivial and, more importantly, ROBUST: every future
 * mutation automatically gets undo support for free just by wrapping it
 * in pushHistory()/no code changes needed elsewhere, rather than having
 * to hand-write a paired inverse for every single state-mutating action
 * (easy to forget one and silently break undo for it). Stage sizes in
 * this tool (tens of instances, not thousands) make the extra memory of
 * full snapshots a non-issue.
 *
 * The one thing snapshots do NOT cover is viewer.js's live Three.js stage
 * graph (Object3D instances, materials, textures) - that's not
 * serializable and doesn't need to be, since app.js already has a proven
 * pattern for resyncing the viewport FROM a plain StageState snapshot:
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
 * Deep-clone a StageState's serializable fields into a plain snapshot
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
      name: inst.name,
      parentId: inst.parentId,
      pos: { ...inst.pos },
      rot: { ...inst.rot },
      scale: { ...inst.scale },
    })),
    // Folder objects are flat plain data ({ id, name, parentId,
    // collapsed }), so a shallow per-folder spread is a full deep clone.
    // collapsed riding along in snapshots is deliberate-but-harmless:
    // collapse toggles never PUSH history themselves (they're a view
    // preference), but restoring an older snapshot restores the collapse
    // state it was taken with, which keeps what the user SEES after an
    // undo consistent with what they saw when that state was current.
    folders: state.folders.map((folder) => ({ ...folder })),
    // Entities: pos/rot/scale/props each need their own clone (they're
    // nested one level deep); props values are all primitives per the
    // ENTITY_KINDS schemas, so a spread of props is a full deep clone.
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
    camera: {
      pos: { ...state.camera.pos },
      rot: { ...state.camera.rot },
    },
    selectedInstanceId: state.selectedInstanceId,
    selectedFolderId: state.selectedFolderId,
    nextId: state.nextId,
    nextSpawnId: state.nextSpawnId,
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
