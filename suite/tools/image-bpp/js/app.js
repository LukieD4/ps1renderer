/**
 * app.js
 * Wires up DOM events for the BPP Image Tool: file loading, sliders,
 * bpp/dither selection, palette editing, and the transport bar
 * (load/save project, export PNG).
 */
(function () {
  const els = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    fileChip: document.getElementById("file-chip"),
    fileChipName: document.getElementById("file-chip-name"),
    fileChipDims: document.getElementById("file-chip-dims"),

    bppSelector: document.getElementById("bpp-selector"),

    hue: document.getElementById("hue"),
    hueValue: document.getElementById("hue-value"),
    saturation: document.getElementById("saturation"),
    saturationValue: document.getElementById("saturation-value"),
    brightness: document.getElementById("brightness"),
    brightnessValue: document.getElementById("brightness-value"),
    contrast: document.getElementById("contrast"),
    contrastValue: document.getElementById("contrast-value"),
    resetAdjustments: document.getElementById("reset-adjustments"),

    ditherOptions: document.getElementById("dither-options"),
    ditherStrength: document.getElementById("dither-strength"),
    ditherStrengthValue: document.getElementById("dither-strength-value"),

    paletteStrip: document.getElementById("palette-strip"),
    regeneratePalette: document.getElementById("regenerate-palette"),

    stage: document.getElementById("stage"),
    stageEmpty: document.getElementById("stage-empty"),
    outputCanvas: document.getElementById("output-canvas"),
    stageReadout: document.getElementById("stage-readout"),

    btnLoadProject: document.getElementById("btn-load-project"),
    loadProjectInput: document.getElementById("load-project-input"),
    btnSaveProject: document.getElementById("btn-save-project"),
    btnExportPng: document.getElementById("btn-export-png"),
    transportStatus: document.getElementById("transport-status"),

    toast: document.getElementById("toast"),
  };

  // ---- App state --------------------------------------------------------

  const state = {
    bpp: 8,
    hue: 0,
    saturation: 0,
    brightness: 0,
    contrast: 0,
    ditherMode: "none",
    ditherStrength: 1,
    paletteModel: new window.BppPalette.PaletteModel(),
  };

  let sourceCanvas = null; // offscreen canvas holding the untouched original image
  let originalFileName = "untitled.png";
  let hasImage = false;

  let zoomLevel = 1;
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 0.0015; // multiplier per wheel-delta unit

  // ---- Toast --------------------------------------------------------------

  let toastTimer = null;
  function showToast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.toggle("is-error", !!isError);
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
  }

  // ---- Rendering ------------------------------------------------------

  function render(regeneratePalette) {
    if (!hasImage) return;
    window.BppRenderer.renderPipeline(sourceCanvas, state, els.outputCanvas, !!regeneratePalette);
    els.stageReadout.textContent = `${sourceCanvas.width}\u00d7${sourceCanvas.height} \u00b7 ${Math.pow(2, state.bpp)} colors \u00b7 ${state.ditherMode}`;
    renderPaletteStrip();
  }

  function renderPaletteStrip() {
    els.paletteStrip.innerHTML = "";
    state.paletteModel.colors.forEach((rgb, i) => {
      const hex = window.BppPalette.rgbToHex(rgb);
      const locked = state.paletteModel.locked[i];

      const swatch = document.createElement("div");
      swatch.className = "swatch" + (locked ? " is-locked" : "");
      swatch.title = hex;

      const fill = document.createElement("div");
      fill.className = "swatch__fill";
      fill.style.background = hex;
      swatch.appendChild(fill);

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = hex;
      colorInput.addEventListener("input", (e) => {
        const rgb = window.BppPalette.hexToRgb(e.target.value);
        state.paletteModel.setColor(i, rgb);
        // Editing a color manually implies the user wants to keep it —
        // lock it automatically so a later regenerate doesn't discard it.
        if (!state.paletteModel.locked[i]) state.paletteModel.toggleLock(i);
        render(false);
      });
      swatch.appendChild(colorInput);

      const lockBtn = document.createElement("span");
      lockBtn.className = "swatch__lock";
      lockBtn.textContent = locked ? "\u{1F512}" : "\u{1F513}";
      lockBtn.title = locked ? "Locked — click to unlock" : "Unlocked — click to lock";
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.paletteModel.toggleLock(i);
        renderPaletteStrip();
      });
      swatch.appendChild(lockBtn);

      els.paletteStrip.appendChild(swatch);
    });
  }

  // ---- Image loading ----------------------------------------------------

  function loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = img.naturalWidth;
        sourceCanvas.height = img.naturalHeight;
        sourceCanvas.getContext("2d").drawImage(img, 0, 0);

        originalFileName = file.name;
        hasImage = true;

        els.fileChip.hidden = false;
        els.fileChipName.textContent = file.name;
        els.fileChipDims.textContent = `${img.naturalWidth}\u00d7${img.naturalHeight}`;

        els.stageEmpty.hidden = true;
        els.outputCanvas.hidden = false;
        els.stageReadout.hidden = false;

        els.btnSaveProject.disabled = false;
        els.btnExportPng.disabled = false;
        els.transportStatus.textContent = file.name;

        render(true);
        showToast("Image loaded");
      };
      img.onerror = () => showToast("Couldn't read that image file", true);
      img.src = e.target.result;
    };
    reader.onerror = () => showToast("Couldn't read that file", true);
    reader.readAsDataURL(file);
  }

  function loadFromProjectData({ sourceCanvas: canvas, state: loadedState, originalFileName: fname }) {
    sourceCanvas = canvas;
    originalFileName = fname;
    hasImage = true;

    state.bpp = loadedState.bpp;
    state.hue = loadedState.hue;
    state.saturation = loadedState.saturation;
    state.brightness = loadedState.brightness;
    state.contrast = loadedState.contrast;
    state.ditherMode = loadedState.ditherMode;
    state.ditherStrength = loadedState.ditherStrength;
    state.paletteModel = loadedState.paletteModel;

    // Reflect state into controls
    syncControlsFromState();

    els.fileChip.hidden = false;
    els.fileChipName.textContent = fname;
    els.fileChipDims.textContent = `${canvas.width}\u00d7${canvas.height}`;

    els.stageEmpty.hidden = true;
    els.outputCanvas.hidden = false;
    els.stageReadout.hidden = false;

    els.btnSaveProject.disabled = false;
    els.btnExportPng.disabled = false;
    els.transportStatus.textContent = fname;

    render(false); // palette already loaded — don't regenerate over it
  }

  function syncControlsFromState() {
    els.hue.value = state.hue;
    els.hueValue.textContent = `${state.hue}\u00b0`;
    els.saturation.value = state.saturation;
    els.saturationValue.textContent = state.saturation;
    els.brightness.value = state.brightness;
    els.brightnessValue.textContent = state.brightness;
    els.contrast.value = state.contrast;
    els.contrastValue.textContent = state.contrast;

    [...els.bppSelector.children].forEach((opt) => {
      opt.classList.toggle("is-active", Number(opt.dataset.bpp) === state.bpp);
    });

    [...els.ditherOptions.children].forEach((opt) => {
      opt.classList.toggle("is-active", opt.dataset.mode === state.ditherMode);
    });

    els.ditherStrength.value = Math.round(state.ditherStrength * 100);
    els.ditherStrengthValue.textContent = `${Math.round(state.ditherStrength * 100)}%`;
  }

  // ---- Event wiring -------------------------------------------------------

  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-dragover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("is-dragover"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-dragover");
    const file = e.dataTransfer.files[0];
    if (file) loadImageFile(file);
  });
  els.fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadImageFile(file);
  });

  els.bppSelector.addEventListener("click", (e) => {
    const opt = e.target.closest(".segmented__option");
    if (!opt) return;
    state.bpp = Number(opt.dataset.bpp);
    [...els.bppSelector.children].forEach((o) => o.classList.toggle("is-active", o === opt));
    render(true);
  });

  function wireSlider(input, valueEl, stateKey, formatter) {
    input.addEventListener("input", () => {
      const v = Number(input.value);
      state[stateKey] = v;
      valueEl.textContent = formatter ? formatter(v) : v;
      render(false);
    });
  }
  wireSlider(els.hue, els.hueValue, "hue", (v) => `${v}\u00b0`);
  wireSlider(els.saturation, els.saturationValue, "saturation");
  wireSlider(els.brightness, els.brightnessValue, "brightness");
  wireSlider(els.contrast, els.contrastValue, "contrast");

  els.resetAdjustments.addEventListener("click", () => {
    state.hue = 0; state.saturation = 0; state.brightness = 0; state.contrast = 0;
    syncControlsFromState();
    render(false);
  });

  els.ditherOptions.addEventListener("click", (e) => {
    const opt = e.target.closest(".dither-option");
    if (!opt) return;
    state.ditherMode = opt.dataset.mode;
    [...els.ditherOptions.children].forEach((o) => o.classList.toggle("is-active", o === opt));
    render(false);
  });

  els.ditherStrength.addEventListener("input", () => {
    state.ditherStrength = Number(els.ditherStrength.value) / 100;
    els.ditherStrengthValue.textContent = `${els.ditherStrength.value}%`;
    render(false);
  });

  els.regeneratePalette.addEventListener("click", () => {
    if (!hasImage) return;
    render(true);
    showToast("Palette regenerated (locked colors kept)");
  });

  // Transport bar

  els.btnSaveProject.addEventListener("click", () => {
    if (!hasImage) return;
    try {
      window.BppProject.saveProjectFile({ sourceCanvas, state, originalFileName });
      showToast(`Saved ${window.BppProject.baseName(originalFileName)}.BppProject`);
    } catch (err) {
      showToast("Couldn't save the project", true);
    }
  });

  els.btnExportPng.addEventListener("click", () => {
    if (!hasImage) return;
    window.BppProject.exportPng(els.outputCanvas, originalFileName, state.bpp);
    showToast("PNG exported");
  });

  els.btnLoadProject.addEventListener("click", () => els.loadProjectInput.click());
  els.loadProjectInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const loaded = await window.BppProject.deserializeProject(ev.target.result);
        loadFromProjectData(loaded);
        showToast(`Loaded ${loaded.originalFileName}`);
      } catch (err) {
        showToast(err.message || "Couldn't load that project file", true);
      }
    };
    reader.onerror = () => showToast("Couldn't read that file", true);
    reader.readAsText(file);
    els.loadProjectInput.value = ""; // allow re-loading same file later
  });

  // scroll
  els.outputCanvas.addEventListener("wheel", (e) => {
    if (!hasImage) return;
    e.preventDefault();
    zoomLevel -= e.deltaY * ZOOM_STEP;
    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel));
    els.outputCanvas.style.transform = zoomLevel === 1 ? "" : `scale(${zoomLevel})`;
    els.outputCanvas.style.cursor = zoomLevel > 1 ? "zoom-out" : "zoom-in";
  }, { passive: false });

  // Warn before leaving with unsaved work
  window.addEventListener("beforeunload", (e) => {
    if (hasImage) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
