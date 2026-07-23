/**
 * core_viewport.js
 * Reusable zoom + pan + click-to-pick controller for one or more canvases
 * that share a single transform. Replaces the per-tool zoom/pan code that
 * image-bpp and palette-maker each carried separately.
 *
 *   const vp = TG.viewport.create({
 *     surfaces: [viewportDivA, viewportDivB],  // elements that receive wheel/drag
 *     canvases: [canvasA, canvasB],            // canvases moved together
 *     enabled: () => bool,                     // gate (e.g. only when an image exists)
 *     onPick: (canvasEl, x, y) => {}           // fired on a click that wasn't a drag
 *   });
 *   vp.reset();  vp.apply();  vp.getScale();
 *
 * Exposed as window.TG.viewport.
 */
(function (global) {
  "use strict";

  const TG = (global.TG = global.TG || {});

  function create(opts) {
    const surfaces = opts.surfaces || [];
    const canvases = opts.canvases || [];
    const enabled = opts.enabled || (() => true);
    const onPick = opts.onPick;
    const minScale = opts.minScale || 0.1;
    const maxScale = opts.maxScale || 64;

    let scale = 1, panX = 0, panY = 0;
    let dragging = false, didDrag = false, startX = 0, startY = 0;

    function apply() {
      const t = `translate(${panX}px, ${panY}px) scale(${scale})`;
      canvases.forEach((c) => { if (c) c.style.transform = t; });
      if (opts.label) opts.label.textContent = `${Math.round(scale * 100)}%`;
    }

    function reset() {
      scale = 1; panX = 0; panY = 0;
      apply();
    }

    function zoomBy(factor) {
      scale = Math.max(minScale, Math.min(maxScale, scale * factor));
      apply();
    }

    surfaces.forEach((surf) => {
      if (!surf) return;
      surf.addEventListener("mousedown", (e) => {
        if (!enabled()) return;
        dragging = true;
        didDrag = false;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
      });
      surf.addEventListener("wheel", (e) => {
        if (!enabled()) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX - panX;
      const dy = e.clientY - startY - panY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      apply();
    });
    window.addEventListener("mouseup", () => { dragging = false; });

    // Click-to-pick on each canvas (ignored when the click ended a pan-drag).
    if (onPick) {
      canvases.forEach((canvas) => {
        if (!canvas) return;
        canvas.addEventListener("click", (e) => {
          if (didDrag) { didDrag = false; return; }
          if (!enabled()) return;
          const rect = canvas.getBoundingClientRect();
          const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
          const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
          onPick(canvas, x, y);
        });
      });
    }

    return {
      apply, reset, zoomBy,
      getScale: () => scale,
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(1 / 1.25),
    };
  }

  TG.viewport = { create };
})(window);
