/**
 * pal_tab.js  (Tab 2 — Palettes / CLUTs)
 * Consumes Tab 1's image block (base palette + index buffer, read-only) and
 * lets the user author recolored CLUT variants. Renders the palette list,
 * base + active swatch grids, the quick-edit sliders, and the dual preview.
 *
 * Handoff / re-base (the whole point of the merge):
 *   - "image-block" arrives whenever Tab 1 rebuilds. Same color count →
 *     silent re-base (unlocked slots follow the new base, locks survive);
 *     different count / structural → CLUTs reset to one default palette.
 *   - Notifications are coalesced and only shown once the user has actually
 *     started working in Tab 2, so ordinary Tab 1 tweaking stays quiet.
 *
 * Exposes window.TG.palTab.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const { color } = TG;
  const MAX = () => TG.palModel.PaletteManager.MAX_PALETTES;

  const manager = new TG.palModel.PaletteManager();
  let userTouched = false;      // has the user done anything in Tab 2 yet?
  let notifyTimer = null;
  const els = {};
  let viewport = null;

  function $(id) { return document.getElementById(id); }

  function publishCluts() {
    TG.state.cluts = manager.palettes;
    TG.state.activeClut = manager.activeIndex;
    TG.state.emit("cluts", { cluts: manager.palettes, activeClut: manager.activeIndex });
    TG.state.emit("status");
  }

  function coalescedNotify(msg) {
    if (!userTouched) return;
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => TG.ui.toast(msg), 500);
  }

  // ---- handoff from Tab 1 ---------------------------------------------

  function onImageBlock(payload) {
    const image = payload && payload.image;
    if (!image || !image.basePalette) return;
    const base = image.basePalette;

    const structural = payload.structural || !manager.hasBase() ||
      (manager.original && manager.original.size() !== base.length);

    if (structural) {
      const hadWork = userTouched && manager.palettes.length > 0;
      manager.resetToBase(base);
      if (hadWork) coalescedNotify("CLUT variants reset — base palette structure changed");
    } else {
      manager.rebaseSameLength(base);
      coalescedNotify(`CLUTs re-based to the updated image (${manager.palettes.length})`);
    }
    publishCluts();
    if (TG.state.ui.activeTab === "palette") updateUI();
  }

  // ---- preview rendering ----------------------------------------------

  function drawIndexed(canvas, colorArray, image) {
    const { indices, width, height, outputCanvas } = image;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const baseData = outputCanvas.getContext("2d").getImageData(0, 0, width, height);
    const out = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const di = i * 4;
      const a = baseData.data[di + 3];
      if (a === 0) { out.data[di + 3] = 0; continue; }
      const c = colorArray[indices[i]] || { r: 0, g: 0, b: 0 };
      out.data[di] = c.r; out.data[di + 1] = c.g; out.data[di + 2] = c.b; out.data[di + 3] = a;
    }
    ctx.putImageData(out, 0, 0);
  }

  function renderPreview() {
    const image = TG.state.image;
    const ready = TG.state.hasImageBlock();
    els.previewEmpty.classList.toggle("hidden", ready);
    els.previewSplit.classList.toggle("hidden", !ready);
    els.zoomControls.classList.toggle("hidden", !ready);
    if (!ready) return;

    // Base preview = Tab 1's output exactly (index -> base palette).
    els.canvasOrig.width = image.width;
    els.canvasOrig.height = image.height;
    const octx = els.canvasOrig.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.clearRect(0, 0, image.width, image.height);
    octx.drawImage(image.outputCanvas, 0, 0);

    // Remap preview = index -> active CLUT (adjusted).
    const active = manager.getActive();
    if (active) drawIndexed(els.canvasRemap, active.bake(), image);
    else octx.drawImage(image.outputCanvas, 0, 0);
    viewport.apply();
  }

  // ---- palette list ----------------------------------------------------

  function renderPaletteList() {
    const c = els.paletteList;
    c.innerHTML = "";
    let dragFrom = null;

    manager.palettes.forEach((palette, index) => {
      const item = document.createElement("div");
      item.className = "palette-item" + (index === manager.activeIndex ? " active" : "");
      item.title = "Click to select • Double-click to rename • Drag to reorder";
      item.draggable = true;

      const handle = document.createElement("span");
      handle.className = "palette-item__handle";
      handle.textContent = "⋮⋮";
      item.appendChild(handle);

      // tiny color preview of the baked CLUT (first few entries)
      const chips = document.createElement("span");
      chips.className = "palette-item__swatches";
      palette.bake().slice(0, 6).forEach((col) => {
        const chip = document.createElement("span");
        chip.className = "palette-item__chip";
        chip.style.background = color.cssRgb(col);
        chips.appendChild(chip);
      });
      item.appendChild(chips);

      const label = document.createElement("span");
      label.className = "palette-item__label";
      label.textContent = palette.name;
      item.appendChild(label);

      const rowIdx = document.createElement("span");
      rowIdx.className = "palette-item__row-index";
      rowIdx.textContent = `row ${index}`;
      item.appendChild(rowIdx);

      let clickTimer = null;
      item.addEventListener("click", () => {
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickTimer = null; manager.setActive(index); touch(); updateUI(); }, 220);
      });

      item.addEventListener("dragstart", (e) => {
        dragFrom = index;
        item.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
        c.querySelectorAll(".palette-item").forEach((el) => el.classList.remove("is-drop-target"));
        dragFrom = null;
      });
      item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("is-drop-target"); });
      item.addEventListener("dragleave", () => item.classList.remove("is-drop-target"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("is-drop-target");
        const from = dragFrom !== null ? dragFrom : parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (Number.isInteger(from) && from !== index) { manager.reorderPalette(from, index); touch(); updateUI(); }
      });

      item.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        if (item.classList.contains("is-renaming")) return;
        item.classList.add("is-renaming");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "palette-item__rename-input";
        input.value = palette.name;
        item.replaceChild(input, label);
        input.focus(); input.select();
        const commit = () => { manager.renamePalette(index, input.value); touch(); updateUI(); };
        const cancel = () => { item.classList.remove("is-renaming"); item.replaceChild(label, input); };
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); commit(); }
          else if (ke.key === "Escape") { ke.preventDefault(); cancel(); }
        });
        input.addEventListener("blur", commit);
      });

      c.appendChild(item);
    });
  }

  // ---- swatch grids ----------------------------------------------------

  function renderSwatches(container, palette, editable) {
    container.innerHTML = "";
    if (!palette) return;
    palette.colours.forEach((colour, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "swatch-wrapper";
      if (editable && palette.isLocked(index)) wrapper.classList.add("is-locked");

      const swatch = document.createElement("div");
      const shown = palette.getAdjusted ? palette.getAdjusted(index) : colour;
      swatch.className = "swatch";
      swatch.style.backgroundColor = color.cssRgb(shown);
      swatch.title = editable
        ? `Click to edit • Right-click to ${palette.isLocked(index) ? "unlock" : "lock"}`
        : color.rgbToHex(shown);

      if (editable) {
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "swatch__color-input";
        colorInput.value = color.rgbToHex(palette.get(index));
        colorInput.tabIndex = -1;

        const lockBadge = document.createElement("div");
        lockBadge.className = "swatch__lock-indicator";
        lockBadge.textContent = palette.isLocked(index) ? "🔒" : "🔓";
        wrapper.appendChild(lockBadge);

        swatch.addEventListener("click", () => {
          container.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-selected"));
          swatch.classList.add("is-selected");
          container.dataset.selectedIndex = index;
          colorInput.click();
        });
        colorInput.addEventListener("input", () => {
          palette.set(index, color.hexToRgb(colorInput.value));
          touch(); updateUI();
        });
        swatch.addEventListener("contextmenu", (e) => { e.preventDefault(); palette.toggleLock(index); touch(); updateUI(); });
        lockBadge.addEventListener("click", (e) => { e.stopPropagation(); palette.toggleLock(index); touch(); updateUI(); });

        wrapper.appendChild(colorInput);
      } else {
        swatch.classList.add("readonly");
      }
      wrapper.appendChild(swatch);
      container.appendChild(wrapper);
    });
  }

  // ---- click-to-pick ---------------------------------------------------

  function pickAt(x, y) {
    const image = TG.state.image;
    const active = manager.getActive();
    if (!image || !active) return;
    const i = y * image.width + x;
    // alpha guard using the base output canvas
    const a = image.outputCanvas.getContext("2d").getImageData(x, y, 1, 1).data[3];
    if (a === 0) return;
    const idx = image.indices[i];
    const wrapper = els.activeSwatches.children[idx];
    if (!wrapper) return;
    els.activeSwatches.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-selected"));
    const swatchEl = wrapper.querySelector(".swatch");
    const colorInput = wrapper.querySelector(".swatch__color-input");
    if (swatchEl) { swatchEl.classList.add("is-selected"); swatchEl.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    if (colorInput) colorInput.click();
  }

  // ---- source-info banner ---------------------------------------------

  function renderSourceInfo() {
    const image = TG.state.image;
    const src = TG.state.source;
    const ready = TG.state.hasImageBlock();
    els.sourceEmpty.classList.toggle("hidden", ready);
    els.sourceDetail.classList.toggle("hidden", !ready);
    if (ready) {
      els.sourceName.textContent = src ? src.fileName : "image";
      els.sourceSize.textContent = `${image.width}×${image.height}`;
      els.sourceDepth.textContent = `${image.bpp}bpp · ${image.basePalette.length} colors`;
    }
  }

  // ---- full UI refresh -------------------------------------------------

  function updateUI() {
    const active = manager.getActive();
    const hasActive = !!active;
    const hasBase = manager.hasBase();

    renderSourceInfo();
    renderPaletteList();
    els.count.textContent = `${manager.palettes.length} / ${MAX()} palettes`;

    renderSwatches(els.originalSwatches, manager.original, false);
    renderSwatches(els.activeSwatches, active, true);
    els.activeTitle.textContent = active ? active.name : "Active Palette";

    renderPreview();

    // control states
    els.preventTrans.disabled = !hasActive;
    if (hasActive) els.preventTrans.checked = active.preventTransparency;
    [els.qHue, els.qSat, els.qBright, els.qContrast, els.quickReset].forEach((c) => (c.disabled = !hasActive));
    if (hasActive) {
      els.qHue.value = active.hue; els.qSat.value = active.saturation;
      els.qBright.value = active.brightness; els.qContrast.value = active.contrast;
      const sign = (v) => (v > 0 ? "+" : "");
      els.qHueVal.textContent = `${sign(active.hue)}${active.hue}°`;
      els.qSatVal.textContent = `${sign(active.saturation)}${active.saturation}%`;
      els.qBrightVal.textContent = `${sign(active.brightness)}${active.brightness}%`;
      els.qContrastVal.textContent = `${sign(active.contrast)}${active.contrast}%`;
    }

    const atMax = manager.palettes.length >= MAX();
    els.newBtn.disabled = !hasBase || atMax;
    els.cloneBtn.disabled = !hasActive || atMax;
    els.deleteBtn.disabled = !hasActive || manager.palettes.length <= 1;
  }

  function touch() { userTouched = true; publishCluts(); }

  // ---- wiring ----------------------------------------------------------

  function bind() {
    Object.assign(els, {
      sourceEmpty: $("pal-source-empty"), sourceDetail: $("pal-source-detail"),
      sourceName: $("pal-source-name"), sourceSize: $("pal-source-size"), sourceDepth: $("pal-source-depth"),
      paletteList: $("pal-palette-list"), count: $("pal-count"),
      newBtn: $("pal-new"), cloneBtn: $("pal-clone"), deleteBtn: $("pal-delete"),
      originalSwatches: $("pal-original-swatches"), activeSwatches: $("pal-active-swatches"), activeTitle: $("pal-active-title"),
      previewEmpty: $("pal-preview-empty"), previewSplit: $("pal-preview-split"), zoomControls: $("pal-zoom-controls"),
      canvasOrig: $("pal-canvas-orig"), canvasRemap: $("pal-canvas-remap"),
      qHue: $("pal-quick-hue"), qSat: $("pal-quick-sat"), qBright: $("pal-quick-bright"), qContrast: $("pal-quick-contrast"),
      qHueVal: $("pal-quick-hue-val"), qSatVal: $("pal-quick-sat-val"), qBrightVal: $("pal-quick-bright-val"), qContrastVal: $("pal-quick-contrast-val"),
      quickReset: $("pal-quick-reset"), preventTrans: $("pal-prevent-trans"),
      zoomOut: $("pal-zoom-out"), zoomIn: $("pal-zoom-in"), zoomReset: $("pal-zoom-reset"), zoomLabel: $("pal-zoom-label"),
    });

    viewport = TG.viewport.create({
      surfaces: [$("pal-viewport-orig"), $("pal-viewport-remap")],
      canvases: [els.canvasOrig, els.canvasRemap],
      enabled: () => TG.state.hasImageBlock(),
      onPick: (canvas, x, y) => pickAt(x, y),
      label: els.zoomLabel,
    });

    els.newBtn.addEventListener("click", () => {
      if (manager.palettes.length >= MAX()) { TG.ui.toast(`Maximum of ${MAX()} palettes`, "error"); return; }
      manager.createPalette(); touch(); updateUI();
    });
    els.cloneBtn.addEventListener("click", () => {
      if (manager.activeIndex < 0) return;
      if (manager.palettes.length >= MAX()) { TG.ui.toast(`Maximum of ${MAX()} palettes`, "error"); return; }
      manager.clonePalette(manager.activeIndex); touch(); updateUI();
    });
    els.deleteBtn.addEventListener("click", async () => {
      if (manager.palettes.length <= 1) { TG.ui.toast("At least 1 palette must remain", "error"); return; }
      const active = manager.getActive();
      if (!active) return;
      const ok = await TG.ui.confirmModal({
        title: "Delete palette?",
        message: `Delete "${active.name}"? This can't be undone.`,
        confirmLabel: "Delete", danger: true,
      });
      if (!ok) return;
      manager.deleteActive(); touch(); updateUI();
    });

    const onSlider = () => {
      const p = manager.getActive();
      if (!p) return;
      p.hue = parseInt(els.qHue.value, 10);
      p.saturation = parseInt(els.qSat.value, 10);
      p.brightness = parseInt(els.qBright.value, 10);
      p.contrast = parseInt(els.qContrast.value, 10);
      touch(); updateUI();
    };
    [els.qHue, els.qSat, els.qBright, els.qContrast].forEach((s) => s.addEventListener("input", onSlider));
    els.quickReset.addEventListener("click", () => {
      const p = manager.getActive();
      if (p) { p.hue = p.saturation = p.brightness = p.contrast = 0; touch(); updateUI(); }
    });
    els.preventTrans.addEventListener("change", () => {
      const p = manager.getActive();
      if (p) { p.preventTransparency = els.preventTrans.checked; touch(); }
    });

    els.zoomIn.addEventListener("click", () => viewport.zoomIn());
    els.zoomOut.addEventListener("click", () => viewport.zoomOut());
    els.zoomReset.addEventListener("click", () => viewport.reset());

    // React to Tab 1 + tab switches.
    TG.state.on("image-block", onImageBlock);
    TG.state.on("tab", (p) => { if (p.tab === "palette") updateUI(); });
  }

  // ---- project integration --------------------------------------------

  // Overlay saved CLUTs on top of the base that Tab 1 just published.
  function loadClutsFromProject(clutsJSON) {
    manager.loadCluts(clutsJSON);
    userTouched = true;
    publishCluts();
    if (TG.state.ui.activeTab === "palette") updateUI();
  }

  // Palette-only restore (legacy .PaletteGen, or a .TimGen saved without an
  // image): set the base + CLUTs directly. Preview/TIM stay disabled until a
  // matching image is loaded in Tab 1; when it is, the same-length re-base
  // keeps these edits.
  function importPaletteOnly(baseColours, clutsJSON) {
    manager.original = new TG.palModel.ColourPalette("Base", baseColours, { readOnly: true });
    manager.loadCluts(clutsJSON);
    if (manager.palettes.length === 0) manager.resetToBase(baseColours);
    userTouched = true;
    publishCluts();
    updateUI();
  }

  TG.palTab = {
    init: bind,
    getManager: () => manager,
    markTouched: () => { userTouched = true; },
    refresh: updateUI,
    loadClutsFromProject,
    importPaletteOnly,
  };
})(window);
