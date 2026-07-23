/**
 * state.js
 * Single source of truth for the whole tool, plus a minimal event bus so
 * Tab 2 can react when Tab 1 rebuilds the image block (and vice-versa).
 *
 * Data model
 * ----------
 *   source : { canvas, width, height, fileName }        the untouched loaded image
 *   image  : {                                          Tab 1 output = the "image block"
 *              bpp,                                      4 or 8 (=> 16 or 256 colors)
 *              adjust:{hue,saturation,brightness,contrast},
 *              dither:{mode,strength},
 *              basePalette:[{r,g,b}, ...],              ordered; index i = palette entry i
 *              indices:Uint8Array,                      width*height, values into basePalette
 *              outputCanvas                             rendered RGBA preview
 *            }
 *   cluts       : [ ColourPalette, ... ]                Tab 2 recolors of basePalette (by index)
 *   activeClut  : int
 *
 * The golden rule: Tab 2 treats image.basePalette + image.indices as READ-ONLY.
 * It only ever edits CLUT color values. Tab 1 is the only writer of the image
 * block. That is what keeps "editing Tab 1 never leaks from Tab 2" true by
 * construction rather than by discipline.
 *
 * Exposed as window.TG.state.
 */
(function (global) {
  "use strict";

  const TG = (global.TG = global.TG || {});

  const listeners = {}; // event -> [fn]

  const state = {
    source: null,
    image: null,
    cluts: [],
    activeClut: -1,
    ui: { activeTab: "image" },

    on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
      return () => {
        const a = listeners[evt];
        if (a) a.splice(a.indexOf(fn), 1);
      };
    },

    emit(evt, payload) {
      (listeners[evt] || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(`[state:${evt}]`, e); }
      });
    },

    hasImageBlock() {
      return !!(this.image && this.image.indices && this.image.basePalette);
    },
  };

  // Events (documented here so the wiring is discoverable):
  //   "source"        source image (re)loaded         -> {source}
  //   "image-block"   Tab 1 published a new image block-> {image, structural}
  //                     structural=true when color COUNT changed (16<->256 etc),
  //                     which invalidates existing CLUT index recolors.
  //   "cluts"         Tab 2 palette list changed       -> {cluts, activeClut}
  //   "tab"           active tab switched              -> {tab}
  //   "status"        transport status text should update
  TG.state = state;
})(window);
