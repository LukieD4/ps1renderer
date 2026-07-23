/**
 * pal_model.js  (Tab 2 — Palettes / CLUTs)
 * Palette data model. A CLUT variant ("ColourPalette") is a recolor of the
 * base palette, keyed by index. Sliders (hue/sat/bright/contrast) and locks
 * are a live, non-destructive layer resolved via getAdjusted(); the raw
 * .colours array is what gets baked into the TIM.
 *
 * The "Original" here is the base palette handed over by Tab 1 — read-only,
 * the single source of truth for index->color. Tab 2 never edits it and
 * never touches pixel indices; it only creates recolors.
 *
 * Exposed as window.TG.palModel = { ColourPalette, PaletteManager }.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const { adjustColor, clamp8, rgbToHex, hexToRgb } = TG.color;

  class ColourPalette {
    constructor(name, colours = [], opts) {
      this.name = name;
      this.colours = colours.map((c) => ({ r: c.r, g: c.g, b: c.b }));
      this.locks = new Array(this.colours.length).fill(false);
      this.preventTransparency = true;
      this.hue = 0; this.saturation = 0; this.brightness = 0; this.contrast = 0;
      this.readOnly = !!(opts && opts.readOnly);
    }

    clone(newName) {
      const c = new ColourPalette(newName, this.colours);
      c.hue = this.hue; c.saturation = this.saturation;
      c.brightness = this.brightness; c.contrast = this.contrast;
      c.preventTransparency = this.preventTransparency;
      return c;
    }

    size() { return this.colours.length; }
    get(i) { return this.colours[i]; }
    isLocked(i) { return !!this.locks[i]; }
    toggleLock(i) {
      if (this.readOnly) return;
      if (i >= 0 && i < this.locks.length) this.locks[i] = !this.locks[i];
    }

    getAdjusted(i) {
      const c = this.colours[i];
      if (!c) return null;
      if (this.isLocked(i)) return { r: c.r, g: c.g, b: c.b };
      return adjustColor(c, { hue: this.hue, saturation: this.saturation, brightness: this.brightness, contrast: this.contrast });
    }

    set(i, colour) {
      if (this.readOnly) return;
      if (i < 0 || i >= this.colours.length) return;
      this.colours[i] = { r: clamp8(colour.r), g: clamp8(colour.g), b: clamp8(colour.b) };
    }

    // Resolve every slot to plain RGB (slider + lock layer flattened) — this
    // is exactly what one CLUT row becomes in the exported TIM.
    bake() {
      return this.colours.map((_, i) => this.getAdjusted(i) || { r: 0, g: 0, b: 0 });
    }

    toJSON() {
      return {
        name: this.name,
        colours: this.colours.map(rgbToHex),
        locks: this.locks.slice(),
        hue: this.hue, saturation: this.saturation, brightness: this.brightness, contrast: this.contrast,
        preventTransparency: this.preventTransparency,
      };
    }

    static fromJSON(data) {
      const p = new ColourPalette(data.name, (data.colours || []).map(hexToRgb));
      p.hue = data.hue || 0; p.saturation = data.saturation || 0;
      p.brightness = data.brightness || 0; p.contrast = data.contrast || 0;
      p.preventTransparency = data.preventTransparency !== false;
      if (Array.isArray(data.locks)) p.locks = p.colours.map((_, i) => !!data.locks[i]);
      return p;
    }
  }

  class PaletteManager {
    static MAX_PALETTES = 16;

    constructor() {
      this.original = null; // ColourPalette (readOnly) — the base from Tab 1
      this.palettes = [];
      this.activeIndex = -1;
    }

    hasBase() { return this.original !== null; }

    /** Fresh/structural (re)seed: base changed shape → reset to one default CLUT. */
    resetToBase(baseColours) {
      this.original = new ColourPalette("Base", baseColours, { readOnly: true });
      this.palettes = [this.original.clone("Palette 1")];
      this.activeIndex = 0;
    }

    /**
     * Non-structural re-base (same color count): update the base, and for
     * every CLUT re-seed its UNLOCKED slots from the new base while keeping
     * locked slots, all slider state, and names. Locks are the user's "pin
     * this color" intent and survive; loose recolors follow the image.
     */
    rebaseSameLength(baseColours) {
      if (!this.original) { this.resetToBase(baseColours); return; }
      this.original = new ColourPalette("Base", baseColours, { readOnly: true });
      this.palettes.forEach((p) => {
        for (let i = 0; i < p.colours.length && i < baseColours.length; i++) {
          if (!p.isLocked(i)) p.colours[i] = { r: baseColours[i].r, g: baseColours[i].g, b: baseColours[i].b };
        }
      });
    }

    createPalette(name) {
      if (!this.original) return null;
      if (this.palettes.length >= PaletteManager.MAX_PALETTES) return null;
      const p = this.original.clone(name || `Palette ${this.palettes.length + 1}`);
      this.palettes.push(p);
      this.activeIndex = this.palettes.length - 1;
      return p;
    }

    clonePalette(index) {
      if (index < 0 || index >= this.palettes.length) return null;
      if (this.palettes.length >= PaletteManager.MAX_PALETTES) return null;
      const src = this.palettes[index];
      const c = src.clone(`${src.name} Copy`);
      c.locks = src.locks.slice();
      this.palettes.push(c);
      this.activeIndex = this.palettes.length - 1;
      return c;
    }

    reorderPalette(from, to) {
      if (from === to) return;
      if (from < 0 || from >= this.palettes.length || to < 0 || to >= this.palettes.length) return;
      const active = this.getActive();
      const [moved] = this.palettes.splice(from, 1);
      this.palettes.splice(to, 0, moved);
      if (active) this.activeIndex = this.palettes.indexOf(active);
    }

    deleteActive() {
      if (this.activeIndex < 0) return;
      if (this.palettes.length <= 1) return;
      this.palettes.splice(this.activeIndex, 1);
      this.activeIndex = Math.max(0, this.activeIndex - 1);
    }

    getActive() { return this.activeIndex < 0 ? null : this.palettes[this.activeIndex]; }
    setActive(i) { if (i >= 0 && i < this.palettes.length) this.activeIndex = i; }

    renamePalette(i, name) {
      if (i < 0 || i >= this.palettes.length) return;
      const t = (name || "").trim();
      if (t) this.palettes[i].name = t;
    }

    toJSON() {
      return {
        palettes: this.palettes.map((p) => p.toJSON()),
        active: this.activeIndex,
      };
    }

    // Base is NOT restored from here — it always comes from Tab 1's image
    // block. This only restores the CLUT variants over an existing base.
    loadCluts(data) {
      if (!data || !Array.isArray(data.palettes)) return;
      this.palettes = data.palettes.map(ColourPalette.fromJSON);
      this.activeIndex = typeof data.active === "number" ? data.active : (this.palettes.length ? 0 : -1);
      if (this.activeIndex >= this.palettes.length) this.activeIndex = this.palettes.length - 1;
    }
  }

  TG.palModel = { ColourPalette, PaletteManager };
})(window);
