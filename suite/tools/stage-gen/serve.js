/*
 * serve.js
 *
 * Minimal zero-dependency static file server for stage-gen.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------
 * stage-gen's app.js is loaded as an ES module (`<script type="module">`),
 * which browsers refuse to fetch over file:// (CORS/module-source
 * restrictions - see the error this file was added to fix). Separately,
 * the File System Access API's showDirectoryPicker() (used by "Open
 * Assets Folder") is disabled on file:// origins in Chrome and
 * unsupported in Firefox entirely.
 *
 * Both problems disappear once the tool is served over plain HTTP, even
 * from localhost. This script is the smallest possible static file
 * server that does that - no npm install, no dependencies, just Node's
 * built-in http/fs/path modules. Run it from this folder with:
 *
 *   node serve.js
 *
 * then open the printed http://localhost:PORT/tools/stage-gen/ URL in
 * Chrome or Edge.
 *
 * ----------------------------------------------------------------------
 * WHY THE SERVER ROOT IS "suite/", NOT "stage-gen/"
 * ----------------------------------------------------------------------
 * stage-gen's index.html references shared suite-wide files one level
 * above every tool folder - "../../css/site.css" and "../../js/navbar.js"
 * - the same convention palette-maker and image-bpp use, so all three
 * tools share one stylesheet/navbar instead of duplicating them.
 *
 * If this server only serves the stage-gen/ folder itself, those "../../"
 * requests resolve to a path OUTSIDE stage-gen/ - which this server's own
 * path-traversal guard (see below) correctly refuses, but that means
 * site.css/navbar.js 404 silently and the page renders unstyled (white
 * background, generic font - exactly the symptom this comment block was
 * added to explain). Serving from suite/ instead (two levels up from this
 * file, i.e. stage-gen/../..) makes "../../css/site.css" resolve to a
 * REAL file inside the served root, so it works the same way it does for
 * every other tool in the suite.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8420;

// This file lives at suite/tools/stage-gen/serve.js, so two levels up is
// suite/ - the root every tool's shared "../../css/site.css" /
// "../../js/navbar.js" references actually resolve against.
const ROOT = path.resolve(__dirname, "..", "..");

// Minimal extension -> Content-Type map. Only what stage-gen actually
// serves (html/css/js) plus a few common static asset types, in case
// this ever needs to serve an image/font alongside the tool.
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
    // Strip query string, decode %-escapes, default "/" to the suite's own
    // index.html (suite/index.html) rather than stage-gen's, since ROOT is
    // now suite/ itself.
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";

    // Resolve against ROOT and refuse to serve anything outside it (basic
    // path-traversal guard - "../../etc/passwd"-style requests get
    // normalized and rejected rather than walked).
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end(`Not found: ${urlPath}`);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`suite static server running at http://localhost:${PORT}/`);
    console.log(`stage-gen: http://localhost:${PORT}/tools/stage-gen/`);
    console.log(`palette-maker: http://localhost:${PORT}/tools/palette-maker/`);
    console.log(`image-bpp: http://localhost:${PORT}/tools/image-bpp/`);
    console.log("Open stage-gen's URL in Chrome or Edge for the folder-picker");
    console.log("workflow (Firefox falls back to drag-and-drop automatically).");
    console.log("Ctrl+C to stop.");
});
