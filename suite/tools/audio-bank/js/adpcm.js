/* ==========================================================================
   adpcm.js — SPU-ADPCM encoder + decoder for the PS1 Audio Bank tool.

   Implements the exact encode algorithm from PS1AUDIO_SEMANTICS.txt
   (sections 1-4), mirroring psxavenc / libpsxav:

     - 5 prediction filters (1/64 fixed point).
     - Brute-force filter x shift search with DECODER-ACCURATE feedback:
       prediction is threaded through the whole sample using the encoder's
       own reconstructed output, so it never drifts from the hardware decoder.
     - 16-byte blocks, each holding 28 samples, two 4-bit nibbles per byte,
       EARLIER sample in the LOW nibble.

   The decoder here is bit-exact with the encoder's internal reconstruction,
   so it doubles as the in-browser playback + verification oracle.

   Runs in the browser (window.PS1AUDIO.adpcm) and under Node (module.exports).
   ========================================================================== */
(function (root) {
  "use strict";

  // §2 — the five prediction filters (integers over 64). SPU uses all 5.
  var POS = [0, 60, 115, 98, 122];
  var NEG = [0, 0, -52, -55, -60];

  var SAMPLES_PER_BLOCK = 28;
  var BLOCK_BYTES = 16;

  // Flag byte (§1) composite values.
  var FLAG_NONE = 0x00;             // normal block, continue
  var FLAG_LOOP_START = 0x04;       // copy addr into repeat-address reg
  var FLAG_LOOP_END_SUSTAIN = 0x03; // loop end, jump back and sustain
  var FLAG_TERMINATOR = 0x07;       // one-shot terminator (self-loops silence)

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp16(v) { return v < -32768 ? -32768 : v > 32767 ? 32767 : v; }
  function sext4(n) { n &= 0x0f; return n >= 8 ? n - 16 : n; }

  // find_min_shift — estimate the smallest shift whose residuals fit the
  // 4-bit range. Propagates prev with the ORIGINAL samples (fast estimate).
  function findMinShift(prev1, prev2, block, filter) {
    var k1 = POS[filter], k2 = NEG[filter];
    var sMin = 0, sMax = 0, p1 = prev1, p2 = prev2;
    for (var i = 0; i < SAMPLES_PER_BLOCK; i++) {
      var s = block[i];
      var pred = (k1 * p1 + k2 * p2 + 32) >> 6;
      var res = s - pred;
      if (res < sMin) sMin = res;
      if (res > sMax) sMax = res;
      p2 = p1; p1 = s;
    }
    var rightShift = 0;
    // nibble range -8..7 -> 0x7FFF>>12 = 7, -0x8000>>12 = -8
    while (rightShift < 12 &&
           ((sMax >> rightShift) > (0x7fff >> 12) ||
            (sMin >> rightShift) < (-0x8000 >> 12))) {
      rightShift++;
    }
    return clamp(12 - rightShift, 0, 12);
  }

  // attempt_to_encode — for one (filter, shift), simulate the decoder using
  // its own quantized output as feedback. Does NOT commit running state.
  function attemptEncode(prev1, prev2, block, filter, shift) {
    var k1 = POS[filter], k2 = NEG[filter];
    var p1 = prev1, p2 = prev2;
    var nibbles = new Int8Array(SAMPLES_PER_BLOCK);
    var mse = 0;
    for (var i = 0; i < SAMPLES_PER_BLOCK; i++) {
      var s = block[i];
      var pred = (k1 * p1 + k2 * p2 + 32) >> 6;
      var residual = s - pred;
      // quantize to a 4-bit nibble with rounding, clamp to -8..7
      var n = clamp(((residual << shift) + (1 << 11)) >> 12, -8, 7);
      // reconstruct EXACTLY as the hardware decoder would (§3)
      var reconSample = (n << 12) >> shift; // == n * 2^(12-shift)
      var out = clamp16(reconSample + pred);
      var err = out - s;
      mse += err * err;
      nibbles[i] = n;
      p2 = p1; p1 = out; // feedback uses the RECONSTRUCTED sample
    }
    return { mse: mse, nibbles: nibbles, prev1: p1, prev2: p2 };
  }

  // encodeBlock — pick the best (filter, shift). effort "fast" tests +/-1
  // around the estimate; "exhaustive" tests all valid shifts.
  function encodeBlock(state, block, filter0, filter1, effort) {
    var best = null, bestFilter = 0, bestShift = 0;
    for (var f = filter0; f <= filter1; f++) {
      var est = findMinShift(state.prev1, state.prev2, block, f);
      var lo, hi;
      if (effort === "exhaustive") { lo = 0; hi = 12; }
      else { lo = clamp(est - 1, 0, 12); hi = clamp(est + 1, 0, 12); }
      for (var sh = lo; sh <= hi; sh++) {
        var r = attemptEncode(state.prev1, state.prev2, block, f, sh);
        if (best === null || r.mse < best.mse) { best = r; bestFilter = f; bestShift = sh; }
      }
    }
    state.prev1 = best.prev1;
    state.prev2 = best.prev2;
    return { filter: bestFilter, shift: bestShift, nibbles: best.nibbles, mse: best.mse };
  }

  function writeBlock(out, offset, header, flag, nibbles) {
    out[offset] = header & 0xff;
    out[offset + 1] = flag & 0xff;
    for (var i = 0; i < SAMPLES_PER_BLOCK; i += 2) {
      var lo = nibbles ? nibbles[i] & 0x0f : 0;
      var hi = nibbles ? nibbles[i + 1] & 0x0f : 0;
      out[offset + 2 + (i >> 1)] = lo | (hi << 4);
    }
  }

  // encode — pcm is an Int16Array (mono). Options:
  //   { loop, loopStart (sampleIndex), xa (4 filters), effort }
  function encode(pcm, options) {
    options = options || {};
    var effort = options.effort || "fast";
    var filter1 = options.xa ? 3 : 4; // XA: filters 0-3, SPU: 0-4
    var loop = !!options.loop;

    var padded = pcm.length % SAMPLES_PER_BLOCK === 0
      ? pcm.length
      : pcm.length + (SAMPLES_PER_BLOCK - (pcm.length % SAMPLES_PER_BLOCK));
    var realBlocks = padded / SAMPLES_PER_BLOCK;

    var totalBlocks = 1 + realBlocks + (loop ? 0 : 1);
    var body = new Uint8Array(totalBlocks * BLOCK_BYTES);

    // §5 — silent lead-in block inits the decoder and kills the startup click
    writeBlock(body, 0, 0x00, FLAG_NONE, null);

    var loopStartBlock = loop
      ? clamp(Math.round((options.loopStart || 0) / SAMPLES_PER_BLOCK), 0, realBlocks - 1)
      : -1;

    var state = { prev1: 0, prev2: 0 };
    var blocks = [], totalMse = 0;
    var tmp = new Int16Array(SAMPLES_PER_BLOCK);

    for (var b = 0; b < realBlocks; b++) {
      for (var i = 0; i < SAMPLES_PER_BLOCK; i++) {
        var idx = b * SAMPLES_PER_BLOCK + i;
        tmp[i] = idx < pcm.length ? pcm[idx] : 0;
      }
      var enc = encodeBlock(state, tmp, 0, filter1, effort);
      totalMse += enc.mse;

      var flag = FLAG_NONE;
      if (loop) {
        if (b === loopStartBlock) flag = FLAG_LOOP_START;
        if (b === realBlocks - 1) flag = FLAG_LOOP_END_SUSTAIN;
      }
      var header = (enc.shift & 0x0f) | (enc.filter << 4);
      writeBlock(body, (1 + b) * BLOCK_BYTES, header, flag, enc.nibbles);
      blocks.push({ filter: enc.filter, shift: enc.shift, flag: flag });
    }

    // §5 — one-shot samples MUST end with a dummy terminator block
    if (!loop) {
      writeBlock(body, (1 + realBlocks) * BLOCK_BYTES, 0x00, FLAG_TERMINATOR, null);
    }

    return {
      body: body,
      blocks: blocks,
      mse: totalMse,
      rms: Math.sqrt(totalMse / (realBlocks * SAMPLES_PER_BLOCK || 1)),
      sampleCount: realBlocks * SAMPLES_PER_BLOCK,
      leadInBlock: true,
      terminator: !loop
    };
  }

  // decode — bit-exact hardware decode. Returns Int16Array of all samples.
  // Linear decode (ignores loop flags) — what we want for A/B + verification.
  function decode(body) {
    var nBlocks = Math.floor(body.length / BLOCK_BYTES);
    var out = new Int16Array(nBlocks * SAMPLES_PER_BLOCK);
    var s1 = 0, s2 = 0, w = 0;
    for (var b = 0; b < nBlocks; b++) {
      var base = b * BLOCK_BYTES;
      var header = body[base];
      var shift = header & 0x0f;
      var filter = (header >> 4) & 0x0f;
      if (filter > 4) filter = 0;   // guard malformed
      if (shift > 12) shift = 12;   // shift 13-15 => silence special case
      var k1 = POS[filter], k2 = NEG[filter];
      for (var i = 0; i < SAMPLES_PER_BLOCK; i++) {
        var byte = body[base + 2 + (i >> 1)];
        var nib = (i & 1) === 0 ? (byte & 0x0f) : (byte >> 4) & 0x0f;
        var d = sext4(nib);
        var sample = d << (12 - shift);
        var pred = (k1 * s1 + k2 * s2 + 32) >> 6;
        var o = clamp16(sample + pred);
        out[w++] = o;
        s2 = s1; s1 = o;
      }
    }
    return out;
  }

  var api = {
    POS: POS, NEG: NEG,
    SAMPLES_PER_BLOCK: SAMPLES_PER_BLOCK, BLOCK_BYTES: BLOCK_BYTES,
    encode: encode, decode: decode, encodeBlock: encodeBlock, findMinShift: findMinShift
  };

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.adpcm = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
