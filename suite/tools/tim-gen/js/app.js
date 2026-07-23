/**
 * app.js  (bootstrap)
 * Initializes the tab shell and both tabs, wires the shared transport
 * (load/save project, export PNG, export .tim), and keeps the transport
 * status + button states in sync with the shared state.
 */
(function (global) {
  "use strict";
  const TG = global.TG;

  function $(id) { return document.getElementById(id); }

  // ---- TIM export ------------------------------------------------------

  function exportTim() {
    const image = TG.state.image;
    const manager = TG.palTab.getManager();
    if (!image || !TG.imgTab.hasImage() || !manager.palettes.length) {
      TG.ui.toast("Load an image and add at least one palette first", "error");
      return;
    }
    const bpp = image.bpp;
    const active = manager.getActive();
    // Bake each CLUT (slider + lock layer flattened) into one row, in list
    // order — row 0 is the top of the palette list.
    const palettes = manager.palettes.map((p) => p.bake());
    try {
      const result = TG.tim.exportTim({
        indices: image.indices,
        width: image.width,
        height: image.height,
        bpp,
        palettes,
        clutX: 0,
        clutY: 480, // clear of the typical framebuffer; tweak in VRAM tooling
        vramX: 0,
        vramY: 0,
        preventTransparency: active ? active.preventTransparency : true,
      }, TG.project.baseName(TG.imgTab.getFileName()));
      TG.ui.toast(`Exported ${result.clutHeight} CLUT row(s) as a ${bpp}bpp .tim`);
    } catch (e) {
      TG.ui.toast(e.message || "TIM export failed", "error");
    }
  }

  // ---- transport sync --------------------------------------------------

  let elBtnSave, elBtnPng, elBtnTim, elStatus;

  function refreshTransport() {
    const hasImg = TG.imgTab.hasImage();
    const hasBlock = TG.state.hasImageBlock();
    const clutCount = (TG.state.cluts || []).length;

    elBtnSave.disabled = !(hasImg || clutCount > 0);
    elBtnPng.disabled = !hasImg;

    const tooManyFor4bpp = hasBlock && TG.state.image.bpp === 4 && TG.state.image.basePalette.length > 16;
    elBtnTim.disabled = !(hasBlock && clutCount > 0) || tooManyFor4bpp;
    elBtnTim.title = !hasBlock
      ? "Load an image in the Image tab first"
      : clutCount === 0
        ? "Add a palette in the Palettes tab"
        : `Export ${clutCount} CLUT row(s) as one ${TG.state.image.bpp}bpp .tim`;

    if (hasImg) {
      const img = TG.state.image;
      elStatus.textContent = `${TG.imgTab.getFileName()} · ${img.bpp}bpp / ${img.basePalette.length} colors · ${clutCount} CLUT${clutCount === 1 ? "" : "s"}`;
    } else {
      elStatus.textContent = "No image loaded";
    }
  }

  // ---- boot ------------------------------------------------------------

  function boot() {
    TG.imgTab.init();
    TG.palTab.init();
    TG.tabs.init();

    elBtnSave = $("btn-save-project");
    elBtnPng = $("btn-export-png");
    elBtnTim = $("btn-export-tim");
    elStatus = $("transport-status");

    const loadInput = $("load-project-input");
    $("btn-load-project").addEventListener("click", () => loadInput.click());
    loadInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) TG.project.loadFile(f);
      loadInput.value = "";
    });
    elBtnSave.addEventListener("click", () => TG.project.save());
    elBtnPng.addEventListener("click", () => TG.project.exportPng());
    elBtnTim.addEventListener("click", exportTim);

    TG.state.on("status", refreshTransport);
    TG.state.on("image-block", refreshTransport);
    TG.state.on("cluts", refreshTransport);
    TG.state.on("tab", refreshTransport);
    refreshTransport();

    // Warn before losing unsaved work once an image is loaded.
    window.addEventListener("beforeunload", (e) => {
      if (TG.imgTab.hasImage()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
