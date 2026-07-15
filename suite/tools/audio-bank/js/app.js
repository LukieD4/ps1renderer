/* ==========================================================================
   app.js — Audio Bank orchestration.

   Pipeline (semantics doc §10, §13):
     WAV -> mono -> anti-alias resample to target rate -> Int16
         -> SPU-ADPCM encode (best filter/shift per block, decoder feedback)
         -> VAG container.
   The encoded body is decoded back with the exact hardware math so you can
   A/B the PS1 result against the source before exporting.

   Everything runs locally in the browser. No uploads.
   ========================================================================== */
(function () {
  "use strict";
  var P = window.PS1AUDIO;

  // ---- state ----
  var state = {
    fileName: null,
    srcRate: 0,
    srcMono: null,       // Float32 at source rate (for source playback)
    targetRate: 22050,
    quality: "sinc",
    cutoffPct: 90,
    effort: "fast",
    loop: false,
    loopStartFrac: 0,
    name: "",
    // derived
    resampled: null,     // Float32 at target rate
    pcm16: null,         // Int16 at target rate
    encoded: null,       // { body, blocks, ... }
    decodedF32: null,    // Float32 of decoded ADPCM (target rate)
    vagBytes: null
  };

  var audioCtx = null;
  var activeSource = null;

  // ---- element helpers ----
  var $ = function (id) { return document.getElementById(id); };
  var toastEl = $("toast"), toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("is-error", !!isError);
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, 2600);
  }
  function status(msg) { $("transport-status").textContent = msg; }

  // ---- file loading ----
  var dropzone = $("dropzone"), fileInput = $("file-input");
  fileInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("is-dragover"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  function loadFile(file) {
    if (!/\.wav$/i.test(file.name) && file.type.indexOf("wav") === -1) {
      toast("Please choose a .wav file.", true); return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = P.wav.parse(reader.result);
        state.fileName = file.name;
        state.srcRate = parsed.sampleRate;
        state.srcMono = P.wav.toMono(parsed);

        // auto-fill loop start from WAV smpl chunk if present
        if (parsed.loops && parsed.loops.length) {
          state.loopStartFrac = parsed.loops[0].start / parsed.frameCount;
          selectLoop("on");
        }

        var secs = (parsed.frameCount / parsed.sampleRate).toFixed(2);
        $("file-chip").hidden = false;
        $("file-chip-name").textContent = file.name;
        $("file-chip-dims").textContent =
          (parsed.sampleRate / 1000) + "k · " + parsed.bitsPerSample + "b · " +
          parsed.channels.length + "ch · " + secs + "s";
        if (!state.name) $("vag-name").value = deriveName(file.name);
        recompute();
      } catch (err) {
        toast(err.message || "Could not parse WAV.", true);
        status("Load failed");
      }
    };
    reader.onerror = function () { toast("Could not read file.", true); };
    reader.readAsArrayBuffer(file);
  }

  function deriveName(fn) {
    return fn.replace(/\.[^.]+$/, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 15) || "SAMPLE";
  }

  // ---- controls ----
  function bindSegmented(containerId, attr, cb) {
    var c = $(containerId);
    c.addEventListener("click", function (e) {
      var opt = e.target.closest("[data-" + attr + "]");
      if (!opt) return;
      c.querySelectorAll(".segmented__option, .dither-option").forEach(function (o) { o.classList.remove("is-active"); });
      opt.classList.add("is-active");
      cb(opt.getAttribute("data-" + attr));
    });
  }

  bindSegmented("rate-selector", "rate", function (v) { state.targetRate = parseInt(v, 10); recompute(); });
  bindSegmented("resampler-options", "quality", function (v) { state.quality = v; recompute(); });
  bindSegmented("effort-selector", "effort", function (v) { state.effort = v; recompute(); });

  function selectLoop(v) {
    $("loop-options").querySelectorAll(".dither-option").forEach(function (o) {
      o.classList.toggle("is-active", o.getAttribute("data-loop") === v);
    });
    state.loop = v === "on";
    $("loop-start-row").hidden = !state.loop;
  }
  $("loop-options").addEventListener("click", function (e) {
    var opt = e.target.closest("[data-loop]");
    if (!opt) return;
    selectLoop(opt.getAttribute("data-loop"));
    recompute();
  });

  $("cutoff").addEventListener("input", function (e) {
    state.cutoffPct = parseInt(e.target.value, 10);
    $("cutoff-value").textContent = state.cutoffPct + "%";
  });
  $("cutoff").addEventListener("change", recompute);

  $("loop-start").addEventListener("input", function (e) {
    state.loopStartFrac = parseInt(e.target.value, 10) / 100;
    updateLoopStartLabel();
  });
  $("loop-start").addEventListener("change", recompute);

  $("vag-name").addEventListener("input", function (e) { state.name = e.target.value; });

  function updateLoopStartLabel() {
    if (!state.resampled) { $("loop-start-value").textContent = "0"; return; }
    var sample = Math.round(state.loopStartFrac * state.resampled.length);
    var snapped = Math.round(sample / 28) * 28;
    $("loop-start-value").textContent = snapped + " smp";
  }

  // ---- main pipeline ----
  var recomputeTimer = null;
  function recompute() {
    if (!state.srcMono) return;
    clearTimeout(recomputeTimer);
    status("Encoding…");
    // defer so the status paint lands before the (synchronous) encode
    recomputeTimer = setTimeout(runPipeline, 20);
  }

  function runPipeline() {
    var t0 = performance.now();

    // 1. resample with anti-alias low-pass
    var cutoffHz = (state.targetRate / 2) * (state.cutoffPct / 100);
    state.resampled = P.resample.process(state.srcMono, state.srcRate, state.targetRate, {
      quality: state.quality,
      cutoffHz: cutoffHz,
      taps: 24
    });

    // 2. Float -> Int16
    var n = state.resampled.length;
    var pcm = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var v = Math.round(state.resampled[i] * 32767);
      pcm[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
    }
    state.pcm16 = pcm;

    // 3. ADPCM encode
    var loopStartSample = state.loop ? Math.round(state.loopStartFrac * n) : 0;
    state.encoded = P.adpcm.encode(pcm, {
      loop: state.loop,
      loopStart: loopStartSample,
      effort: state.effort
    });

    // 4. decode back for A/B + stats
    state.decodedF32 = int16ToFloat(P.adpcm.decode(state.encoded.body));

    // 5. build VAG
    var nm = state.name || $("vag-name").value || "SAMPLE";
    state.vagBytes = P.vag.build(state.encoded.body, state.targetRate, nm);

    var ms = (performance.now() - t0).toFixed(0);
    render(ms);
    updateLoopStartLabel();
    $("btn-export-vag").disabled = false;
    status("Ready · encoded in " + ms + " ms");
  }

  function int16ToFloat(i16) {
    var f = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    return f;
  }

  // ---- rendering ----
  function render(ms) {
    $("stage-empty").hidden = true;
    $("scope").hidden = false;
    $("scope-src-rate").textContent = (state.srcRate / 1000) + " kHz";
    $("scope-out-rate").textContent = (state.targetRate / 1000) + " kHz";

    drawWave($("wave-source"), state.srcMono, "#8b93a3");
    drawWave($("wave-output"), state.decodedF32, "#5eead4");
    renderStats(ms);
  }

  function drawWave(canvas, data, color) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    // midline
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
    if (!data || !data.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    var step = data.length / W;
    for (var x = 0; x < W; x++) {
      var start = Math.floor(x * step), end = Math.floor((x + 1) * step);
      var min = 1, max = -1;
      for (var j = start; j < end && j < data.length; j++) {
        if (data[j] < min) min = data[j];
        if (data[j] > max) max = data[j];
      }
      if (min > max) { min = max = data[start] || 0; }
      ctx.moveTo(x + 0.5, mid - max * mid * 0.95);
      ctx.lineTo(x + 0.5, mid - min * mid * 0.95);
    }
    ctx.stroke();
  }

  function renderStats(ms) {
    var enc = state.encoded;
    var bodyBytes = enc.body.length;
    var vagBytes = state.vagBytes.length;
    var durS = enc.sampleCount / state.targetRate;

    // SNR: compare decoded vs the Int16 we fed the encoder, over the real region
    var off = P.adpcm.SAMPLES_PER_BLOCK; // skip lead-in
    var se = 0, cnt = 0, sig = 0;
    var dec = state.decodedF32, src = state.pcm16;
    for (var i = 0; i < src.length; i++) {
      var d = (dec[off + i] * 32768) - src[i];
      se += d * d; sig += src[i] * src[i]; cnt++;
    }
    var snr = se > 0 ? 10 * Math.log10(sig / se) : 99;

    var ramBudget = 512000;
    var ramPct = (bodyBytes / ramBudget) * 100;
    var pitch = P.vag.pitchRegister(state.targetRate);

    var ratioSrc = state.srcMono.length * 2; // source mono @16-bit bytes
    var compression = (ratioSrc / bodyBytes).toFixed(1);

    var ramClass = ramPct > 100 ? "stat--danger" : ramPct > 60 ? "stat--warn" : "stat--good";
    var snrClass = snr >= 40 ? "stat--good" : snr >= 25 ? "stat--warn" : "stat--danger";

    var cells = [
      ["VAG size", (vagBytes / 1024).toFixed(1) + " <small>KB</small>", ""],
      ["ADPCM body", (bodyBytes / 1024).toFixed(1) + " <small>KB</small>", ""],
      ["SPU RAM", ramPct.toFixed(1) + "% <small>of 512K</small>", ramClass],
      ["Blocks", enc.blocks.length + " <small>× 16B</small>", ""],
      ["Duration", durS.toFixed(2) + " <small>s</small>", ""],
      ["Pitch reg", "0x" + pitch.toString(16).toUpperCase(), ""],
      ["Est. SNR", snr.toFixed(1) + " <small>dB</small>", snrClass],
      ["Compression", compression + "<small>:1 vs 16-bit</small>", ""]
    ];
    $("stats").innerHTML = cells.map(function (c) {
      return '<div class="stat ' + c[2] + '"><div class="stat__k">' + c[0] +
             '</div><div class="stat__v">' + c[1] + "</div></div>";
    }).join("");
  }

  // ---- A/B playback ----
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function stopPlayback() {
    if (activeSource) { try { activeSource.stop(); } catch (e) {} activeSource = null; }
    document.querySelectorAll(".ab__btn").forEach(function (b) { b.classList.remove("is-playing"); });
  }
  function playBuffer(float32, rate, btn) {
    stopPlayback();
    var ac = ctx();
    if (ac.state === "suspended") ac.resume();
    var buf = ac.createBuffer(1, float32.length, rate);
    buf.getChannelData(0).set(float32);
    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.onended = function () { btn.classList.remove("is-playing"); if (activeSource === src) activeSource = null; };
    src.start();
    activeSource = src;
    btn.classList.add("is-playing");
  }
  $("play-source").addEventListener("click", function () {
    if (state.srcMono) playBuffer(state.srcMono, state.srcRate, this);
  });
  $("play-output").addEventListener("click", function () {
    if (state.decodedF32) playBuffer(state.decodedF32, state.targetRate, this);
  });
  $("play-stop").addEventListener("click", stopPlayback);

  // ---- export ----
  $("btn-export-vag").addEventListener("click", function () {
    if (!state.vagBytes) return;
    var nm = (state.name || $("vag-name").value || "sample").replace(/[^A-Za-z0-9_-]/g, "") || "sample";
    var blob = new Blob([state.vagBytes], { type: "application/octet-stream" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nm + ".vag";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    toast("Exported " + a.download);
  });
})();
