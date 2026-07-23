/**
 * img_pipeline.js  (Tab 1)
 * Orchestrates adjust -> quantize -> dither and draws the result, returning
 * the per-pixel index buffer. Also owns palette (re)generation with lock
 * preservation.
 *
 * imgState shape (owned by img_tab.js):
 *   { bpp, adjust:{hue,saturation,brightness,contrast},
 *     dither:{mode,strength},
 *     palette:[[r,g,b], ...],   // working palette, [r,g,b] arrays
 *     locked:[bool, ...] }
 *
 * Exposed as window.TG.pipeline.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});

  // Rebuild palette from freshly-quantized colors, keeping any locked slot's
  // existing color at its index (mirrors the old PaletteModel.setFromArray).
  function regenerate(oldColors, oldLocked, newColors) {
    const colors = newColors.map((c) => [...c]);
    const locked = new Array(colors.length).fill(false);
    for (let i = 0; i < oldColors.length && i < colors.length; i++) {
      if (oldLocked[i]) { colors[i] = [...oldColors[i]]; locked[i] = true; }
    }
    return { colors, locked };
  }

  /**
   * @returns {{ indices: Uint8Array, width:number, height:number }}
   */
  function render(sourceCanvas, imgState, outputCanvas, doRegenerate) {
    const { width, height } = sourceCanvas;
    const srcImageData = sourceCanvas.getContext("2d").getImageData(0, 0, width, height);

    const adjusted = TG.adjust.applyAdjustments(srcImageData, imgState.adjust);

    if (doRegenerate || !imgState.palette || imgState.palette.length === 0) {
      const colorCount = Math.pow(2, imgState.bpp); // 4 -> 16, 8 -> 256
      const generated = TG.quantizer.buildPalette(adjusted.data, colorCount);
      const next = regenerate(imgState.palette || [], imgState.locked || [], generated);
      imgState.palette = next.colors;
      imgState.locked = next.locked;
    }

    const outData = new Uint8ClampedArray(adjusted.data.length);
    const indices = new Uint8Array(width * height);
    TG.dither.applyDither(
      imgState.dither.mode, adjusted.data, outData, indices,
      width, height, imgState.palette, imgState.dither.strength
    );

    outputCanvas.width = width;
    outputCanvas.height = height;
    outputCanvas.getContext("2d").putImageData(new ImageData(outData, width, height), 0, 0);

    return { indices, width, height };
  }

  TG.pipeline = { render, regenerate };
})(window);
