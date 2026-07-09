/**
 * ============================================================================
 * renderer.js
 *
 * Responsible for drawing the UI.
 *
 * No application logic lives here.
 *
 * app.js provides:
 *
 *  • palette manager
 *  • callbacks
 *  • image preview
 *
 * ============================================================================
 */

(function (global) {

    "use strict";

    //======================================================================
    // Helpers
    //======================================================================

    function clear(element) {

        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }

    }

    function rgb(colour) {

        return `rgb(${colour.r}, ${colour.g}, ${colour.b})`;

    }

    function rgbToHex(c) {
        const h = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
        return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
    }

    //======================================================================
    // Palette List
    //======================================================================

    function renderPaletteList(container, manager, onSelect, onRename, onReorder) {

        clear(container);

        let dragFromIndex = null;

        manager.palettes.forEach((palette, index) => {

            const item = document.createElement("div");

            item.className = "palette-item";
            item.title = "Click to select • Double-click to rename • Drag handle to reorder";
            item.draggable = true;

            if (index === manager.activeIndex) {
                item.classList.add("active");
            }

            const handle = document.createElement("span");
            handle.className = "palette-item__handle";
            handle.textContent = "⋮⋮";
            handle.title = "Drag to reorder";
            item.appendChild(handle);

            const label = document.createElement("span");
            label.className = "palette-item__label";
            label.textContent = palette.name;
            item.appendChild(label);

            // A plain click selects the palette, but a click is also the
            // first half of a dblclick - if we fire onSelect() (which
            // re-renders the whole list) immediately on click, the row
            // gets torn down before the dblclick handler ever sees it, so
            // rename would never trigger. Defer the select just long enough
            // for a possible second click to cancel it.
            let clickTimer = null;
            item.addEventListener("click", () => {
                if (clickTimer) clearTimeout(clickTimer);
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    onSelect(index);
                }, 220);
            });

            // Drag-to-reorder: HTML5 drag events on the whole row (the
            // handle is just a visual affordance, not a separate listener
            // target) keep this simple and touch-independent-free.
            item.addEventListener("dragstart", (e) => {
                dragFromIndex = index;
                item.classList.add("is-dragging");
                e.dataTransfer.effectAllowed = "move";
                // Some browsers require setData to enable the drag.
                e.dataTransfer.setData("text/plain", String(index));
            });

            item.addEventListener("dragend", () => {
                item.classList.remove("is-dragging");
                container.querySelectorAll(".palette-item").forEach(el => el.classList.remove("is-drop-target"));
                dragFromIndex = null;
            });

            item.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                item.classList.add("is-drop-target");
            });

            item.addEventListener("dragleave", () => {
                item.classList.remove("is-drop-target");
            });

            item.addEventListener("drop", (e) => {
                e.preventDefault();
                item.classList.remove("is-drop-target");
                const fromIndex = dragFromIndex !== null ? dragFromIndex : parseInt(e.dataTransfer.getData("text/plain"), 10);
                if (Number.isInteger(fromIndex) && fromIndex !== index && onReorder) {
                    onReorder(fromIndex, index);
                }
            });

            // Double-click swaps the label for an inline text input so the
            // person can rename in place, without a popup dialog breaking
            // their flow. This is purely cosmetic - see renamePalette().
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
                input.focus();
                input.select();

                const commit = () => {
                    if (onRename) onRename(index, input.value);
                    // onRename triggers a full re-render via updateUI, so no
                    // need to manually restore the label here.
                };
                const cancel = () => {
                    item.classList.remove("is-renaming");
                    item.replaceChild(label, input);
                };

                input.addEventListener("keydown", (ke) => {
                    if (ke.key === "Enter") { ke.preventDefault(); commit(); }
                    else if (ke.key === "Escape") { ke.preventDefault(); cancel(); }
                });
                input.addEventListener("blur", commit);
            });

            container.appendChild(item);

        });

    }

    //======================================================================
    // Swatches Rendering — click to open native colour picker, right-click
    // (or lock badge click) to toggle lock. Locking only protects a swatch
    // from bulk slider adjustments; it never blocks direct manual edits.
    //======================================================================

    function renderSwatches(container, palette, options) {
        container.innerHTML = "";
        if (!palette) return;

        palette.colours.forEach((colour, index) => {
            const wrapper = document.createElement("div");
            wrapper.className = "swatch-wrapper";

            if (options.editable && palette.isLocked && palette.isLocked(index)) {
                wrapper.classList.add("is-locked");
            }

            const swatch = document.createElement("div");
            const displayedColor = palette.getAdjusted ? palette.getAdjusted(index) : colour;
            swatch.className = "swatch";
            swatch.style.backgroundColor = `rgb(${displayedColor.r}, ${displayedColor.g}, ${displayedColor.b})`;
            swatch.title = options.editable
                ? `Click to edit • Right-click to ${palette.isLocked(index) ? "unlock" : "lock"}`
                : rgbToHex(displayedColor);

            if (options.editable) {

                // Hidden native colour input drives the actual picker UI.
                const colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.className = "swatch__color-input";
                colorInput.value = rgbToHex(palette.get(index));
                colorInput.tabIndex = -1;

                const lockBadge = document.createElement("div");
                lockBadge.className = "swatch__lock-indicator";
                lockBadge.textContent = palette.isLocked(index) ? "🔒" : "🔓";
                lockBadge.title = palette.isLocked(index)
                    ? "Locked — protected from bulk slider adjustments (click to unlock)"
                    : "Unlocked — click to lock against bulk slider adjustments";
                wrapper.appendChild(lockBadge);

                // Selection highlight + open colour picker on left-click.
                swatch.addEventListener("click", () => {
                    container.querySelectorAll(".swatch").forEach(s => s.classList.remove("is-selected"));
                    swatch.classList.add("is-selected");
                    container.dataset.selectedIndex = index;
                    colorInput.click();
                });

                colorInput.addEventListener("input", () => {
                    const hex = colorInput.value;
                    const r = parseInt(hex.substring(1, 3), 16);
                    const g = parseInt(hex.substring(3, 5), 16);
                    const b = parseInt(hex.substring(5, 7), 16);
                    palette.set(index, { r, g, b });
                    if (options.onColourChange) options.onColourChange(index);
                });

                // Right-click toggles lock without opening the picker.
                swatch.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    if (palette.toggleLock) {
                        palette.toggleLock(index);
                        if (options.onLockToggle) options.onLockToggle();
                    }
                });

                // Lock badge is also directly clickable, independent of the swatch.
                lockBadge.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (palette.toggleLock) {
                        palette.toggleLock(index);
                        if (options.onLockToggle) options.onLockToggle();
                    }
                });

                wrapper.appendChild(colorInput);
            } else {
                swatch.classList.add("readonly");
            }

            wrapper.appendChild(swatch);
            container.appendChild(wrapper);
        });
    }

    //======================================================================
    // Dual Preview Workspace Rendering
    //======================================================================

    function renderPreview(sourceCanvas, elements, manager) {

        const { canvasOrig, canvasRemap, previewSplit, placeholder, zoomControls } = elements;

        if (!sourceCanvas) {
            placeholder.classList.remove("hidden");
            previewSplit.classList.add("hidden");
            zoomControls.classList.add("hidden");
            return;
        }

        placeholder.classList.add("hidden");
        previewSplit.classList.remove("hidden");
        zoomControls.classList.remove("hidden");

        // 1. Draw original un-modified texture map reference
        PaletteImage.drawPreview(sourceCanvas, canvasOrig);

        // 2. Draw dynamically active VRAM mapping
        const activePalette = manager.getActive();
        if (activePalette && manager.original) {
            PaletteImage.drawRemappedPreview(sourceCanvas, canvasRemap, manager.original, activePalette);
        } else {
            PaletteImage.drawPreview(sourceCanvas, canvasRemap);
        }
    }

    //======================================================================
    // Image Info
    //======================================================================

    function renderImageInfo(nameElement,
                             sizeElement,
                             fileName,
                             width,
                             height) {

        nameElement.textContent = fileName;

        sizeElement.textContent =
            `${width} × ${height}`;

    }

    //======================================================================
    // Palette Count
    //======================================================================

    function renderPaletteCount(element, manager, maxPalettes) {
        if (!element) return;
        element.textContent = `${manager.palettes.length} / ${maxPalettes} palettes`;
    }

    //======================================================================
    // Active Palette Title
    //======================================================================

    function renderActiveTitle(element, palette) {

        if (!palette) {

            element.textContent = "Active Palette";

            return;

        }

        element.textContent = palette.name;

    }

    //======================================================================

    global.PaletteRenderer = {

        renderPaletteList,

        renderSwatches,

        renderPreview,

        renderImageInfo,

        renderActiveTitle,

        renderPaletteCount

    };

})(window);