/**
 * adjust.js
 * Applies hue / saturation / brightness / contrast adjustments to an
 * RGBA buffer before quantization. Operates on a copy — never mutates
 * the original source buffer.
 */
(function (global) {
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;
    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return [h, s, l];
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [r * 255, g * 255, b * 255];
  }

  /**
   * @param {ImageData} imageData source (not mutated)
   * @param {object} opts { hue: -180..180, saturation: -100..100, brightness: -100..100, contrast: -100..100 }
   * @returns {ImageData} new adjusted ImageData
   */
  function applyAdjustments(imageData, opts) {
    const { width, height } = imageData;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);

    const hueShift = (opts.hue || 0) / 360; // -0.5..0.5
    const satMul = 1 + (opts.saturation || 0) / 100; // 0..2
    const brightAdd = (opts.brightness || 0) * 1.28; // -128..128 roughly
    const contrastFactor = (259 * ((opts.contrast || 0) + 259)) / (259 * (259 - (opts.contrast || 0)));

    for (let i = 0; i < src.length; i += 4) {
      let r = src[i], g = src[i + 1], b = src[i + 2];
      const a = src[i + 3];

      if (hueShift !== 0 || satMul !== 1) {
        let [h, s, l] = rgbToHsl(r, g, b);
        h = (h + hueShift + 1) % 1;
        s = Math.min(1, Math.max(0, s * satMul));
        [r, g, b] = hslToRgb(h, s, l);
      }

      // Brightness
      r += brightAdd;
      g += brightAdd;
      b += brightAdd;

      // Contrast (applied around midpoint 128)
      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;

      out[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      out[i + 3] = a;
    }

    return new ImageData(out, width, height);
  }

  global.BppAdjust = { applyAdjustments };
})(window);
