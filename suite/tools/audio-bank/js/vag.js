/* ==========================================================================
   vag.js — VAG file container writer (semantics doc §5).

   48-byte header (BIG-ENDIAN fields) followed by the raw SPU-ADPCM body.
   The console/WAV/VAB tables are little-endian, but the VAG *header* is
   big-endian, so these multi-byte fields are byte-swapped on write.

   Browser: window.PS1AUDIO.vag ; Node: module.exports.
   ========================================================================== */
(function (root) {
  "use strict";

  var HEADER_SIZE = 48;
  var VERSION = 0x00000020; // 0x20 — the common version

  // pitch register for a given playback rate: (rate << 12) / 44100.
  function pitchRegister(sampleRate) {
    return Math.round((sampleRate * 4096) / 44100);
  }

  // body: Uint8Array of SPU-ADPCM blocks. Returns a Uint8Array VAG file.
  function build(body, sampleRate, name) {
    var out = new Uint8Array(HEADER_SIZE + body.length);
    var dv = new DataView(out.buffer);

    // 0x00 id "VAGp"
    out[0] = 0x56; out[1] = 0x41; out[2] = 0x47; out[3] = 0x70;
    dv.setUint32(0x04, VERSION, false);      // version (big-endian)
    dv.setUint32(0x08, 0, false);            // reserved
    dv.setUint32(0x0c, body.length, false);  // dataSize (big-endian)
    dv.setUint32(0x10, sampleRate >>> 0, false); // samplingFrequency (big-endian)
    // 0x14..0x1F reserved (already zero)

    // 0x20 name — 16 bytes ASCII
    var nm = (name || "SAMPLE").toUpperCase().replace(/[^\x20-\x7E]/g, "").slice(0, 15);
    for (var i = 0; i < nm.length; i++) out[0x20 + i] = nm.charCodeAt(i);

    out.set(body, HEADER_SIZE);
    return out;
  }

  var api = { build: build, pitchRegister: pitchRegister, HEADER_SIZE: HEADER_SIZE };
  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.vag = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
