/* ==========================================================================
   wav.js — minimal RIFF/WAVE parser for the PS1 Audio Bank tool.

   Supports PCM 8/16/24/32-bit integer and 32/64-bit IEEE float, mono or
   multi-channel. Reads the optional `smpl` chunk so WAV loop points come
   through automatically (semantics doc §10: "auto-read WAV smpl/cue chunks").

   Returns channels as Float32Array in -1..1, plus sampleRate and loop info.
   Browser: window.PS1AUDIO.wav ; Node: module.exports.
   ========================================================================== */
(function (root) {
  "use strict";

  function readString(dv, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  }

  function parse(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    if (readString(dv, 0, 4) !== "RIFF" || readString(dv, 8, 4) !== "WAVE") {
      throw new Error("Not a WAV file (missing RIFF/WAVE header).");
    }

    var fmt = null, dataOffset = -1, dataSize = 0, loops = [];
    var pos = 12;
    while (pos + 8 <= dv.byteLength) {
      var id = readString(dv, pos, 4);
      var size = dv.getUint32(pos + 4, true);
      var body = pos + 8;
      if (id === "fmt ") {
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bitsPerSample: dv.getUint16(body + 14, true)
        };
        if (fmt.format === 0xfffe && size >= 26) {
          // WAVE_FORMAT_EXTENSIBLE — real format is in the subformat GUID
          fmt.format = dv.getUint16(body + 24, true);
        }
      } else if (id === "data") {
        dataOffset = body;
        dataSize = size;
      } else if (id === "smpl") {
        var nLoops = dv.getUint32(body + 28, true);
        var lp = body + 36;
        for (var l = 0; l < nLoops && lp + 24 <= dv.byteLength; l++) {
          loops.push({ start: dv.getUint32(lp + 8, true), end: dv.getUint32(lp + 12, true) });
          lp += 24;
        }
      }
      pos = body + size + (size & 1); // chunks are word-aligned
    }

    if (!fmt) throw new Error("WAV missing fmt chunk.");
    if (dataOffset < 0) throw new Error("WAV missing data chunk.");

    var bps = fmt.bitsPerSample, ch = fmt.channels;
    var bytesPerSample = bps / 8;
    var frameCount = Math.floor(dataSize / (bytesPerSample * ch));
    var channels = [];
    for (var c = 0; c < ch; c++) channels.push(new Float32Array(frameCount));

    var isFloat = fmt.format === 3;
    for (var f = 0; f < frameCount; f++) {
      for (var c2 = 0; c2 < ch; c2++) {
        var o = dataOffset + (f * ch + c2) * bytesPerSample;
        var v;
        if (isFloat) {
          v = bps === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
        } else if (bps === 8) {
          v = (dv.getUint8(o) - 128) / 128;         // 8-bit PCM is unsigned
        } else if (bps === 16) {
          v = dv.getInt16(o, true) / 32768;
        } else if (bps === 24) {
          var b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
          var i24 = (b2 << 16) | (b1 << 8) | b0;
          if (i24 & 0x800000) i24 |= ~0xffffff; // sign-extend
          v = i24 / 8388608;
        } else if (bps === 32) {
          v = dv.getInt32(o, true) / 2147483648;
        } else {
          throw new Error("Unsupported WAV bit depth: " + bps);
        }
        channels[c2][f] = v;
      }
    }

    return {
      sampleRate: fmt.sampleRate,
      channels: channels,
      frameCount: frameCount,
      bitsPerSample: bps,
      isFloat: isFloat,
      loops: loops
    };
  }

  // Downmix any channel count to a single mono Float32Array (VAG is mono).
  function toMono(parsed) {
    var ch = parsed.channels;
    if (ch.length === 1) return ch[0];
    var n = parsed.frameCount, out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      for (var c = 0; c < ch.length; c++) sum += ch[c][i];
      out[i] = sum / ch.length;
    }
    return out;
  }

  var api = { parse: parse, toMono: toMono };
  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.wav = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
