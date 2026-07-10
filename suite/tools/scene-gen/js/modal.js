/*
 * modal.js
 *
 * Promise-based HTML confirm dialog - replaces window.confirm(), the last
 * remaining native browser prompt in this tool (alert() was already
 * replaced by toast.js). Native prompts block the entire tab, look
 * nothing like the tool, and can't be styled or keyboard-tuned; this is a
 * styled in-page overlay with the same one-call ergonomics.
 *
 * Usage:
 *   const ok = await showConfirm({
 *     title: 'Delete instance',
 *     message: 'Delete instance #3 (House)?',
 *     confirmText: 'Delete',
 *     cancelText: 'Cancel',
 *   });
 *
 * Keyboard: Enter confirms, Escape cancels. While the dialog is open, a
 * capture-phase keydown handler stops events from reaching the app's
 * global shortcut listeners (otherwise pressing Delete to dismiss a
 * "delete?" dialog would immediately trigger a SECOND delete on the
 * next selected instance, etc.).
 *
 * DOM is built lazily on first use and reused afterward - one overlay
 * element for the app's lifetime.
 */

let overlayEl = null;
let titleEl = null;
let messageEl = null;
let confirmBtn = null;
let cancelBtn = null;

let activeResolve = null; // non-null while a dialog is open
let previousFocus = null; // element to restore focus to on close

function buildDom() {
  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay hidden';

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  titleEl = document.createElement('h3');
  titleEl.className = 'modal-title';
  dialog.appendChild(titleEl);

  messageEl = document.createElement('p');
  messageEl.className = 'modal-message';
  dialog.appendChild(messageEl);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.addEventListener('click', () => close(false));
  actions.appendChild(cancelBtn);

  confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-accent';
  confirmBtn.addEventListener('click', () => close(true));
  actions.appendChild(confirmBtn);

  dialog.appendChild(actions);
  overlayEl.appendChild(dialog);

  // Clicking the dimmed backdrop (not the dialog itself) cancels - the
  // conventional "tap outside to dismiss" affordance.
  overlayEl.addEventListener('click', (event) => {
    if (event.target === overlayEl) close(false);
  });

  document.body.appendChild(overlayEl);
}

// Capture-phase so this runs BEFORE app.js's window-level shortcut
// listeners (undo/delete/duplicate/save etc.) and can swallow the event
// entirely while a dialog is open.
window.addEventListener(
  'keydown',
  (event) => {
    if (activeResolve === null) return;

    event.stopPropagation();

    if (event.key === 'Enter') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
    }
  },
  true
);

function close(result) {
  if (activeResolve === null) return;
  const resolve = activeResolve;
  activeResolve = null;

  overlayEl.classList.add('hidden');
  if (previousFocus && previousFocus.focus) previousFocus.focus();
  previousFocus = null;

  resolve(result);
}

/**
 * Show a confirm dialog. Resolves true (confirm) or false (cancel /
 * Escape / backdrop click). If a dialog is somehow already open, the
 * previous one is cancelled first - dialogs never stack.
 */
export function showConfirm({ title = 'Confirm', message = '', confirmText = 'OK', cancelText = 'Cancel' } = {}) {
  if (!overlayEl) buildDom();
  if (activeResolve !== null) close(false);

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;

  previousFocus = document.activeElement;
  overlayEl.classList.remove('hidden');
  confirmBtn.focus();

  return new Promise((resolve) => {
    activeResolve = resolve;
  });
}
