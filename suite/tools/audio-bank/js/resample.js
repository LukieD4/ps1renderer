/* ==========================================================================
   resample.js — sample-rate conversion + anti-alias low-pass.

   Semantics doc §10 calls this out as the single most important pre-process:
   "downsample with a windowed-sinc low-pass at the new Nyquist BEFORE ADPCM.
   ADPCM prediction badly amplifies aliased high-frequency energy."

   Two qualities:
     linear — fast, low quality (aliases; use only for previews).
     sinc   — windowed-sinc (Blackman) polyphase-style kernel with an
              adjustable low-pass cutoff. This is the recommended path.

   Also exposes a standalone low-pass for gentle pre-emphasis at the same rate.
   Browser: window.PS1AUDIO.resample ; Node: module.exports.
   ========================================================================== */
(function (root) {
  "use strict";

  function sinc(x) { return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); }
  function blackman(n, N) {
    var a = 2 * Math.PI * n / (N - 1);
    return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
  }

  function resampleLinear(input, srcRate, dstRate) {
    if (srcRate === dstRate) return input.slice();
    var ratio = srcRate / dstRate;
    var outLen = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos), frac = pos - i0;
      var a = input[i0] || 0, b = input[i0 + 1] || 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  // Windowed-sinc resampler. cutoffHz defaults to just under the lower
  // Nyquist of the two rates; `taps` controls kernel width (quality/cost).
  function resampleSinc(input, srcRate, dstRate, opts) {
    opts = opts || {};
    var taps = opts.taps || 24;
    var ratio = srcRate / dstRate;
    var nyq = Math.min(srcRate, dstRate) / 2;
    var cutoff = Math.min(opts.cutoffHz || nyq * 0.9, srcRate / 2 - 1);
    var fc = cutoff / srcRate; // normalised cutoff in cycles/sample (source domain)

    var outLen = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(outLen);
    var half = taps; // taps on each side
    var N = 2 * half + 1;

    for (var i = 0; i < outLen; i++) {
      var center = i * ratio;
      var i0 = Math.floor(center);
      var acc = 0, wsum = 0;
      for (var k = -half; k <= half; k++) {
        var idx = i0 + k;
        if (idx < 0 || idx >= input.length) continue;
        var t = center - idx;                 // distance in source samples
        var w = blackman(k + half, N);
        var h = 2 * fc * sinc(2 * fc * t);     // low-pass sinc at cutoff fc
        var coeff = w * h;
        acc += input[idx] * coeff;
        wsum += coeff;
      }
      out[i] = wsum !== 0 ? acc / wsum : 0;
    }
    return out;
  }

  // Standalone gentle low-pass at the SAME rate (pre-emphasis, §10 item 3).
  function lowPass(input, rate, cutoffHz, taps) {
    taps = taps || 16;
    var fc = Math.min(cutoffHz, rate / 2 - 1) / rate;
    var half = taps, N = 2 * half + 1;
    var kernel = new Float32Array(N), ksum = 0;
    for (var k = -half; k <= half; k++) {
      var w = blackman(k + half, N);
      var h = 2 * fc * sinc(2 * fc * k);
      kernel[k + half] = w * h;
      ksum += kernel[k + half];
    }
    for (var j = 0; j < N; j++) kernel[j] /= ksum;
    var out = new Float32Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var acc = 0;
      for (var kk = -half; kk <= half; kk++) {
        var idx = i + kk;
        if (idx < 0 || idx >= input.length) continue;
        acc += input[idx] * kernel[kk + half];
      }
      out[i] = acc;
    }
    return out;
  }

  // High-level entry: resample (with anti-alias) then optional pre-emphasis.
  function process(input, srcRate, dstRate, opts) {
    opts = opts || {};
    var out;
    if (opts.quality === "linear") {
      out = resampleLinear(input, srcRate, dstRate);
    } else {
      out = resampleSinc(input, srcRate, dstRate, {
        taps: opts.taps || 24,
        cutoffHz: opts.cutoffHz
      });
    }
    if (opts.preEmphasisHz && opts.preEmphasisHz < dstRate / 2) {
      out = lowPass(out, dstRate, opts.preEmphasisHz, 16);
    }
    return out;
  }

  var api = {
    process: process,
    resampleLinear: resampleLinear,
    resampleSinc: resampleSinc,
    lowPass: lowPass
  };
  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.resample = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
