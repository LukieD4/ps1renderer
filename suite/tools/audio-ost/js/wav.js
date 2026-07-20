/* ==========================================================================
   wav.js — minimal AudioBuffer -> WAV (PCM16) encoder.

   Takes the AudioBuffer produced by SpuEngine.renderOffline() and packs it
   into a standard 44-byte-header RIFF/WAVE file, interleaved, 16-bit signed
   PCM. This is a plain listening/reference mixdown (not a console asset —
   the PS1 export is the .vab/.seq pair from seqvab.js).

   Exposes window.PS1AUDIO.wav.encode(audioBuffer) -> Uint8Array
   ========================================================================== */
(function (root) {
  "use strict";

  function floatTo16(sample) {
    var s = Math.max(-1, Math.min(1, sample));
    return s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // audioBuffer: Web Audio AudioBuffer (1+ channels, any sample rate).
  function encode(audioBuffer) {
    var numChannels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var numFrames = audioBuffer.length;
    var bytesPerSample = 2;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = numFrames * blockAlign;

    var buf = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buf);

    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);              // PCM fmt chunk size
    view.setUint16(20, 1, true);                // audio format = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true); // bits per sample
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    var channels = [];
    for (var c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));

    var offset = 44;
    for (var i = 0; i < numFrames; i++) {
      for (var ch = 0; ch < numChannels; ch++) {
        view.setInt16(offset, floatTo16(channels[ch][i]), true);
        offset += 2;
      }
    }

    return new Uint8Array(buf);
  }

  // Encoding-side-only trim: lops a fixed number of seconds off the END of
  // the rendered buffer before it's written to bytes. This does NOT touch
  // note scheduling, ADSR, or anything in spu.js/scheduler.js — it's a
  // bandaid on the exported file only, for a song known to never loop and
  // whose real content already ends well before this cut. If seconds >=
  // the buffer's own length it keeps at least 1 frame rather than erroring.
  function trimEndSeconds(audioBuffer, seconds) {
    if (!seconds || seconds <= 0) return audioBuffer;
    var cutFrames = Math.floor(seconds * audioBuffer.sampleRate);
    var newLength = Math.max(1, audioBuffer.length - cutFrames);
    if (newLength >= audioBuffer.length) return audioBuffer;
    return {
      numberOfChannels: audioBuffer.numberOfChannels,
      sampleRate: audioBuffer.sampleRate,
      length: newLength,
      getChannelData: function (c) { return audioBuffer.getChannelData(c).subarray(0, newLength); }
    };
  }

  // ---- Size-reduction helpers (delivery-size compression) ----------------
  // Pure-JS, dependency-free "compression": these shrink the PCM data itself
  // (lower sample rate and/or fold to mono) rather than applying a lossy
  // codec — the output is still a plain WAV, just a smaller one. Used only
  // when the encoded file is over the delivery cap; never applied silently.

  // Linear-interpolation resample of one channel to a new sample rate.
  // Not console-accurate (nothing here needs to be — this only runs on the
  // already-rendered mixdown, post-export, for file-size purposes).
  function resampleChannel(data, fromRate, toRate) {
    if (fromRate === toRate) return data;
    var ratio = fromRate / toRate;
    var newLen = Math.max(1, Math.round(data.length / ratio));
    var out = new Float32Array(newLen);
    for (var i = 0; i < newLen; i++) {
      var srcPos = i * ratio;
      var i0 = Math.floor(srcPos);
      var i1 = Math.min(data.length - 1, i0 + 1);
      var frac = srcPos - i0;
      out[i] = data[i0] + (data[i1] - data[i0]) * frac;
    }
    return out;
  }

  // Returns a new buffer-like object at `targetRate`, optionally folded to
  // mono (averaging channels). Does not mutate the input.
  function downsample(audioBuffer, targetRate, toMono) {
    var srcChannels = [];
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) srcChannels.push(audioBuffer.getChannelData(c));

    var workingChannels = srcChannels;
    var numChannels = audioBuffer.numberOfChannels;
    if (toMono && numChannels > 1) {
      var mono = new Float32Array(srcChannels[0].length);
      for (var i = 0; i < mono.length; i++) {
        var sum = 0;
        for (var c2 = 0; c2 < numChannels; c2++) sum += srcChannels[c2][i];
        mono[i] = sum / numChannels;
      }
      workingChannels = [mono];
      numChannels = 1;
    }

    var resampled = workingChannels.map(function (ch) { return resampleChannel(ch, audioBuffer.sampleRate, targetRate); });
    var length = resampled[0].length;
    return {
      numberOfChannels: numChannels,
      sampleRate: targetRate,
      length: length,
      getChannelData: function (c) { return resampled[c]; }
    };
  }

  // Estimates encoded WAV byte size without actually encoding (44-byte
  // header + 16-bit PCM data).
  function estimateBytes(audioBuffer) {
    return 44 + audioBuffer.length * audioBuffer.numberOfChannels * 2;
  }

  // Repeatedly halves sample rate (down to a floor), then folds to mono if
  // still over budget, until under maxBytes or out of steps. Returns
  // { buffer, sampleRate, mono, steps } — `steps` is a human-readable log of
  // what was applied, for the toast/confirmation message.
  function shrinkToFit(audioBuffer, maxBytes) {
    var current = audioBuffer;
    var steps = [];
    var MIN_RATE = 11025; // below this it stops being useful as a mixdown reference

    while (estimateBytes(current) > maxBytes && current.sampleRate > MIN_RATE) {
      var nextRate = Math.max(MIN_RATE, Math.round(current.sampleRate / 2));
      current = downsample(current, nextRate, false);
      steps.push(current.sampleRate + "Hz");
    }
    if (estimateBytes(current) > maxBytes && current.numberOfChannels > 1) {
      current = downsample(current, current.sampleRate, true);
      steps.push("mono");
    }
    return { buffer: current, steps: steps };
  }

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.wav = {
    encode: encode,
    trimEndSeconds: trimEndSeconds,
    downsample: downsample,
    estimateBytes: estimateBytes,
    shrinkToFit: shrinkToFit
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PS1AUDIO.wav;
})(typeof window !== "undefined" ? window : globalThis);
