/**
 * core_ui.js
 * Small shared UI primitives used by both tabs: toast notifications, a
 * reusable dropzone binder, and a lightweight confirm modal (replacing
 * window.confirm so the re-base warning matches the suite's styling).
 *
 * Exposed as window.TG.ui.
 */
(function (global) {
  "use strict";

  const TG = (global.TG = global.TG || {});

  // --- Toast ------------------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(message, kind) {
    if (!toastEl) toastEl = document.getElementById("toast");
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("is-error", kind === "error");
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 2800);
  }

  // --- Dropzone binder --------------------------------------------------
  // Wires drag-over highlight + drop + click-to-browse for a labelled
  // dropzone containing a file <input>. onFile receives a File.
  function bindDropzone(zoneEl, inputEl, onFile) {
    if (!zoneEl) return;
    ["dragover", "dragenter"].forEach((evt) =>
      zoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        zoneEl.classList.add("is-dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      zoneEl.addEventListener(evt, (e) => {
        e.preventDefault();
        zoneEl.classList.remove("is-dragover");
      })
    );
    zoneEl.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    if (inputEl) {
      inputEl.addEventListener("change", (e) => {
        const f = e.target.files[0];
        if (f) onFile(f);
        inputEl.value = ""; // allow re-selecting the same file later
      });
    }
  }

  // --- Confirm modal ----------------------------------------------------
  // Returns a Promise<boolean>. Styled via .modal-* classes in tool.css.
  function confirmModal({ title, message, confirmLabel, cancelLabel, danger }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h2 class="modal-title">${title || "Confirm"}</h2>
          <p class="modal-message">${message || ""}</p>
          <div class="modal-actions">
            <button class="btn" data-act="cancel">${cancelLabel || "Cancel"}</button>
            <button class="btn ${danger ? "btn--danger" : "btn--primary"}" data-act="ok">${confirmLabel || "OK"}</button>
          </div>
        </div>`;
      function close(val) {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") close(false);
        if (e.key === "Enter") close(true);
      }
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(false);
        const act = e.target.getAttribute("data-act");
        if (act === "ok") close(true);
        if (act === "cancel") close(false);
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
      const ok = overlay.querySelector('[data-act="ok"]');
      if (ok) ok.focus();
    });
  }

  TG.ui = { toast, bindDropzone, confirmModal };
})(window);
