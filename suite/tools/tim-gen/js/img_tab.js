/**
 * img_tab.js  (Tab 1 — Image / BPP)
 * Owns the source image, the image-space adjustments, quantization, dither,
 * and the base palette. After every render it publishes the "image block"
 * (basePalette + indices) to the shared state, which is what Tab 2 consumes.
 *
 * Exposes window.TG.imgTab = { render, hasImage, serialize, restore }.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const { color } = TG;

  const els = {};
  function $(id) { return document.getElementById(id); }

  const imgState = {
    bpp: 8,
    adjust: { hue: 0, saturation: 0, brightness: 0, contrast: 0 },
    dither: { mode: "none", strength: 1 },
    palette: [],   // [[r,g,b], ...]
    locked: [],    // [bool, ...]
  };

  let originalCanvas = null; // untouched native-resolution image
  let sourceCanvas = null;   // working image (original rescaled to target size)
  let fileName = "untitled.png";
  let hasImage = false;
  let lastIndices = null;

  // Target output size. The original is kept intact so rescaling is
  // non-destructive and can be redone / reset to native at any time.
  const size = { w: 0, h: 0, nativeW: 0, nativeH: 0, lock: true };

  // Redraw originalCanvas into sourceCanvas at the current target size.
  // Smoothing is on so downscaling (the common case for VRAM budgets) stays
  // clean; the quantizer then reduces the resampled result.
  function applyRescale() {
    if (!originalCanvas) return;
    const w = Math.max(1, size.w || originalCanvas.width);
    const h = Math.max(1, size.h || originalCanvas.height);
    if (!sourceCanvas) sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    const ctx = sourceCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(originalCanvas, 0, 0, originalCanvas.width, originalCanvas.height, 0, 0, w, h);
  }

  let zoom = 1;
  const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 0.0015;

  // ---- publish to shared state ----------------------------------------

  function publish(structural) {
    const basePalette = imgState.palette.map((c) => ({ r: c[0], g: c[1], b: c[2] }));
    TG.state.image = {
      bpp: imgState.bpp,
      adjust: { ...imgState.adjust },
      dither: { ...imgState.dither },
      basePalette,
      indices: lastIndices,
      outputCanvas: els.outputCanvas,
      width: sourceCanvas ? sourceCanvas.width : 0,
      height: sourceCanvas ? sourceCanvas.height : 0,
      locked: imgState.locked.slice(),
    };
    TG.state.emit("image-block", { image: TG.state.image, structural: !!structural });
    TG.state.emit("status");
  }

  // ---- render ----------------------------------------------------------

  function render(regenerate, structural) {
    if (!hasImage) return;
    const res = TG.pipeline.render(sourceCanvas, imgState, els.outputCanvas, !!regenerate);
    lastIndices = res.indices;
    const colors = Math.pow(2, imgState.bpp);
    els.readout.textContent =
      `${res.width}×${res.height} · ${imgState.bpp}bpp / ${colors} colors · ${imgState.palette.length} used · ${imgState.dither.mode}`;
    renderPaletteStrip();
    publish(structural);
  }

  // ---- base palette strip ---------------------------------------------

  function renderPaletteStrip() {
    els.paletteStrip.innerHTML = "";
    imgState.palette.forEach((rgb, i) => {
      const hex = color.rgbToHex(rgb);
      const locked = imgState.locked[i];

      const sw = document.createElement("div");
      sw.className = "strip-swatch" + (locked ? " is-locked" : "");
      sw.title = hex;

      const fill = document.createElement("div");
      fill.className = "strip-swatch__fill";
      fill.style.background = hex;
      sw.appendChild(fill);

      const input = document.createElement("input");
      input.type = "color";
      input.value = hex;
      input.addEventListener("input", (e) => {
        const c = color.hexToRgb(e.target.value);
        imgState.palette[i] = [c.r, c.g, c.b];
        // A manual edit implies "keep this" — lock it so regenerate won't drop it.
        if (!imgState.locked[i]) imgState.locked[i] = true;
        render(false);
      });
      sw.appendChild(input);

      const lock = document.createElement("span");
      lock.className = "strip-swatch__lock";
      lock.textContent = locked ? "\u{1F512}" : "\u{1F513}";
      lock.title = locked ? "Locked — kept on regenerate (click to unlock)" : "Unlocked (click to lock)";
      lock.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        imgState.locked[i] = !imgState.locked[i];
        renderPaletteStrip();
      });
      sw.appendChild(lock);

      els.paletteStrip.appendChild(sw);
    });
  }

  // ---- image loading ---------------------------------------------------

  function setImageLoadedUI() {
    els.fileChip.hidden = false;
    els.fileChipName.textContent = fileName;
    els.fileChipDims.textContent = `${sourceCanvas.width}×${sourceCanvas.height}`;
    els.stageEmpty.hidden = true;
    els.outputCanvas.hidden = false;
    els.readout.hidden = false;
    els.width.disabled = false;
    els.height.disabled = false;
  }

  function syncSizeControls() {
    els.width.value = size.w;
    els.height.value = size.h;
    els.lockAspect.checked = size.lock;
    els.nativeDims.textContent = size.nativeW ? `(native ${size.nativeW}×${size.nativeH})` : "";
  }

  function loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        originalCanvas = document.createElement("canvas");
        originalCanvas.width = img.naturalWidth;
        originalCanvas.height = img.naturalHeight;
        originalCanvas.getContext("2d").drawImage(img, 0, 0);
        fileName = file.name;
        hasImage = true;

        size.nativeW = img.naturalWidth;
        size.nativeH = img.naturalHeight;
        size.w = img.naturalWidth;
        size.h = img.naturalHeight;
        applyRescale();

        TG.state.source = { canvas: sourceCanvas, width: sourceCanvas.width, height: sourceCanvas.height, fileName };
        TG.state.emit("source", { source: TG.state.source });

        setImageLoadedUI();
        syncSizeControls();
        render(true, true); // fresh image → regenerate + structural reset for Tab 2
        TG.ui.toast("Image loaded");
      };
      img.onerror = () => TG.ui.toast("Couldn't read that image file", "error");
      img.src = e.target.result;
    };
    reader.onerror = () => TG.ui.toast("Couldn't read that file", "error");
    reader.readAsDataURL(file);
  }

  // ---- control sync ----------------------------------------------------

  function syncControls() {
    els.hue.value = imgState.adjust.hue;
    els.hueValue.textContent = `${imgState.adjust.hue}°`;
    els.saturation.value = imgState.adjust.saturation;
    els.saturationValue.textContent = imgState.adjust.saturation;
    els.brightness.value = imgState.adjust.brightness;
    els.brightnessValue.textContent = imgState.adjust.brightness;
    els.contrast.value = imgState.adjust.contrast;
    els.contrastValue.textContent = imgState.adjust.contrast;
    [...els.bppSelector.children].forEach((o) => o.classList.toggle("is-active", Number(o.dataset.bpp) === imgState.bpp));
    [...els.ditherOptions.children].forEach((o) => o.classList.toggle("is-active", o.dataset.mode === imgState.dither.mode));
    els.ditherStrength.value = Math.round(imgState.dither.strength * 100);
    els.ditherStrengthValue.textContent = `${Math.round(imgState.dither.strength * 100)}%`;
  }

  // ---- bpp change (structural — may reset Tab 2 CLUTs) -----------------

  async function changeBpp(newBpp) {
    if (newBpp === imgState.bpp) return;
    const cluts = TG.state.cluts || [];
    if (cluts.length > 0) {
      const ok = await TG.ui.confirmModal({
        title: "Change color depth?",
        message: `Switching to ${newBpp}bpp rebuilds the base palette from scratch, so your ${cluts.length} CLUT variant(s) can't be re-based and will be reset to a single default palette. Continue?`,
        confirmLabel: "Change depth",
        cancelLabel: "Keep current",
        danger: true,
      });
      if (!ok) return;
    }
    imgState.bpp = newBpp;
    [...els.bppSelector.children].forEach((o) => o.classList.toggle("is-active", Number(o.dataset.bpp) === newBpp));
    render(true, true); // regenerate + structural
  }

  // ---- wiring ----------------------------------------------------------

  function bind() {
    Object.assign(els, {
      dropzone: $("img-dropzone"), fileInput: $("img-file-input"),
      fileChip: $("img-file-chip"), fileChipName: $("img-file-chip-name"), fileChipDims: $("img-file-chip-dims"),
      width: $("img-width"), height: $("img-height"), lockAspect: $("img-lock-aspect"),
      resetSize: $("img-reset-size"), nativeDims: $("img-native-dims"),
      bppSelector: $("img-bpp-selector"),
      hue: $("img-hue"), hueValue: $("img-hue-value"),
      saturation: $("img-saturation"), saturationValue: $("img-saturation-value"),
      brightness: $("img-brightness"), brightnessValue: $("img-brightness-value"),
      contrast: $("img-contrast"), contrastValue: $("img-contrast-value"),
      resetAdjust: $("img-reset-adjust"),
      ditherOptions: $("img-dither-options"), ditherStrength: $("img-dither-strength"), ditherStrengthValue: $("img-dither-strength-value"),
      paletteStrip: $("img-palette-strip"), regenerate: $("img-regenerate"),
      stageEmpty: $("img-stage-empty"), outputCanvas: $("img-output-canvas"), readout: $("img-readout"),
    });

    TG.ui.bindDropzone(els.dropzone, els.fileInput, loadImageFile);

    els.bppSelector.addEventListener("click", (e) => {
      const opt = e.target.closest(".segmented__option");
      if (opt) changeBpp(Number(opt.dataset.bpp));
    });

    // Resize: committing a W/H (change) rescales the working image and
    // re-runs the pipeline. Aspect lock keeps the partner field in step.
    function commitSize(which) {
      let val = Math.round(Number(which === "width" ? els.width.value : els.height.value));
      if (!Number.isFinite(val) || val < 1) val = 1;
      if (val > 4096) val = 4096;
      if (size.lock && size.nativeW && size.nativeH) {
        const ar = size.nativeW / size.nativeH;
        if (which === "width") { size.w = val; size.h = Math.max(1, Math.round(val / ar)); }
        else { size.h = val; size.w = Math.max(1, Math.round(val * ar)); }
      } else if (which === "width") { size.w = val; } else { size.h = val; }
      syncSizeControls();
      if (hasImage) {
        applyRescale();
        render(true); // pixels changed → regenerate palette (locks kept)
        els.fileChipDims.textContent = `${sourceCanvas.width}×${sourceCanvas.height}`;
      }
    }
    els.width.addEventListener("change", () => commitSize("width"));
    els.height.addEventListener("change", () => commitSize("height"));
    els.lockAspect.addEventListener("change", () => { size.lock = els.lockAspect.checked; });
    els.resetSize.addEventListener("click", () => {
      if (!size.nativeW) return;
      size.w = size.nativeW; size.h = size.nativeH;
      syncSizeControls();
      if (hasImage) {
        applyRescale();
        render(true);
        els.fileChipDims.textContent = `${sourceCanvas.width}×${sourceCanvas.height}`;
      }
    });

    function wireSlider(input, valueEl, key, fmt) {
      input.addEventListener("input", () => {
        const v = Number(input.value);
        imgState.adjust[key] = v;
        valueEl.textContent = fmt ? fmt(v) : v;
        render(false);
      });
    }
    wireSlider(els.hue, els.hueValue, "hue", (v) => `${v}°`);
    wireSlider(els.saturation, els.saturationValue, "saturation");
    wireSlider(els.brightness, els.brightnessValue, "brightness");
    wireSlider(els.contrast, els.contrastValue, "contrast");

    els.resetAdjust.addEventListener("click", () => {
      imgState.adjust = { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
      syncControls();
      render(false);
    });

    els.ditherOptions.addEventListener("click", (e) => {
      const opt = e.target.closest(".dither-option");
      if (!opt) return;
      imgState.dither.mode = opt.dataset.mode;
      [...els.ditherOptions.children].forEach((o) => o.classList.toggle("is-active", o === opt));
      render(false);
    });
    els.ditherStrength.addEventListener("input", () => {
      imgState.dither.strength = Number(els.ditherStrength.value) / 100;
      els.ditherStrengthValue.textContent = `${els.ditherStrength.value}%`;
      render(false);
    });

    els.regenerate.addEventListener("click", () => {
      if (!hasImage) return;
      render(true);
      TG.ui.toast("Base palette regenerated (locked colors kept)");
    });

    els.outputCanvas.addEventListener("wheel", (e) => {
      if (!hasImage) return;
      e.preventDefault();
      zoom -= e.deltaY * ZOOM_STEP;
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
      els.outputCanvas.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
      els.outputCanvas.style.cursor = zoom > 1 ? "zoom-out" : "zoom-in";
    }, { passive: false });
  }

  // ---- project integration --------------------------------------------

  function serialize() {
    if (!hasImage) return null;
    return {
      sourceImage: originalCanvas.toDataURL("image/png"), // native, so rescale stays non-destructive
      fileName,
      width: size.w,
      height: size.h,
      bpp: imgState.bpp,
      adjust: { ...imgState.adjust },
      dither: { ...imgState.dither },
      palette: imgState.palette.map((c) => color.rgbToHex(c)),
      locked: imgState.locked.slice(),
    };
  }

  // Restore Tab 1 from saved data. Returns a Promise that resolves once the
  // image block has been rebuilt + published (so Tab 2 can then load CLUTs).
  function restore(data) {
    return new Promise((resolve, reject) => {
      if (!data || !data.sourceImage) { reject(new Error("Project has no image data.")); return; }
      const img = new Image();
      img.onload = () => {
        originalCanvas = document.createElement("canvas");
        originalCanvas.width = img.naturalWidth;
        originalCanvas.height = img.naturalHeight;
        originalCanvas.getContext("2d").drawImage(img, 0, 0);
        fileName = data.fileName || "untitled.png";
        hasImage = true;

        size.nativeW = img.naturalWidth;
        size.nativeH = img.naturalHeight;
        size.w = data.width || img.naturalWidth;
        size.h = data.height || img.naturalHeight;
        applyRescale();

        imgState.bpp = data.bpp || 8;
        imgState.adjust = Object.assign({ hue: 0, saturation: 0, brightness: 0, contrast: 0 }, data.adjust);
        imgState.dither = Object.assign({ mode: "none", strength: 1 }, data.dither);
        if (Array.isArray(data.palette) && data.palette.length) {
          imgState.palette = data.palette.map((h) => { const c = color.hexToRgb(h); return [c.r, c.g, c.b]; });
          imgState.locked = (data.locked && data.locked.length === data.palette.length)
            ? data.locked.slice() : imgState.palette.map(() => false);
        } else {
          imgState.palette = []; imgState.locked = [];
        }

        TG.state.source = { canvas: sourceCanvas, width: sourceCanvas.width, height: sourceCanvas.height, fileName };
        TG.state.emit("source", { source: TG.state.source });

        setImageLoadedUI();
        syncControls();
        syncSizeControls();
        render(imgState.palette.length === 0, true); // regenerate only if no palette saved
        resolve();
      };
      img.onerror = () => reject(new Error("Couldn't decode the embedded source image."));
      img.src = data.sourceImage;
    });
  }

  TG.imgTab = {
    init: bind,
    render,
    hasImage: () => hasImage,
    getFileName: () => fileName,
    getOutputCanvas: () => els.outputCanvas,
    getBpp: () => imgState.bpp,
    serialize,
    restore,
  };
})(window);
