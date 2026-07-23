/**
 * tabs.js
 * The .NET-style tab shell. Clicking a tab button shows its panel and hides
 * the others; state is kept (panels are just toggled, never rebuilt), so
 * switching Image <-> Palettes never loses work. Emits "tab" on the shared
 * state bus so each tab can refresh itself when it becomes visible.
 *
 * Exposed as window.TG.tabs.
 */
(function (global) {
  "use strict";

  const TG = (global.TG = global.TG || {});

  function init() {
    const buttons = Array.from(document.querySelectorAll(".tab-btn"));
    const panels = Array.from(document.querySelectorAll(".tabpanel"));

    function activate(tab) {
      buttons.forEach((b) => {
        const on = b.dataset.tab === tab;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== tab));
      TG.state.ui.activeTab = tab;
      TG.state.emit("tab", { tab });
    }

    buttons.forEach((b) => b.addEventListener("click", () => activate(b.dataset.tab)));

    // Keyboard: left/right arrows move between tabs when one is focused.
    buttons.forEach((b, i) =>
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const next = buttons[(i + dir + buttons.length) % buttons.length];
          next.focus();
          activate(next.dataset.tab);
        }
      })
    );

    activate(TG.state.ui.activeTab || "image");
    return { activate };
  }

  TG.tabs = { init };
})(window);
