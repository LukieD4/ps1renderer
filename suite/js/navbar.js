/**
 * navbar.js
 * Shared site navbar, injected via JS so it works offline over file:// with
 * no server and no fetch() calls (which fail under file:// CORS rules).
 *
 * Usage: add <div id="site-navbar"></div> near the top of <body>, then
 * include this script. It fills that div with the shared nav markup and
 * highlights the current page based on document.body.dataset.navKey.
 *
 * To add a new tool later: add one entry to NAV_LINKS below. That's it —
 * every page that includes this script picks up the new link automatically.
 */
(function () {
  const NAV_LINKS = [
    { key: "home", label: "Home", href: "/index.html" },
    { key: "bpp", label: "BppProject", href: "/tools/image-bpp/index.html" },
    { key: "palette", label: "PaletteGen", href: "/tools/palette-maker/index.html" },
    { key: "vag", label: "VAG", href: "/tools/audio-vag/index.html" },
    { key: "ost", label: "OST Studio", href: "/tools/audio-ost/index.html" },
    { key: "stage", label: "StageGen", href: "/tools/stage-gen/index.html" },
    // Future tools go here, e.g.:
    // { key: "sprite-packer", label: "Sprite Packer", href: "/tools/sprite-packer/index.html" },
  ];

  function render() {
    const mount = document.getElementById("site-navbar");
    if (!mount) return;

    const activeKey = document.body.getAttribute("data-nav-key") || "";

    const linksHtml = NAV_LINKS.map((link) => {
      const isActive = link.key === activeKey;
      return `<a class="site-nav__link${isActive ? " is-active" : ""}"
                  href="${link.href}"
                  ${isActive ? 'aria-current="page"' : ""}>${link.label}</a>`;
    }).join("");

    mount.innerHTML = `
      <nav class="site-nav" aria-label="Site">
        <a class="site-nav__brand" href="/index.html">
          <span class="site-nav__brand-mark" aria-hidden="true">&#9635;</span>
          <span class="site-nav__brand-text">ps1renderer&#8202;/&#8202;Suite of<span class="site-nav__brand-dim"> Tools</span></span>
        </a>
        <div class="site-nav__links">${linksHtml}</div>
      </nav>
    `;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
