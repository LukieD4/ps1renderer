/**
 * dither.js
 * Dithering strategies applied while mapping a source RGBA buffer onto a
 * fixed palette. Each function mutates `outData` (RGBA Uint8ClampedArray)
 * in place and returns nothing.
 */
(function (global) {
  const BAYER_8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ].map((row) => row.map((v) => v / 64 - 0.5)); // centered -0.5..+0.5

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  /** No dithering: plain nearest-color mapping. */
  function ditherNone(srcData, outData, width, height, palette) {
    const { nearestIndex } = window.BppQuantizer;
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const a = srcData[idx + 3];
      const pi = nearestIndex(palette, srcData[idx], srcData[idx + 1], srcData[idx + 2]);
      const p = palette[pi];
      outData[idx] = p[0];
      outData[idx + 1] = p[1];
      outData[idx + 2] = p[2];
      outData[idx + 3] = a;
    }
  }

  /** Ordered (Bayer 8x8) dithering. Fast, no error propagation, stable pattern. */
  function ditherOrdered(srcData, outData, width, height, palette, strength) {
    const { nearestIndex } = window.BppQuantizer;
    const amount = 48 * strength; // spread of the threshold matrix in color units
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const idx = i * 4;
        const a = srcData[idx + 3];
        const bayer = BAYER_8[y % 8][x % 8] * amount;
        const r = clamp255(srcData[idx] + bayer);
        const g = clamp255(srcData[idx + 1] + bayer);
        const b = clamp255(srcData[idx + 2] + bayer);
        const pi = nearestIndex(palette, r, g, b);
        const p = palette[pi];
        outData[idx] = p[0];
        outData[idx + 1] = p[1];
        outData[idx + 2] = p[2];
        outData[idx + 3] = a;
      }
    }
  }

  /** Floyd-Steinberg error-diffusion dithering. */
  function ditherFloydSteinberg(srcData, outData, width, height, palette, strength) {
    const { nearestIndex } = window.BppQuantizer;
    // Work on a float copy so error accumulates without clamping too early
    const buf = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      buf[i * 3] = srcData[i * 4];
      buf[i * 3 + 1] = srcData[i * 4 + 1];
      buf[i * 3 + 2] = srcData[i * 4 + 2];
    }

    function addError(x, y, er, eg, eb, factor) {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const i = (y * width + x) * 3;
      buf[i] += er * factor;
      buf[i + 1] += eg * factor;
      buf[i + 2] += eb * factor;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const bi = i * 3;
        const oldR = clamp255(buf[bi]);
        const oldG = clamp255(buf[bi + 1]);
        const oldB = clamp255(buf[bi + 2]);
        const pi = nearestIndex(palette, oldR, oldG, oldB);
        const p = palette[pi];

        const idx = i * 4;
        outData[idx] = p[0];
        outData[idx + 1] = p[1];
        outData[idx + 2] = p[2];
        outData[idx + 3] = srcData[idx + 3];

        const errR = (oldR - p[0]) * strength;
        const errG = (oldG - p[1]) * strength;
        const errB = (oldB - p[2]) * strength;

        addError(x + 1, y, errR, errG, errB, 7 / 16);
        addError(x - 1, y + 1, errR, errG, errB, 3 / 16);
        addError(x, y + 1, errR, errG, errB, 5 / 16);
        addError(x + 1, y + 1, errR, errG, errB, 1 / 16);
      }
    }
  }

  /**
   * Apply the named dither mode.
   * @param {'none'|'ordered'|'floyd-steinberg'} mode
   * @param {number} strength 0..1, applies to ordered & floyd-steinberg
   */
  function applyDither(mode, srcData, outData, width, height, palette, strength) {
    const s = strength === undefined ? 1 : strength;
    if (mode === "ordered") {
      ditherOrdered(srcData, outData, width, height, palette, s);
    } else if (mode === "floyd-steinberg") {
      ditherFloydSteinberg(srcData, outData, width, height, palette, s);
    } else {
      ditherNone(srcData, outData, width, height, palette);
    }
  }

  global.BppDither = { applyDither };
})(window);
