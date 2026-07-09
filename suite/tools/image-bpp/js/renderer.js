/**
 * renderer.js
 * Ties adjust.js -> quantizer.js -> dither.js together and draws the
 * result onto a target canvas. Also exposes a palette-regeneration path
 * used when bpp or source image changes but existing locked colors
 * should be preserved.
 */
(function (global) {
  /**
   * @param {HTMLCanvasElement} sourceCanvas - holds the original loaded image at native size
   * @param {object} state - { bpp, hue, saturation, brightness, contrast, ditherMode, ditherStrength, paletteModel }
   * @param {HTMLCanvasElement} outputCanvas - where the final result is drawn
   * @param {boolean} regeneratePalette - if true, rebuild palette colors (respecting locks)
   */
  function renderPipeline(sourceCanvas, state, outputCanvas, regeneratePalette) {
    const ctx = sourceCanvas.getContext("2d");
    const { width, height } = sourceCanvas;
    const srcImageData = ctx.getImageData(0, 0, width, height);

    const adjusted = window.BppAdjust.applyAdjustments(srcImageData, {
      hue: state.hue,
      saturation: state.saturation,
      brightness: state.brightness,
      contrast: state.contrast,
    });

    if (regeneratePalette) {
      const colorCount = Math.pow(2, state.bpp);
      const generated = window.BppQuantizer.buildPalette(adjusted.data, colorCount);
      state.paletteModel.setFromArray(generated);
    }

    const outData = new Uint8ClampedArray(adjusted.data.length);
    window.BppDither.applyDither(
      state.ditherMode,
      adjusted.data,
      outData,
      width,
      height,
      state.paletteModel.colors,
      state.ditherStrength
    );

    outputCanvas.width = width;
    outputCanvas.height = height;
    const outCtx = outputCanvas.getContext("2d");
    outCtx.putImageData(new ImageData(outData, width, height), 0, 0);
  }

  global.BppRenderer = { renderPipeline };
})(window);
