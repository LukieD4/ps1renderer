/**
 * core_color.js
 * One color toolkit for the whole tool. Both tabs and the exporters share it,
 * so RGB/hex conversion, HSL math, and PS1 15-bit packing live in exactly one
 * place instead of being re-implemented per feature.
 *
 * Canonical color shape across tim-gen is the object {r,g,b} (0-255). The
 * median-cut quantizer works internally in [r,g,b] arrays for speed; helpers
 * to bridge the two live here (toObj / toArr).
 *
 * Exposed as window.TG.color (TG = tim-gen shared namespace).
 */
(function (global) {
  "use strict";

  const TG = (global.TG = global.TG || {});

  function clamp8(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function toObj(c) {
    return Array.isArray(c) ? { r: c[0], g: c[1], b: c[2] } : { r: c.r, g: c.g, b: c.b };
  }

  function toArr(c) {
    return Array.isArray(c) ? [c[0], c[1], c[2]] : [c.r, c.g, c.b];
  }

  function rgbToHex(c) {
    const o = toObj(c);
    const h = (v) => clamp8(v).toString(16).padStart(2, "0");
    return `#${h(o.r)}${h(o.g)}${h(o.b)}`;
  }

  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const n = parseInt(clean, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function cssRgb(c) {
    const o = toObj(c);
    return `rgb(${o.r}, ${o.g}, ${o.b})`;
  }

  // --- HSL (0-360 / 0-100 / 0-100) --------------------------------------

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
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
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: clamp8(r * 255), g: clamp8(g * 255), b: clamp8(b * 255) };
  }

  /**
   * Non-destructive palette adjustment used by CLUT variants (Tab 2):
   * hue/sat/brightness are HSL offsets, contrast is the classic midpoint
   * factor. Matches the semantics palette-maker documented, kept in one
   * place so Tab 2's live preview and the baked TIM export never diverge.
   */
  function adjustColor(c, adj) {
    let { r, g, b } = toObj(c);
    const hue = adj.hue || 0, sat = adj.saturation || 0, bri = adj.brightness || 0, con = adj.contrast || 0;

    if (hue !== 0 || sat !== 0 || bri !== 0) {
      const hsl = rgbToHsl(r, g, b);
      hsl.h = (hsl.h + hue) % 360;
      if (hsl.h < 0) hsl.h += 360;
      hsl.s = Math.max(0, Math.min(100, hsl.s + sat));
      hsl.l = Math.max(0, Math.min(100, hsl.l + bri));
      const n = hslToRgb(hsl.h, hsl.s, hsl.l);
      r = n.r; g = n.g; b = n.b;
    }
    if (con !== 0) {
      const factor = (259 * (con + 255)) / (255 * (259 - con));
      r = clamp8((r - 128) * factor + 128);
      g = clamp8((g - 128) * factor + 128);
      b = clamp8((b - 128) * factor + 128);
    }
    return { r, g, b };
  }

  // --- PS1 15-bit (STP|B5|G5|R5) ----------------------------------------

  /**
   * Pack an {r,g,b} into PS1's 16-bit CLUT entry. When preventTransparency
   * is on and the color downsamples to pure black, STP is forced so the
   * hardware renders visible black instead of treating 0x0000 as transparent.
   */
  function packPs1(c, preventTransparency) {
    const o = toObj(c);
    const r5 = Math.floor(o.r / 8) & 0x1f;
    const g5 = Math.floor(o.g / 8) & 0x1f;
    const b5 = Math.floor(o.b / 8) & 0x1f;
    let stp = 0;
    if (r5 === 0 && g5 === 0 && b5 === 0 && preventTransparency !== false) stp = 1;
    return (stp << 15) | (b5 << 10) | (g5 << 5) | r5;
  }

  TG.color = {
    clamp8, toObj, toArr, rgbToHex, hexToRgb, cssRgb,
    rgbToHsl, hslToRgb, adjustColor, packPs1,
  };
})(window);
