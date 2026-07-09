/**
 * ============================================================================
 * palette.js
 *
 * Palette data model for PaletteGen with Non-destructive Bulk Sliders.
 * ============================================================================
 */

(function (global) {

    "use strict";

    //======================================================================
    // Color Space Mathematics Utilities
    //======================================================================

    function clamp(v) {
        return Math.max(0, Math.min(255, Math.round(v)));
    }

    function rgbToHex(rgb) {
        return "#"
            + clamp(rgb.r).toString(16).padStart(2, "0")
            + clamp(rgb.g).toString(16).padStart(2, "0")
            + clamp(rgb.b).toString(16).padStart(2, "0");
    }

    function hexToRgb(hex) {
        hex = hex.replace("#", "");
        return {
            r: parseInt(hex.substring(0, 2), 16),
            g: parseInt(hex.substring(2, 4), 16),
            b: parseInt(hex.substring(4, 6), 16)
        };
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0, l = (max + min) / 2;

        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) {
                h = (g - b) / d + (g < b ? 6 : 0);
            } else if (max === g) {
                h = (b - r) / d + 2;
            } else if (max === b) {
                h = (r - g) / d + 4;
            }
            h /= 6;
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    function hslToRgb(h, s, l) {
        h /= 360; s /= 100; l /= 100;
        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }
        return { r: clamp(r * 255), g: clamp(g * 255), b: clamp(b * 255) };
    }

    //======================================================================
    // ColourPalette Model
    //======================================================================

    class ColourPalette {

        constructor(name, colours = [], opts) {
            this.name = name;
            this.colours = colours.map(c => ({ ...c }));

            // Feature: Track locks independently per index slot
            this.locks = new Array(this.colours.length).fill(false);

            // Feature: Safeguard state (true = opaque black, false = transparent)
            this.preventTransparency = true;

            // Non-destructive bulk slider transformations
            this.hue = 0;
            this.saturation = 0;
            this.brightness = 0;
            this.contrast = 0;

            // Defense-in-depth: the "Original" palette (built once in
            // loadOriginal from the source image) must always remain the
            // untouched reference copy - every export/CLUT/TIM path reads
            // colour-to-index mapping from it, so if it ever drifted, every
            // exported palette's index assignment would silently drift with
            // it. The UI never wires editing controls to it (rendered with
            // editable:false), but set()/toggleLock() also refuse to mutate
            // a readOnly instance directly, so a coding mistake elsewhere
            // can't accidentally corrupt it either.
            this.readOnly = !!(opts && opts.readOnly);
        }

        clone(newName) {
            const cloned = new ColourPalette(newName, this.colours);
            cloned.hue = this.hue;
            cloned.saturation = this.saturation;
            cloned.brightness = this.brightness;
            cloned.contrast = this.contrast;
            cloned.preventTransparency = this.preventTransparency;
            // Note: locks are reset on new palette creation/cloning
            return cloned;
        }

        // Feature: Lock helpers
        toggleLock(index) {
            if (this.readOnly) return;
            if (index >= 0 && index < this.locks.length) {
                this.locks[index] = !this.locks[index];
            }
        }

        isLocked(index) {
            return !!this.locks[index];
        }

        size() {
            return this.colours.length;
        }

        get(index) {
            return this.colours[index];
        }

        /**
         * Computes the final RGB color, factoring in bulk adjustments and locks.
         */
        getAdjusted(index) {
            const c = this.colours[index];
            if (!c) return null;

            // IF slot is locked, ignore bulk modifications
            if (this.isLocked(index)) {
                return { r: c.r, g: c.g, b: c.b };
            }

            let r = c.r, g = c.g, b = c.b;

            // 1. Process Hue, Saturation, and Brightness changes
            if (this.hue !== 0 || this.saturation !== 0 || this.brightness !== 0) {
                let hsl = rgbToHsl(r, g, b);
                hsl.h = (hsl.h + this.hue) % 360;
                if (hsl.h < 0) hsl.h += 360;
                hsl.s = Math.max(0, Math.min(100, hsl.s + this.saturation));
                hsl.l = Math.max(0, Math.min(100, hsl.l + this.brightness));
                const rgbNew = hslToRgb(hsl.h, hsl.s, hsl.l);
                r = rgbNew.r; g = rgbNew.g; b = rgbNew.b;
            }

            // 2. Process Contrast
            if (this.contrast !== 0) {
                const factor = (259 * (this.contrast + 255)) / (255 * (259 - this.contrast));
                r = clamp((r - 128) * factor + 128);
                g = clamp((g - 128) * factor + 128);
                b = clamp((b - 128) * factor + 128);
            }

            return { r, g, b };
        }

        set(index, colour) {
            // Manual edits (colour picker) are intentional overrides and should
            // work regardless of lock state - locking only protects a swatch
            // from *bulk* slider adjustments, not from direct edits. The
            // Original reference palette is the one exception: it must never
            // be edited by any path, since every export derives its colour
            // index mapping from it.
            if (this.readOnly) return;
            if (index < 0 || index >= this.colours.length) return;
            this.colours[index] = {
                r: clamp(colour.r),
                g: clamp(colour.g),
                b: clamp(colour.b)
            };
        }

        toJSON() {
            return {
                name: this.name,
                colours: this.colours.map(rgbToHex),
                locks: this.locks.slice(),
                hue: this.hue,
                saturation: this.saturation,
                brightness: this.brightness,
                contrast: this.contrast,
                preventTransparency: this.preventTransparency // Saved state
            };
        }

        static fromJSON(data) {
            const palette = new ColourPalette(data.name, data.colours.map(hexToRgb));
            palette.hue = data.hue || 0;
            palette.saturation = data.saturation || 0;
            palette.brightness = data.brightness || 0;
            palette.contrast = data.contrast || 0;
            palette.preventTransparency = data.preventTransparency !== false;

            // Restore per-swatch locks so a swatch the user locked before
            // saving stays protected from the hue/sat/brightness/contrast
            // sliders after reloading, instead of silently unlocking and
            // letting the bulk adjustments start affecting it again.
            if (Array.isArray(data.locks)) {
                palette.locks = palette.colours.map((_, i) => !!data.locks[i]);
            }

            return palette;
        }

    }

    //======================================================================
    // PaletteManager
    //======================================================================

    class PaletteManager {

        static MAX_PALETTES = 16;

        constructor() {
            this.original = null;
            this.palettes = [];
            this.activeIndex = -1;
            this.sourceFileName = null;
        }

        /**
         * Sets the source image's extracted colour set.
         *
         * By default this also resets any existing palettes, since a brand
         * new image's colours generally have nothing to do with whatever
         * palette was being edited before. Pass { preservePalettes: true }
         * to keep existing palettes around instead - used when a project
         * was already loaded and the person is now just attaching the
         * matching source image, so the palette they were editing survives.
         */
        loadOriginal(colours, opts) {
            const preservePalettes = !!(opts && opts.preservePalettes);
            this.original = new ColourPalette("Original", colours, { readOnly: true });
            if (!preservePalettes) {
                this.palettes = [];
                this.activeIndex = -1;
            } else if (this.palettes.length > 0 && this.activeIndex < 0) {
                this.activeIndex = 0;
            }
        }

        createPalette(name) {
            if (!this.original) return null;
            if (this.palettes.length >= PaletteManager.MAX_PALETTES) return null;
            const palette = this.original.clone(name || `Palette ${this.palettes.length + 1}`);
            this.palettes.push(palette);
            this.activeIndex = this.palettes.length - 1;
            return palette;
        }

        /**
         * Clones an existing palette (colours, locks, and slider state) as a
         * new entry appended to the list and made active. Distinct from
         * createPalette(), which always starts from the untouched Original.
         */
        clonePalette(index) {
            if (index < 0 || index >= this.palettes.length) return null;
            if (this.palettes.length >= PaletteManager.MAX_PALETTES) return null;
            const source = this.palettes[index];
            const cloned = source.clone(`${source.name} Copy`);
            cloned.locks = source.locks.slice();
            this.palettes.push(cloned);
            this.activeIndex = this.palettes.length - 1;
            return cloned;
        }

        /**
         * Moves the palette at fromIndex to toIndex, reordering the list
         * (used by drag-to-reorder in the sidebar). Keeps the active
         * selection pointed at the same palette even though its index shifts.
         */
        reorderPalette(fromIndex, toIndex) {
            if (fromIndex === toIndex) return;
            if (fromIndex < 0 || fromIndex >= this.palettes.length) return;
            if (toIndex < 0 || toIndex >= this.palettes.length) return;

            const activePalette = this.getActive();
            const [moved] = this.palettes.splice(fromIndex, 1);
            this.palettes.splice(toIndex, 0, moved);

            if (activePalette) {
                this.activeIndex = this.palettes.indexOf(activePalette);
            }
        }

        /**
         * Deletes the active palette. Refuses to drop below 1 remaining
         * palette - there must always be at least one for the workbench to
         * have something to edit/export.
         */
        deleteActive() {
            if (this.activeIndex < 0) return;
            if (this.palettes.length <= 1) return;
            this.palettes.splice(this.activeIndex, 1);
            this.activeIndex = Math.max(0, this.activeIndex - 1);
        }

        getActive() {
            if (this.activeIndex < 0) return null;
            return this.palettes[this.activeIndex];
        }

        setActive(index) {
            if (index < 0 || index >= this.palettes.length) return;
            this.activeIndex = index;
        }

        /**
         * Renames a palette for display purposes only - purely cosmetic,
         * has no effect on colours, indices, locks, or export output.
         */
        renamePalette(index, newName) {
            if (index < 0 || index >= this.palettes.length) return;
            const trimmed = (newName || "").trim();
            if (!trimmed) return;
            this.palettes[index].name = trimmed;
        }

        clear() {
            this.original = null;
            this.palettes = [];
            this.activeIndex = -1;
            this.sourceFileName = null;
        }

        /**
         * Strips the extension from a filename, e.g. "sprite.png" -> "sprite"
         */
        getBaseFileName() {
            if (!this.sourceFileName) return "palette-workspace";
            const dot = this.sourceFileName.lastIndexOf(".");
            return dot > 0 ? this.sourceFileName.substring(0, dot) : this.sourceFileName;
        }

        toJSON() {
            return {
                original: this.original ? this.original.colours.map(rgbToHex) : [],
                palettes: this.palettes.map(p => p.toJSON()),
                active: this.activeIndex,
                sourceFileName: this.sourceFileName || null
            };
        }

        fromJSON(data) {
            this.original = new ColourPalette("Original", data.original.map(hexToRgb), { readOnly: true });
            this.palettes = data.palettes.map(ColourPalette.fromJSON);
            this.activeIndex = data.active;
            this.sourceFileName = data.sourceFileName || null;
        }

    }

    global.PaletteGen = {
        PaletteManager,
        ColourPalette,
        rgbToHex,
        hexToRgb
    };

})(window);