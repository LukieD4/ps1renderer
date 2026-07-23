/**
 * project.js
 * Unified .TimGen project format (source image + Tab 1 settings + base
 * palette + CLUT variants), plus import of the two legacy formats so old
 * work isn't stranded:
 *   .BppProject  (old Image→BPP tool)  -> restores Tab 1
 *   .PaletteGen  (old PaletteGen tool) -> restores CLUTs as a palette-only
 *                                          project (load the matching image
 *                                          in Tab 1 to preview/export)
 *
 * Exposed as window.TG.project.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const FORMAT_VERSION = 1;

  function baseName(name) {
    if (!name) return "untitled";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function download(content, fileName, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- save ------------------------------------------------------------

  function save() {
    const image = TG.imgTab.serialize(); // null if no image loaded
    const manager = TG.palTab.getManager();
    const base = TG.state.image
      ? TG.state.image.basePalette.map(TG.color.rgbToHex)
      : (manager.original ? manager.original.colours.map(TG.color.rgbToHex) : []);

    const payload = {
      formatVersion: FORMAT_VERSION,
      app: "tim-gen",
      savedAt: new Date().toISOString(),
      base,
      image,
      cluts: manager.toJSON(),
    };
    const name = baseName(image ? image.fileName : (TG.state.source && TG.state.source.fileName)) + ".TimGen";
    download(JSON.stringify(payload), name, "application/json");
    TG.ui.toast(`Saved ${name}`);
  }

  // ---- load ------------------------------------------------------------

  async function loadTimGen(obj) {
    if (obj.image) {
      await TG.imgTab.restore(obj.image);          // publishes image block (resets CLUTs to default)
      TG.palTab.loadClutsFromProject(obj.cluts);   // then overlay the saved CLUTs
      TG.ui.toast("Project loaded");
    } else {
      // palette-only project (was saved without an image)
      const base = (obj.base || []).map(TG.color.hexToRgb);
      TG.palTab.importPaletteOnly(base, obj.cluts);
      TG.ui.toast("Project loaded (palette only — load its source image in the Image tab)");
    }
  }

  async function loadBppProject(obj) {
    // Map legacy .BppProject settings onto Tab 1's restore shape.
    const s = obj.settings || {};
    await TG.imgTab.restore({
      sourceImage: obj.sourceImage,
      fileName: obj.originalFileName || "untitled.png",
      bpp: s.bpp,
      adjust: { hue: s.hue || 0, saturation: s.saturation || 0, brightness: s.brightness || 0, contrast: s.contrast || 0 },
      dither: { mode: s.ditherMode || "none", strength: s.ditherStrength == null ? 1 : s.ditherStrength },
      palette: (obj.palette && obj.palette.colors) || [],
      locked: (obj.palette && obj.palette.locked) || [],
    });
    TG.ui.toast("Imported .BppProject into the Image tab");
  }

  function loadPaletteGen(obj) {
    // Legacy PaletteGen has no pixel data — restore base + CLUTs only.
    const base = (obj.original || []).map(TG.color.hexToRgb);
    const cluts = { palettes: obj.palettes || [], active: typeof obj.active === "number" ? obj.active : 0 };
    TG.palTab.importPaletteOnly(base, cluts);
    TG.ui.toast("Imported .PaletteGen — load its source image in the Image tab to preview/export");
  }

  function detectAndLoad(text) {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { TG.ui.toast("That file isn't a valid project (not JSON).", "error"); return; }

    try {
      if (obj.app === "tim-gen" || (obj.cluts && obj.base !== undefined)) return loadTimGen(obj);
      if (obj.settings && obj.sourceImage) return loadBppProject(obj);
      if (obj.original && Array.isArray(obj.palettes)) return loadPaletteGen(obj);
      TG.ui.toast("Unrecognized project file.", "error");
    } catch (err) {
      TG.ui.toast(err.message || "Couldn't load that project.", "error");
    }
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => detectAndLoad(e.target.result);
    reader.onerror = () => TG.ui.toast("Couldn't read that file", "error");
    reader.readAsText(file);
  }

  // ---- PNG export (Tab 1 output) --------------------------------------

  function exportPng() {
    if (!TG.imgTab.hasImage()) return;
    const canvas = TG.imgTab.getOutputCanvas();
    const name = `${baseName(TG.imgTab.getFileName())}_${TG.imgTab.getBpp()}bpp.png`;
    canvas.toBlob((blob) => { download(blob, name, "image/png"); TG.ui.toast("PNG exported"); }, "image/png");
  }

  TG.project = { save, loadFile, exportPng, baseName };
})(window);
