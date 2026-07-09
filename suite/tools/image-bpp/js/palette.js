/**
 * palette.js
 * Wraps a palette (array of [r,g,b]) with helpers for editing, locking
 * individual entries against regeneration, and hex conversion.
 */
(function (global) {
  function rgbToHex([r, g, b]) {
    return (
      "#" +
      [r, g, b]
        .map((v) => Math.round(v).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const bigint = parseInt(clean, 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
  }

  /**
   * PaletteModel keeps the current palette plus a parallel `locked` boolean
   * array. Locked entries are preserved when the palette is regenerated
   * from image data (e.g. after changing bpp or re-running quantization).
   */
  class PaletteModel {
    constructor() {
      this.colors = []; // array of [r,g,b]
      this.locked = []; // array of booleans, same length as colors
    }

    setFromArray(colorArray) {
      // Preserve locked entries at their existing index where possible
      const newColors = colorArray.map((c) => [...c]);
      const newLocked = new Array(newColors.length).fill(false);
      for (let i = 0; i < this.colors.length && i < newColors.length; i++) {
        if (this.locked[i]) {
          newColors[i] = [...this.colors[i]];
          newLocked[i] = true;
        }
      }
      this.colors = newColors;
      this.locked = newLocked;
    }

    setColor(index, rgb) {
      if (index < 0 || index >= this.colors.length) return;
      this.colors[index] = [...rgb];
    }

    toggleLock(index) {
      if (index < 0 || index >= this.locked.length) return;
      this.locked[index] = !this.locked[index];
    }

    size() {
      return this.colors.length;
    }

    clone() {
      const p = new PaletteModel();
      p.colors = this.colors.map((c) => [...c]);
      p.locked = [...this.locked];
      return p;
    }

    toJSON() {
      return {
        colors: this.colors.map(rgbToHex),
        locked: [...this.locked],
      };
    }

    static fromJSON(json) {
      const p = new PaletteModel();
      p.colors = (json.colors || []).map(hexToRgb);
      p.locked = json.locked ? [...json.locked] : p.colors.map(() => false);
      return p;
    }
  }

  global.BppPalette = { PaletteModel, rgbToHex, hexToRgb };
})(window);
