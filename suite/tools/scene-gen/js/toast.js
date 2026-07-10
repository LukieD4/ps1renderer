/*
 * toast.js
 *
 * Small non-blocking notification module, replacing alert() for routine
 * messages (load errors, palette-range warnings, "model not loaded yet"
 * notices). alert() halts the ENTIRE page - including the render loop's
 * requestAnimationFrame calls are technically still scheduled, but the
 * user can't interact with anything, including the 3D viewport, until
 * they dismiss it - which is disproportionate for a routine warning the
 * user should be free to keep working around. Toasts stack in the
 * bottom-right corner, auto-dismiss after a delay (longer for errors than
 * info), and can also be dismissed by clicking them.
 *
 * Yes/no questions (delete confirmation) are handled by modal.js - our
 * own promise-based HTML dialog - since a toast can't collect an answer
 * and window.confirm() has the same page-blocking problem alert() does.
 */

let containerEl = null;

function ensureContainer() {
  if (containerEl) return containerEl;
  containerEl = document.createElement('div');
  containerEl.id = 'toast-container';
  document.body.appendChild(containerEl);
  return containerEl;
}

/**
 * Show a toast message. `kind` controls styling and auto-dismiss timing:
 *   'error'   - red accent, stays up longer (8s) - something failed
 *   'warning' - amber accent, medium duration (6s) - non-fatal issue
 *   'info'    - default accent, shorter duration (4s) - routine notice
 */
export function showToast(message, kind = 'info') {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${kind}`;
  toast.textContent = message;

  const dismiss = () => {
    toast.classList.add('toast--closing');
    // Wait for the CSS fade-out transition (see tool.css) before actually
    // removing the node, so it animates out instead of popping away.
    setTimeout(() => toast.remove(), 200);
  };

  toast.addEventListener('click', dismiss);

  container.appendChild(toast);

  const duration = kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 4000;
  setTimeout(dismiss, duration);
}

export function showError(message) {
  showToast(message, 'error');
}

export function showWarning(message) {
  showToast(message, 'warning');
}

export function showInfo(message) {
  showToast(message, 'info');
}
