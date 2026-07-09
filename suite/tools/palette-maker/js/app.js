/**
 * ============================================================================
 * app.js
 *
 * Core Workbench Application Controller with Zoom/Pan, Bulk Adjustments,
 * click-to-pick colour editing, and Palette Locking.
 * ============================================================================
 */

(function () {

    "use strict";

    // Instantiate State Model
    const manager = new PaletteGen.PaletteManager();
    let cacheSourceCanvas = null;

    // Cache DOM nodes
    const imageInput = document.getElementById("image-input");
    const dropzone = document.getElementById("dropzone");
    const imageInfo = document.getElementById("image-info");
    const imageName = document.getElementById("image-name");
    const imageSize = document.getElementById("image-size");
    const paletteList = document.getElementById("palette-list");
    const btnNewPalette = document.getElementById("new-palette");
    const btnClonePalette = document.getElementById("clone-palette");
    const btnDeletePalette = document.getElementById("delete-palette");
    const paletteCount = document.getElementById("palette-count");
    const originalSwatches = document.getElementById("original-swatches");
    const activeTitle = document.getElementById("active-title");
    const activeSwatches = document.getElementById("active-swatches");
    const btnLoadProject = document.getElementById("load-project");
    const btnSaveProject = document.getElementById("save-project");
    const btnExportTim = document.getElementById("export-tim");
    const projectInput = document.getElementById("project-input");

    // Dynamic Dual Viewport Target Nodes
    const canvasOrig = document.getElementById("canvas-orig");
    const canvasRemap = document.getElementById("canvas-remap");
    const previewSplit = document.getElementById("preview-split");
    const previewEmpty = document.getElementById("preview-empty");
    const zoomControls = document.getElementById("zoom-controls");

    // Bulk/Feature DOM Nodes
    const quickHue = document.getElementById("quick-hue");
    const quickSat = document.getElementById("quick-sat");
    const quickBright = document.getElementById("quick-bright");
    const quickContrast = document.getElementById("quick-contrast");
    const quickHueVal = document.getElementById("quick-hue-val");
    const quickSatVal = document.getElementById("quick-sat-val");
    const quickBrightVal = document.getElementById("quick-bright-val");
    const quickContrastVal = document.getElementById("quick-contrast-val");
    const btnQuickReset = document.getElementById("quick-reset");

    // Feature Elements
    const togglePreventTrans = document.getElementById("cfg-prevent-transparency");

    // State
    let zoomScale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;

    function applyTransform() {
        const transformString = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
        [canvasOrig, canvasRemap].forEach(canvas => {
            if (canvas) canvas.style.transform = transformString;
        });
        const label = document.getElementById("zoom-label");
        if (label) label.textContent = `${Math.round(zoomScale * 100)}%`;
    }

    //======================================================================
    // Context Synchronization Core
    //======================================================================

    function updateUI() {
        const activePalette = manager.getActive();
        const hasActive = activePalette !== null;

        // Render Lists & Panels
        PaletteRenderer.renderPaletteList(paletteList, manager, (index) => {
            manager.setActive(index);
            updateUI();
        }, (index, newName) => {
            manager.renamePalette(index, newName);
            updateUI();
        }, (fromIndex, toIndex) => {
            manager.reorderPalette(fromIndex, toIndex);
            updateUI();
        });

        PaletteRenderer.renderPaletteCount(paletteCount, manager, PaletteGen.PaletteManager.MAX_PALETTES);

        PaletteRenderer.renderSwatches(originalSwatches, manager.original, { editable: false });
        PaletteRenderer.renderSwatches(activeSwatches, activePalette, {
            editable: true,
            onLockToggle: () => { updateUI(); },
            onColourChange: () => { updateUI(); }
        });

        PaletteRenderer.renderActiveTitle(activeTitle, activePalette);

        PaletteRenderer.renderPreview(cacheSourceCanvas, {
            canvasOrig,
            canvasRemap,
            previewSplit,
            placeholder: previewEmpty,
            zoomControls
        }, manager);

        // UI States
        togglePreventTrans.disabled = !hasActive;
        if (hasActive) togglePreventTrans.checked = activePalette.preventTransparency;

        [quickHue, quickSat, quickBright, quickContrast, btnQuickReset].forEach(control => {
            control.disabled = !hasActive;
        });

        if (hasActive) {
            quickHue.value = activePalette.hue;
            quickSat.value = activePalette.saturation;
            quickBright.value = activePalette.brightness;
            quickContrast.value = activePalette.contrast;
            quickHueVal.textContent = `${activePalette.hue > 0 ? '+' : ''}${activePalette.hue}°`;
            quickSatVal.textContent = `${activePalette.saturation > 0 ? '+' : ''}${activePalette.saturation}%`;
            quickBrightVal.textContent = `${activePalette.brightness > 0 ? '+' : ''}${activePalette.brightness}%`;
            quickContrastVal.textContent = `${activePalette.contrast > 0 ? '+' : ''}${activePalette.contrast}%`;
        }

        applyTransform();

        const operational = manager.original !== null;
        const atPaletteLimit = manager.palettes.length >= PaletteGen.PaletteManager.MAX_PALETTES;
        btnNewPalette.disabled = !operational || atPaletteLimit;
        btnNewPalette.title = atPaletteLimit ? `Maximum of ${PaletteGen.PaletteManager.MAX_PALETTES} palettes reached` : "";
        btnClonePalette.disabled = !hasActive || atPaletteLimit;
        btnClonePalette.title = atPaletteLimit ? `Maximum of ${PaletteGen.PaletteManager.MAX_PALETTES} palettes reached` : "Clone the active palette";

        const atPaletteMinimum = manager.palettes.length <= 1;
        btnDeletePalette.disabled = !hasActive || atPaletteMinimum;
        btnDeletePalette.title = atPaletteMinimum ? "At least 1 palette must remain" : "Delete the active palette";

        btnSaveProject.disabled = !operational;

        // TIM export additionally needs actual pixel data (a loaded image,
        // not just a loaded project) and a <=16 colour palette (4bpp limit).
        const withinTimColourLimit = hasActive && manager.original.colours.length <= 16;
        btnExportTim.disabled = !hasActive || !cacheSourceCanvas || !withinTimColourLimit;
        btnExportTim.title = !cacheSourceCanvas
            ? "Load the source image (not just a .PaletteGen project) to export a .tim"
            : !withinTimColourLimit
                ? `Source has ${manager.original ? manager.original.colours.length : 0} colours - 4bpp .tim supports a maximum of 16`
                : `Export all ${manager.palettes.length} palette(s) as one .tim, stacked as CLUT rows in list order (row 0 = top of the Palettes list), sharing one image block`;
    }

    //======================================================================
    // Zoom / Pan
    //======================================================================

    function initZoomPanListeners() {
        const viewports = [document.getElementById("viewport-orig"), document.getElementById("viewport-remap")];
        viewports.forEach(vp => {
            if (!vp) return;
            vp.addEventListener("mousedown", (e) => {
                if (!manager.original) return;
                isDragging = true;
                didDrag = false;
                startX = e.clientX - panX;
                startY = e.clientY - panY;
            });
            vp.addEventListener("wheel", (e) => {
                if (!manager.original) return;
                e.preventDefault();
                zoomScale = e.deltaY < 0 ? Math.min(64, zoomScale * 1.15) : Math.max(0.1, zoomScale / 1.15);
                applyTransform();
            }, { passive: false });
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX - panX;
            const dy = e.clientY - startY - panY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true;
            panX = e.clientX - startX;
            panY = e.clientY - startY;
            applyTransform();
        });
        window.addEventListener("mouseup", () => isDragging = false);
    }

    //======================================================================
    // Quick Edit (Bulk Sliders)
    //======================================================================

    function initQuickEditListeners() {
        const handleSliderChange = () => {
            const activePalette = manager.getActive();
            if (!activePalette) return;
            activePalette.hue = parseInt(quickHue.value, 10);
            activePalette.saturation = parseInt(quickSat.value, 10);
            activePalette.brightness = parseInt(quickBright.value, 10);
            activePalette.contrast = parseInt(quickContrast.value, 10);
            updateUI();
        };

        [quickHue, quickSat, quickBright, quickContrast].forEach(s => s.addEventListener("input", handleSliderChange));
        btnQuickReset.addEventListener("click", () => {
            const p = manager.getActive();
            if (p) { p.hue = p.saturation = p.brightness = p.contrast = 0; updateUI(); }
        });

        togglePreventTrans.addEventListener("change", () => {
            if (manager.getActive()) manager.getActive().preventTransparency = togglePreventTrans.checked;
        });
    }

    //======================================================================
    // Click-to-pick colour: clicking a pixel in either preview viewport
    // selects the matching swatch in the active palette and opens its
    // colour picker directly, so there's no separate "tool mode" to toggle.
    //======================================================================

    function initColourPickLogic() {

        function samplePixelToPalette(targetCanvas, e) {
            const activePalette = manager.getActive();
            if (!activePalette) return;

            const rect = targetCanvas.getBoundingClientRect();
            const x = Math.floor(((e.clientX - rect.left) / rect.width) * targetCanvas.width);
            const y = Math.floor(((e.clientY - rect.top) / rect.height) * targetCanvas.height);
            if (x < 0 || y < 0 || x >= targetCanvas.width || y >= targetCanvas.height) return;

            const ctx = targetCanvas.getContext("2d");
            const pixelData = ctx.getImageData(x, y, 1, 1).data;
            if (pixelData[3] === 0) return; // transparent pixel, nothing to select

            const sampledRgb = { r: pixelData[0], g: pixelData[1], b: pixelData[2] };

            // Find the palette slot whose *original* colour matches this pixel,
            // so clicking the remapped preview still resolves to the right index.
            const key = (c) => (c.r << 16) | (c.g << 8) | c.b;
            const targetKey = key(sampledRgb);

            let matchIndex = -1;
            manager.original.colours.forEach((c, idx) => {
                if (matchIndex === -1 && key(c) === targetKey) matchIndex = idx;
            });

            if (matchIndex === -1) return;

            // Reflect selection in the active swatch grid, then open its picker.
            activeSwatches.dataset.selectedIndex = matchIndex;
            const wrapper = activeSwatches.children[matchIndex];
            if (wrapper) {
                const colorInput = wrapper.querySelector(".swatch__color-input");
                const swatchEl = wrapper.querySelector(".swatch");
                activeSwatches.querySelectorAll(".swatch").forEach(s => s.classList.remove("is-selected"));
                if (swatchEl) {
                    swatchEl.classList.add("is-selected");
                    swatchEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }
                if (colorInput) colorInput.click();
            }
        }

        [canvasOrig, canvasRemap].forEach(targetCanvas => {
            targetCanvas.addEventListener("click", (e) => {
                // Ignore clicks that were actually the end of a pan-drag.
                if (didDrag) { didDrag = false; return; }
                if (!manager.getActive()) return;
                samplePixelToPalette(targetCanvas, e);
            });
        });
    }

    //======================================================================
    // Image Handling
    //======================================================================

    async function processImageFile(file) {
        if (!file) return;
        try {
            const result = await PaletteImage.loadImage(file);
            const extracted = PaletteImage.extractColours(result.imageData);

            // If palettes already exist (e.g. a .PaletteGen project was loaded
            // first and the person is now attaching its source image), keep
            // them instead of wiping the work that's already been done. Only
            // reset to a fresh single palette when there's nothing to preserve.
            const hadExistingPalettes = manager.palettes.length > 0;

            cacheSourceCanvas = result.canvas;
            manager.loadOriginal(extracted, { preservePalettes: hadExistingPalettes });
            manager.sourceFileName = file.name;

            imageInfo.classList.remove("hidden");
            PaletteRenderer.renderImageInfo(imageName, imageSize, file.name, result.width, result.height);

            if (!hadExistingPalettes) {
                manager.createPalette("Palette 1");
            } else if (extracted.length !== manager.original.colours.length) {
                // Not a hard error - the palettes still render fine - but the
                // counts diverging usually means this image isn't the one the
                // loaded project's palette was built from, so flag it clearly.
                console.warn(
                    `Loaded image has ${extracted.length} unique colour(s), but the ` +
                    `active project's palette has ${manager.original.colours.length}. ` +
                    `Colour-index mapping (picking, CLUT/TIM export) may not line up ` +
                    `with this image unless it's the same source the project was built from.`
                );
            }

            zoomScale = 1; panX = 0; panY = 0;
            updateUI();
        } catch (error) { alert(error.message); }
    }

    //======================================================================
    // Bindings
    //======================================================================

    imageInput.addEventListener("change", (e) => { if (e.target.files.length) processImageFile(e.target.files[0]); });

    // Support drag-and-drop onto the dropzone, matching its labelled affordance.
    ["dragover", "dragenter"].forEach(evt => {
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); });
    });
    ["dragleave", "drop"].forEach(evt => {
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
    });
    dropzone.addEventListener("drop", (e) => {
        if (e.dataTransfer.files.length) processImageFile(e.dataTransfer.files[0]);
    });

    btnNewPalette.addEventListener("click", () => {
        if (manager.palettes.length >= PaletteGen.PaletteManager.MAX_PALETTES) {
            alert(`Maximum of ${PaletteGen.PaletteManager.MAX_PALETTES} palettes reached.`);
            return;
        }
        manager.createPalette();
        updateUI();
    });

    btnClonePalette.addEventListener("click", () => {
        if (manager.activeIndex < 0) return;
        if (manager.palettes.length >= PaletteGen.PaletteManager.MAX_PALETTES) {
            alert(`Maximum of ${PaletteGen.PaletteManager.MAX_PALETTES} palettes reached.`);
            return;
        }
        manager.clonePalette(manager.activeIndex);
        updateUI();
    });

    btnDeletePalette.addEventListener("click", () => {
        if (manager.palettes.length <= 1) {
            alert("At least 1 palette must remain.");
            return;
        }
        const active = manager.getActive();
        if (!active) return;
        if (!confirm(`Delete palette "${active.name}"? This can't be undone.`)) return;
        manager.deleteActive();
        updateUI();
    });

    btnLoadProject.addEventListener("click", () => projectInput.click());
    projectInput.addEventListener("change", (e) => {
        if (e.target.files.length) {
            PaletteProject.loadProject(e.target.files[0], manager, () => {
                // Project files carry palette/colour data but never pixel
                // data, so there is nothing to clear here. If an image was
                // already loaded in this session (or gets loaded right after),
                // it should stay right where it is - only reset pan/zoom
                // since the loaded palette geometry may differ from before.
                zoomScale = 1; panX = 0; panY = 0;

                if (manager.sourceFileName) {
                    imageInfo.classList.remove("hidden");
                    imageName.textContent = manager.sourceFileName;
                    imageSize.textContent = cacheSourceCanvas
                        ? `${cacheSourceCanvas.width} × ${cacheSourceCanvas.height}`
                        : "(no image loaded yet - drop the matching source image in)";
                }

                // If no image is loaded yet, the preview naturally falls back
                // to the empty-state placeholder via renderPreview's own check
                // on cacheSourceCanvas, no extra handling needed here.
                updateUI();
            });
        }
        projectInput.value = "";
    });

    btnSaveProject.addEventListener("click", () => PaletteProject.saveProject(manager));

    btnExportTim.addEventListener("click", () => {
        const active = manager.getActive();
        if (!active || !cacheSourceCanvas || !manager.original) return;

        if (manager.original.colours.length > 16) {
            alert(
                `This image has ${manager.original.colours.length} unique colours - ` +
                `4bpp .tim supports a maximum of 16. Reduce the source image's ` +
                `colour count first.`
            );
            return;
        }

        if (manager.palettes.length === 0) return;

        // Same colour->index map the preview remap uses, built from the
        // ORIGINAL palette order, so exported pixel indices agree with the
        // exported CLUT rows (see tim_writer.js's header comment for why
        // this single-source-of-truth matters).
        const colorToIndex = PaletteImage.buildColorToIndexMap(manager.original);

        const srcCtx = cacheSourceCanvas.getContext("2d");
        const imageData = srcCtx.getImageData(0, 0, cacheSourceCanvas.width, cacheSourceCanvas.height);

        // tim_writer.js writes palette.colours[i] verbatim - it has no
        // concept of hue/sat/brightness/contrast sliders or per-swatch
        // locks. Those are this tool's own non-destructive editing layer
        // (see getAdjusted() in palette.js). To actually export what the
        // user has been looking at - the EDITED palette, not the raw
        // extracted one - we bake each palette's adjustments down into
        // plain resolved colours here, once, right before writing.
        //
        // Every palette the user has built becomes one CLUT row in a
        // single output TIM (Design A / stacked CLUTs), sharing the one
        // copy of pixel data - true palette-swap output, not a re-texture
        // per variant.
        //
        // Row order is simply manager.palettes' own order, top to bottom,
        // exactly as listed in the sidebar - VRAM Palette 1 -> Palette 2 ->
        // Palette 3 -> etc. No reordering based on which palette happens
        // to be active. Which row a given viewer treats as "primary" is
        // that viewer's own convention to deal with, not something this
        // export should silently rearrange rows to work around.
        const orderedPalettes = manager.palettes.slice();

        const bakedPalettes = orderedPalettes.map(p => ({
            // tim_writer.js only reads .colours (and optionally .size()),
            // so a plain object with a resolved colours array is enough -
            // no need to construct a real ColourPalette instance here.
            colours: manager.original.colours.map((_, idx) => {
                const resolved = p.getAdjusted ? p.getAdjusted(idx) : p.get(idx);
                return resolved || { r: 0, g: 0, b: 0 };
            }),
        }));

        try {
            const result = PaletteTim.exportTim({
                imageData,
                palettes: bakedPalettes,
                colorToIndex,
                vramX: 0,
                vramY: 0,
                clutX: 0,
                clutY: 480, // arbitrary default clear of typical framebuffer area - adjust per-project in VRAM layout tooling
                preventTransparency: active.preventTransparency,
            }, manager.getBaseFileName());

            let message = `Exported ${result.clutHeight} palette(s) into one .tim, ` +
                `in list order (row 0 = "${orderedPalettes[0].name}"` +
                (orderedPalettes.length > 1 ? `, ... row ${orderedPalettes.length - 1} = "${orderedPalettes[orderedPalettes.length - 1].name}"` : "") +
                `).`;

            if (result.unmatchedPixelCount > 0) {
                message += `\n\nWarning: ${result.unmatchedPixelCount} pixel(s) didn't match ` +
                    `any colour in the palette and were written as index 0. This usually ` +
                    `means the loaded image isn't the exact one this palette was extracted from.`;
            }

            alert(message);
        } catch (error) {
            alert(`TIM export failed: ${error.message}`);
        }
    });

    initZoomPanListeners();
    initQuickEditListeners();
    initColourPickLogic();
    updateUI();

})();