/**
 * project.js
 * Save/load ".BppProject" files (JSON with embedded base64 source image)
 * and export the final result as a PNG.
 */
(function (global) {
  const PROJECT_VERSION = 1;

  /**
   * @param {object} params
   *   sourceCanvas: canvas holding the original (unmodified) loaded image
   *   state: { bpp, hue, saturation, brightness, contrast, ditherMode, ditherStrength, paletteModel }
   *   originalFileName: string
   * @returns {string} JSON string
   */
  function serializeProject({ sourceCanvas, state, originalFileName }) {
    const sourceDataUrl = sourceCanvas.toDataURL("image/png");
    const project = {
      formatVersion: PROJECT_VERSION,
      originalFileName: originalFileName || "untitled.png",
      savedAt: new Date().toISOString(),
      sourceImage: sourceDataUrl,
      settings: {
        bpp: state.bpp,
        hue: state.hue,
        saturation: state.saturation,
        brightness: state.brightness,
        contrast: state.contrast,
        ditherMode: state.ditherMode,
        ditherStrength: state.ditherStrength,
      },
      palette: state.paletteModel.toJSON(),
    };
    return JSON.stringify(project);
  }

  /**
   * Parses a .BppProject JSON string and loads the source image into an
   * offscreen canvas.
   * @returns {Promise<object>} { sourceCanvas, state, originalFileName }
   */
  function deserializeProject(jsonString) {
    return new Promise((resolve, reject) => {
      let project;
      try {
        project = JSON.parse(jsonString);
      } catch (e) {
        reject(new Error("This file isn't valid JSON — it may be corrupted or not a .BppProject file."));
        return;
      }
      if (!project.sourceImage || !project.settings) {
        reject(new Error("This file is missing required project data."));
        return;
      }

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);

        const paletteModel = window.BppPalette.PaletteModel.fromJSON(project.palette || { colors: [], locked: [] });

        resolve({
          sourceCanvas: canvas,
          state: {
            bpp: project.settings.bpp,
            hue: project.settings.hue,
            saturation: project.settings.saturation,
            brightness: project.settings.brightness,
            contrast: project.settings.contrast,
            ditherMode: project.settings.ditherMode,
            ditherStrength: project.settings.ditherStrength,
            paletteModel,
          },
          originalFileName: project.originalFileName,
        });
      };
      img.onerror = () => reject(new Error("Couldn't decode the embedded source image."));
      img.src = project.sourceImage;
    });
  }

  function baseName(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  }

  function triggerDownload(content, fileName, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveProjectFile({ sourceCanvas, state, originalFileName }) {
    const json = serializeProject({ sourceCanvas, state, originalFileName });
    const name = baseName(originalFileName || "untitled") + ".BppProject";
    triggerDownload(json, name, "application/json");
  }

  function exportPng(outputCanvas, originalFileName, bpp) {
    outputCanvas.toBlob((blob) => {
      const name = baseName(originalFileName || "untitled") + `_${bpp}bpp.png`;
      triggerDownload(blob, name, "image/png");
    }, "image/png");
  }

  global.BppProject = {
    serializeProject,
    deserializeProject,
    saveProjectFile,
    exportPng,
    baseName,
  };
})(window);
