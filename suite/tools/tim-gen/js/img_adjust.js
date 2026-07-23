/**
 * img_adjust.js  (Tab 1)
 * Applies hue/saturation/brightness/contrast to the source RGBA buffer
 * BEFORE quantization. These are image-space edits (they change what gets
 * quantized) and are entirely separate from Tab 2's per-CLUT adjustments.
 * Operates on a copy — never mutates the source.
 *
 * Exposed as window.TG.adjust.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const { rgbToHsl, hslToRgb } = TG.color;

  function applyAdjustments(imageData, opts) {
    const { width, height } = imageData;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);

    const hue = opts.hue || 0;
    const sat = opts.saturation || 0;
    const brightAdd = (opts.brightness || 0) * 1.28;
    const contrast = opts.contrast || 0;
    const contrastFactor = (259 * (contrast + 259)) / (259 * (259 - contrast));

    for (let i = 0; i < src.length; i += 4) {
      let r = src[i], g = src[i + 1], b = src[i + 2];
      const a = src[i + 3];

      if (hue !== 0 || sat !== 0) {
        const hsl = rgbToHsl(r, g, b);
        hsl.h = (hsl.h + hue) % 360;
        if (hsl.h < 0) hsl.h += 360;
        hsl.s = Math.min(100, Math.max(0, hsl.s * (1 + sat / 100)));
        const n = hslToRgb(hsl.h, hsl.s, hsl.l);
        r = n.r; g = n.g; b = n.b;
      }

      r += brightAdd; g += brightAdd; b += brightAdd;
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

  TG.adjust = { applyAdjustments };
})(window);
