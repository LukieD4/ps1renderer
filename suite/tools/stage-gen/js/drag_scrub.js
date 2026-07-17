/*
 * drag_scrub.js
 *
 * Blender-style "click to type, drag to scrub" behavior for <input
 * type="number"> fields (pos/rot/scale/palette/camera fields).
 *
 * ----------------------------------------------------------------------
 * WHY A SEPARATE MODULE, NOT JUST A NATIVE <input type="range">
 * ----------------------------------------------------------------------
 * A <input type="range"> slider needs a fixed min/max, which none of
 * these fields have (position/rotation/scale are all open-ended - a
 * scene can place an object anywhere). Blender's own numeric fields solve
 * this with unbounded RELATIVE drag: horizontal or vertical mouse
 * movement while the mouse button is held nudges the value up/down by an
 * amount proportional to how far you've dragged, with no fixed range,
 * and a plain click (movement below a small threshold) still focuses the
 * field normally for direct typing. That's what this module reproduces.
 *
 * ----------------------------------------------------------------------
 * CLICK vs DRAG DISAMBIGUATION
 * ----------------------------------------------------------------------
 * mousedown always fires first, with no way yet to know if this will
 * become a click or a drag. The field is NOT focused/selected on
 * mousedown - instead, every subsequent mousemove is checked against a
 * small pixel threshold (DRAG_THRESHOLD_PX). If the cursor moves past
 * that threshold before mouseup, the gesture becomes a scrub (drag) and
 * the field's value updates continuously with the mouse; the browser's
 * default text-selection/focus behavior is suppressed for that gesture
 * via preventDefault() on mousedown. If mouseup fires BEFORE the
 * threshold is crossed, it's treated as a genuine click: the field is
 * focused and its text selected, exactly like clicking any normal
 * number input, so typing an exact value still works perfectly.
 */

const DRAG_THRESHOLD_PX = 4;

/**
 * Wire drag-to-scrub onto a single <input type="number"> element.
 *
 * `options.sensitivity` - how much the value changes per pixel of drag
 * (default 0.05, i.e. 20px of drag = 1.0 unit - tuned for position/scale
 * fields; rotation fields pass a larger sensitivity since they're
 * typically dragged in bigger increments, e.g. whole degrees).
 *
 * `options.onScrubEnd` - called once when a scrub gesture finishes (mouse
 * released after actually dragging, not after a plain click) - lets
 * callers push a SINGLE undo history entry for the whole scrub instead of
 * one per intermediate value.
 *
 * ----------------------------------------------------------------------
 * LIVE UPDATES WHILE DRAGGING (not just on release)
 * ----------------------------------------------------------------------
 * Every value change during the drag dispatches a native 'input' event
 * (not 'change') - app.js listens for 'input' on these fields to apply
 * the value to state + the viewport IMMEDIATELY on every mousemove,
 * WITHOUT pushing undo history (that would spam one history entry per
 * pixel of movement). 'change' still fires exactly once, at mouseup, and
 * IS what pushes the single undo entry for the whole gesture - mirroring
 * the same pattern already used for TransformControls gizmo drags
 * (onDragStart snapshots once, onTransformChange applies continuously -
 * see viewer.js). A plain click (never crosses the drag threshold) fires
 * neither event; the field just gets focused for typing, and normal
 * typed edits still go through 'change' only, exactly as before.
 */
export function makeScrubbable(inputEl, options = {}) {
  const sensitivity = options.sensitivity ?? 0.05;
  const onScrubEnd = options.onScrubEnd ?? (() => {});

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startValue = 0;

  inputEl.addEventListener('mousedown', (event) => {
    // Only the left button starts a scrub gesture; other buttons (e.g.
    // right-click for a context menu) should behave natively.
    if (event.button !== 0) return;

    dragging = false; // not yet known to be a drag - see header comment
    startX = event.clientX;
    startY = event.clientY;
    startValue = parseFloat(inputEl.value) || 0;

    const step = parseFloat(inputEl.step) || 1;

    function handleMouseMove(moveEvent) {
      const dx = moveEvent.clientX - startX;
      const dy = startY - moveEvent.clientY; // inverted: drag UP increases value, matching Blender

      if (!dragging) {
        const dist = Math.hypot(dx, dy);
        if (dist < DRAG_THRESHOLD_PX) return; // still just a click-in-progress, not a drag yet

        dragging = true;
        inputEl.classList.add('is-scrubbing');
        // Suppress native text selection now that we're committed to a
        // drag gesture (mousedown's own preventDefault below already
        // stopped focus, this additionally stops selection during move).
        document.body.style.userSelect = 'none';
      }

      // Combine horizontal and vertical movement into one signed delta -
      // dragging right OR up both increase the value, left/down decrease
      // it, matching how Blender's own fields respond to either axis.
      const delta = (dx + dy) * sensitivity * Math.max(step, 0.001) * 20;
      const rawValue = startValue + delta;

      // Snap to the field's own step size (if it declares one finer than
      // 1) so scrubbing a rotation field (step=1, whole degrees) doesn't
      // produce noisy fractional degrees, while a position field
      // (step=0.1) still scrubs smoothly at its own finer resolution.
      let snapped = step > 0 ? Math.round(rawValue / step) * step : rawValue;

      // Respect a declared min/max (e.g. the palette row field's min="0")
      // so scrubbing can't drag a field into a value the field itself
      // says is invalid - native number inputs don't clamp typed/scripted
      // .value assignments on their own, only on form submission.
      if (inputEl.min !== '') snapped = Math.max(snapped, parseFloat(inputEl.min));
      if (inputEl.max !== '') snapped = Math.min(snapped, parseFloat(inputEl.max));

      inputEl.value = Number(snapped.toFixed(4));

      // Live-apply this intermediate value to state + the viewport RIGHT
      // NOW (not just at mouseup) - see this function's own header
      // comment for why this is 'input', not 'change'.
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function handleMouseUp() {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';

      if (dragging) {
        inputEl.classList.remove('is-scrubbing');
        // Fire the field's normal 'change' listener (app.js's
        // wireInstanceField/wireCameraField) so the scrubbed value
        // actually gets applied to state + the viewport, same as if the
        // user had typed it and pressed Enter/blurred the field.
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        onScrubEnd();
      } else {
        // Below the drag threshold the whole time - treat as a genuine
        // click: focus and select-all, exactly like a normal number
        // input, so the user can immediately type an exact value.
        inputEl.focus();
        inputEl.select();
      }
    }

    // preventDefault on mousedown stops the browser's default "focus +
    // place text cursor" behavior from happening immediately - if a drag
    // follows, we never want focus/cursor-placement to have happened at
    // all; if it turns out to be a click (handleMouseUp's else branch),
    // we focus explicitly there instead.
    event.preventDefault();

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  });
}

/**
 * Convenience: wire drag-to-scrub onto every <input type="number"> inside
 * a container element at once, using one sensitivity for all of them.
 * Used by app.js to batch-wire each field-grid's inputs in one call
 * rather than repeating makeScrubbable() per individual input id.
 */
export function makeAllScrubbable(containerEl, options = {}) {
  const inputs = containerEl.querySelectorAll('input[type="number"]');
  inputs.forEach((input) => makeScrubbable(input, options));
}
