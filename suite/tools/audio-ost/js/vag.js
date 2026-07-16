/* ==========================================================================
   vag.js — read a .VAG file into a playable instrument sample.

   VAG layout (PS1AUDIO_SEMANTICS.txt §5): 48-byte BIG-ENDIAN header +
   raw SPU-ADPCM blocks. This module only READS (parsing / loading); the
   sibling audio-vag tool writes them.

     0x00  4   id            "VAGp"
     0x04  4   version       big-endian
     0x08  4   reserved
     0x0C  4   dataSize      waveform byte size, big-endian
     0x10  4   samplingFreq  Hz, big-endian
     0x14  12  reserved
     0x20  16  name          ASCII
     0x30  *   waveform      SPU-ADPCM blocks

   Loop points are not stored as fields — they live in the per-block flag
   bytes (§1): bit2 (0x04) = loop start, bit0 (0x01) = loop end. We scan the
   body to recover the loop region (in samples) so the engine can sustain.

   Exposes window.PS1AUDIO.vag.
   ========================================================================== */
(function (root) {
  "use strict";

  var BLOCK_BYTES = 16;
  var SAMPLES_PER_BLOCK = 28;

  function be32(dv, off) { return dv.getUint32(off, false) >>> 0; }

  // Scan block flag bytes to find the loop region in SAMPLES.
  // Returns { enabled, start, end } or { enabled:false }.
  function findLoop(body) {
    var nBlocks = Math.floor(body.length / BLOCK_BYTES);
    var startBlock = -1, endBlock = -1;
    for (var b = 0; b < nBlocks; b++) {
      var flag = body[b * BLOCK_BYTES + 1];
      if (flag === 0x07) continue;                                // one-shot terminator: not a musical loop
      if ((flag & 0x04) && startBlock < 0) startBlock = b;        // loop start marker
      if (flag & 0x01) endBlock = b;                             // loop end (sustain)
    }
    if (startBlock < 0) return { enabled: false, start: 0, end: 0 };
    if (endBlock < startBlock) endBlock = nBlocks - 1;
    return {
      enabled: true,
      start: startBlock * SAMPLES_PER_BLOCK,
      // end is exclusive of the block after the loop-end block
      end: (endBlock + 1) * SAMPLES_PER_BLOCK
    };
  }

  // parse — accepts an ArrayBuffer. Returns a descriptor with the raw
  // SPU-ADPCM body plus metadata, WITHOUT decoding (engine decodes).
  function parse(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    if (u8.length < 48) throw new Error("Not a VAG: file too short.");
    var dv = new DataView(arrayBuffer);
    var id = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (id !== "VAGp") throw new Error('Not a VAG: missing "VAGp" magic.');

    var version = be32(dv, 0x04);
    var dataSize = be32(dv, 0x0c);
    var sampleRate = be32(dv, 0x10);
    if (!sampleRate || sampleRate > 96000) sampleRate = 44100; // sanity fallback

    var name = "";
    for (var i = 0; i < 16; i++) {
      var c = u8[0x20 + i];
      if (c === 0) break;
      name += String.fromCharCode(c);
    }

    // Body starts at 0x30. Prefer dataSize if it looks sane, else use rest.
    var avail = u8.length - 0x30;
    var bodyLen = (dataSize > 0 && dataSize <= avail) ? dataSize : avail;
    bodyLen -= bodyLen % BLOCK_BYTES; // whole blocks only
    var body = u8.subarray(0x30, 0x30 + bodyLen);

    return {
      name: name.trim() || "VAG",
      version: version,
      sampleRate: sampleRate,
      body: body,                 // Uint8Array of SPU-ADPCM blocks
      loop: findLoop(body)
    };
  }

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.vag = { parse: parse, findLoop: findLoop };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PS1AUDIO.vag;
})(typeof window !== "undefined" ? window : globalThis);
