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
    srcMono: null,       // Float32 at source rate (full, untrimmed)
    srcWork: null,       // Float32 source cropped to the trim region
    targetRate: 22050,
    quality: "sinc",
    cutoffPct: 90,
    effort: "fast",
    loop: false,
    loopStartFrac: 0,
    name: "",
    volume: 1.0,
    trimStart: 0,        // seconds, source-relative
    trimEnd: 0,          // seconds, source-relative (0 until a file loads)
    // derived
    resampled: null,     // Float32 at target rate
    pcm16: null,         // Int16 at target rate
    encoded: null,       // { body, blocks, ... }
    decodedF32: null,    // Float32 of decoded ADPCM (target rate)
    vagBytes: null
  };

  var audioCtx = null;
  var configApplied = false; // a .VagConfig preset was loaded
  var pendingPlayhead = null; // playhead (s) from a config, applied on next audio load

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

        // trim region: keep a loaded config's values if they fit, else whole clip
        var fullDur = parsed.frameCount / parsed.sampleRate;
        state.trimStart = Math.max(0, Math.min(state.trimStart || 0, fullDur));
        if (!(state.trimEnd > 0) || state.trimEnd > fullDur) state.trimEnd = fullDur;
        if (state.trimStart >= state.trimEnd) state.trimStart = 0;
        $("trim-start").value = state.trimStart.toFixed(2);
        $("trim-end").value = state.trimEnd.toFixed(2);
        $("trim-start").max = fullDur.toFixed(2);
        $("trim-end").max = fullDur.toFixed(2);

        // auto-fill loop start from WAV smpl chunk (unless a config already set loop)
        if (!configApplied && parsed.loops && parsed.loops.length) {
          state.loopStartFrac = parsed.loops[0].start / parsed.frameCount;
          selectLoop("on");
        }

        var secs = (parsed.frameCount / parsed.sampleRate).toFixed(2);
        $("file-chip").hidden = false;
        $("file-chip-name").textContent = file.name;
        $("file-chip-dims").textContent =
          (parsed.sampleRate / 1000) + "k / " + parsed.bitsPerSample + "b / " +
          parsed.channels.length + "ch / " + secs + "s";
        if (!state.name) $("vag-name").value = deriveName(file.name);
        stopAll();          // reset transport for the new clip
        if (pendingPlayhead != null) { pb.offset = pendingPlayhead; pendingPlayhead = null; }
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

  $("volume").addEventListener("input", function (e) {
    state.volume = parseInt(e.target.value, 10) / 100;
    $("volume-value").textContent = e.target.value + "%";
  });
  $("volume").addEventListener("change", recompute);

  // trim region: source-relative seconds; clamps so start < end within the clip
  function setTrim(which, val) {
    var full = state.srcMono ? state.srcMono.length / state.srcRate : 0;
    if (isNaN(val)) val = which === "start" ? 0 : full;
    if (which === "start") state.trimStart = Math.max(0, Math.min(val, state.trimEnd - 0.01));
    else state.trimEnd = Math.min(full, Math.max(val, state.trimStart + 0.01));
    $("trim-start").value = state.trimStart.toFixed(2);
    $("trim-end").value = state.trimEnd.toFixed(2);
    recompute();
  }
  $("trim-start").addEventListener("change", function (e) { setTrim("start", parseFloat(e.target.value)); });
  $("trim-end").addEventListener("change", function (e) { setTrim("end", parseFloat(e.target.value)); });

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

    // 0. trim the source to [trimStart, trimEnd] (seconds -> samples)
    var full = state.srcMono.length;
    var s0 = Math.max(0, Math.min(Math.floor(state.trimStart * state.srcRate), full));
    var s1 = Math.max(s0 + 1, Math.min(Math.floor(state.trimEnd * state.srcRate), full));
    state.srcWork = state.srcMono.subarray(s0, s1);

    // 1. resample with anti-alias low-pass
    var cutoffHz = (state.targetRate / 2) * (state.cutoffPct / 100);
    state.resampled = P.resample.process(state.srcWork, state.srcRate, state.targetRate, {
      quality: state.quality,
      cutoffHz: cutoffHz,
      taps: 24
    });

    // 2. Float -> Int16
    var n = state.resampled.length;
    var gain = state.volume;
    var pcm = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var v = Math.round(state.resampled[i] * gain * 32767);
      pcm[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v; // hard-limit to 16-bit
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
    status("Ready  encoded in " + ms + " ms");
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

    drawWave($("wave-source"), state.srcWork || state.srcMono, "#8b93a3");
    drawWave($("wave-output"), state.decodedF32, "#5eead4");
    if (state.loop) {
      var lf = state.loopStartFrac || 0;
      drawLoopMarker($("wave-source"), lf);
      drawLoopMarker($("wave-output"), lf);
    }
    renderStats(ms);
    refreshAfterRecompute();
  }

  // amber dashed marker showing where the sample loops back
  function drawLoopMarker(canvas, frac) {
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    var x = Math.round(Math.max(0, Math.min(1, frac)) * W) + 0.5;
    ctx.save();
    ctx.strokeStyle = "rgba(245,158,11,0.85)";
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.restore();
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

    var ratioSrc = (state.srcWork || state.srcMono).length * 2; // trimmed source mono @16-bit bytes
    var compression = (ratioSrc / bodyBytes).toFixed(1);

    // peak level of the baked PCM - flags clipping from the volume gain
    var peak = 0;
    for (var pi = 0; pi < src.length; pi++) { var a = src[pi] < 0 ? -src[pi] : src[pi]; if (a > peak) peak = a; }
    var clipping = peak >= 32767;
    var dbfs = peak > 0 ? 20 * Math.log10(peak / 32768) : -Infinity;

    var ramClass = ramPct > 100 ? "stat--danger" : ramPct > 60 ? "stat--warn" : "stat--good";
    var snrClass = snr >= 40 ? "stat--good" : snr >= 25 ? "stat--warn" : "stat--danger";
    var peakClass = clipping ? "stat--danger" : dbfs > -1 ? "stat--warn" : "";
    var peakVal = clipping ? "CLIP <small>0 dBFS</small>"
      : (dbfs === -Infinity ? "−∞ <small>dBFS</small>" : dbfs.toFixed(1) + " <small>dBFS</small>");

    var cells = [
      ["VAG size", (vagBytes / 1024).toFixed(1) + " <small>KB</small>", ""],
      ["ADPCM body", (bodyBytes / 1024).toFixed(1) + " <small>KB</small>", ""],
      ["SPU RAM", ramPct.toFixed(1) + "% <small>of 512K</small>", ramClass],
      ["Blocks", enc.blocks.length + " <small>× 16B</small>", ""],
      ["Duration", durS.toFixed(2) + " <small>s</small>", ""],
      ["Pitch reg", "0x" + pitch.toString(16).toUpperCase(), ""],
      ["Peak level", peakVal, peakClass],
      ["Est. SNR", snr.toFixed(1) + " <small>dB</small>", snrClass],
      ["Compression", compression + "<small>:1 vs 16-bit</small>", ""]
    ];
    $("stats").innerHTML = cells.map(function (c) {
      return '<div class="stat ' + c[2] + '"><div class="stat__k">' + c[0] +
             '</div><div class="stat__v">' + c[1] + "</div></div>";
    }).join("");
  }

  // ---- player / transport --------------------------------------------
  // One transport drives both scopes. A "monitor" toggle picks which stream
  // you hear (Source vs PS1 decode) and switching keeps the same time
  // position, so you can A/B the ADPCM artifacts at any point. Playheads on
  // both waveforms move together; you can scrub either one.
  var pb = {
    playing: false,
    monitor: "source",  // 'source' | 'output'
    node: null,
    startCtxTime: 0,    // ac.currentTime that maps to offset 0
    offset: 0,          // seconds into the clip while paused
    raf: 0
  };

  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function monitorData() {
    return pb.monitor === "output"
      ? { data: state.decodedF32, rate: state.targetRate }
      : { data: state.srcWork || state.srcMono, rate: state.srcRate };
  }
  function monitorDuration() {
    var m = monitorData();
    return m.data && m.data.length ? m.data.length / m.rate : 0;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    var sec = s - m * 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(2);
  }
  // Playback loop region for the current monitor, driven by the Looping
  // section: one-shot => no region (plays once); looped => repeat the span
  // from the loop-start marker to the end of the clip.
  function loopRegion(dur) {
    if (!state.loop) return { on: false, L0: 0, L1: dur, len: dur };
    var L0 = Math.max(0, Math.min((state.loopStartFrac || 0) * dur, dur));
    var len = dur - L0;
    return { on: len > 0, L0: L0, L1: dur, len: len };
  }
  function actualPos(elapsed, dur) {
    var r = loopRegion(dur);
    if (!r.on) return Math.min(Math.max(0, elapsed), dur);
    if (elapsed < r.L1) return elapsed;           // first pass to the end
    return r.L0 + ((elapsed - r.L1) % r.len);     // then wrap within the loop
  }
  function setPlayIcon(playing) {
    $("player").classList.toggle("is-playing", playing);
    $("play-toggle").querySelector(".ico-play").hidden = playing;
    $("play-toggle").querySelector(".ico-pause").hidden = !playing;
    $("play-toggle").setAttribute("aria-label", playing ? "Pause" : "Play");
  }
  function movePlayheads(frac) {
    frac = Math.max(0, Math.min(1, frac));
    $("playhead-source").hidden = false; $("playhead-source").style.left = (frac * 100) + "%";
    $("playhead-output").hidden = false; $("playhead-output").style.left = (frac * 100) + "%";
  }
  function hidePlayheads() {
    $("playhead-source").hidden = true;
    $("playhead-output").hidden = true;
  }
  function tick() {
    if (!pb.playing) return;
    var dur = monitorDuration();
    var elapsed = audioCtx.currentTime - pb.startCtxTime;
    var pos = actualPos(elapsed, dur);
    movePlayheads(dur ? pos / dur : 0);
    $("time-cur").textContent = fmtTime(pos);
    pb.raf = requestAnimationFrame(tick);
  }
  function startNode(fromSec) {
    var ac = ctx();
    if (ac.state === "suspended") ac.resume();
    var m = monitorData();
    if (!m.data || !m.data.length) return;
    var dur = m.data.length / m.rate;
    fromSec = Math.max(0, Math.min(fromSec || 0, dur));
    var buf = ac.createBuffer(1, m.data.length, m.rate);
    buf.getChannelData(0).set(m.data);
    var node = ac.createBufferSource();
    node.buffer = buf;
    var region = loopRegion(dur);
    if (region.on) { node.loop = true; node.loopStart = region.L0; node.loopEnd = region.L1; }
    else { node.loop = false; }
    node.connect(ac.destination);
    node.onended = function () {
      if (node !== pb.node) return;         // superseded by a newer node
      pb.playing = false; pb.node = null; pb.offset = 0;
      cancelAnimationFrame(pb.raf);
      setPlayIcon(false);
      movePlayheads(0);
      $("time-cur").textContent = fmtTime(0);
    };
    node.start(0, fromSec);
    pb.node = node;
    pb.startCtxTime = ac.currentTime - fromSec;
    pb.playing = true;
    setPlayIcon(true);
    cancelAnimationFrame(pb.raf);
    pb.raf = requestAnimationFrame(tick);
  }
  function stopNode() {                       // internal stop, no state reset
    if (pb.node) { pb.node.onended = null; try { pb.node.stop(); } catch (e) {} pb.node = null; }
    cancelAnimationFrame(pb.raf);
    pb.playing = false;
    setPlayIcon(false);
  }
  function play() { startNode(pb.offset); }
  function pause() {
    if (!pb.node) return;
    var dur = monitorDuration();
    var elapsed = audioCtx.currentTime - pb.startCtxTime;
    pb.offset = actualPos(elapsed, dur);
    stopNode();
    $("time-cur").textContent = fmtTime(pb.offset);
  }
  function togglePlay() {
    if (!state.decodedF32) return;
    if (pb.playing) pause(); else play();
  }
  function stopAll() {
    stopNode();
    pb.offset = 0;
    hidePlayheads();
    $("time-cur").textContent = fmtTime(0);
  }
  function setMonitor(which) {
    if (which === pb.monitor) return;
    $("monitor").querySelectorAll(".segmented__option").forEach(function (o) {
      o.classList.toggle("is-active", o.getAttribute("data-monitor") === which);
    });
    var wasPlaying = pb.playing;
    if (pb.playing) pause();                  // captures current offset
    pb.monitor = which;
    var dur = monitorDuration();
    pb.offset = Math.min(pb.offset, dur);
    $("time-tot").textContent = fmtTime(dur);
    if (wasPlaying) play();
    else if (pb.offset > 0) { movePlayheads(dur ? pb.offset / dur : 0); $("time-cur").textContent = fmtTime(pb.offset); }
  }
  // rebind the player after a re-encode; keeps time position and playback
  function refreshAfterRecompute() {
    var dur = monitorDuration();
    $("time-tot").textContent = fmtTime(dur);
    pb.offset = Math.min(pb.offset, dur);
    if (pb.playing) {
      var elapsed = audioCtx.currentTime - pb.startCtxTime;
      var cur = actualPos(elapsed, dur);
      stopNode();
      startNode(cur);
    } else if (pb.offset > 0) {
      movePlayheads(dur ? pb.offset / dur : 0);
      $("time-cur").textContent = fmtTime(pb.offset);
    } else {
      hidePlayheads();
      $("time-cur").textContent = fmtTime(0);
    }
  }

  // controls
  $("play-toggle").addEventListener("click", togglePlay);
  $("play-stop").addEventListener("click", stopAll);
  $("monitor").addEventListener("click", function (e) {
    var o = e.target.closest("[data-monitor]");
    if (o) setMonitor(o.getAttribute("data-monitor"));
  });

  // scrub either waveform to seek
  function bindScrub(wrapId) {
    var el = $(wrapId), dragging = false, wasPlaying = false;
    function fracFromEvent(ev) {
      var r = el.getBoundingClientRect();
      var cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      return Math.max(0, Math.min(1, (cx - r.left) / r.width));
    }
    function apply(f) {
      var dur = monitorDuration();
      pb.offset = f * dur;
      movePlayheads(f);
      $("time-cur").textContent = fmtTime(pb.offset);
    }
    el.addEventListener("mousedown", function (ev) {
      if (!state.decodedF32) return;
      ev.preventDefault();
      dragging = true; wasPlaying = pb.playing;
      if (pb.playing) pause();
      apply(fracFromEvent(ev));
    });
    window.addEventListener("mousemove", function (ev) { if (dragging) apply(fracFromEvent(ev)); });
    window.addEventListener("mouseup", function () {
      if (!dragging) return; dragging = false;
      if (wasPlaying) play();
    });
    el.addEventListener("touchstart", function (ev) {
      if (!state.decodedF32) return;
      ev.preventDefault(); dragging = true; wasPlaying = pb.playing;
      if (pb.playing) pause(); apply(fracFromEvent(ev));
    }, { passive: false });
    el.addEventListener("touchmove", function (ev) { if (dragging) { ev.preventDefault(); apply(fracFromEvent(ev)); } }, { passive: false });
    el.addEventListener("touchend", function () { if (dragging) { dragging = false; if (wasPlaying) play(); } });
  }
  bindScrub("wrap-source");
  bindScrub("wrap-output");

  // spacebar toggles play/pause (unless typing in a field)
  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space" && e.key !== " ") return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (!state.decodedF32) return;
    e.preventDefault();
    togglePlay();
  });

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

  // ---- save / load .VagConfig (all params; audio is dropped separately) ----
  function currentConfig() {
    return {
      format: "VagConfig",
      version: 2,
      targetRate: state.targetRate,
      quality: state.quality,
      cutoffPct: state.cutoffPct,
      effort: state.effort,
      loop: state.loop,
      loopStartFrac: state.loopStartFrac,
      name: state.name || $("vag-name").value || "",
      volume: state.volume,
      trimStart: state.trimStart,
      trimEnd: state.trimEnd,
      monitor: pb.monitor,
      playhead: pb.offset,
      sourceFileName: state.fileName || null
    };
  }
  $("btn-save-config").addEventListener("click", function () {
    var cfg = currentConfig();
    var nm = (cfg.name || "audio").replace(/[^A-Za-z0-9_-]/g, "") || "audio";
    var blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nm + ".VagConfig";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    toast("Saved " + a.download);
  });

  function setSegActive(containerId, attr, value) {
    $(containerId).querySelectorAll(".segmented__option, .dither-option").forEach(function (o) {
      o.classList.toggle("is-active", o.getAttribute("data-" + attr) === String(value));
    });
  }
  function applyConfig(cfg) {
    if (!cfg || cfg.format !== "VagConfig") throw new Error("Not a .VagConfig file.");
    configApplied = true;
    if (cfg.monitor === "source" || cfg.monitor === "output") {
      pb.monitor = cfg.monitor;
      setSegActive("monitor", "monitor", pb.monitor);
    }
    pendingPlayhead = (typeof cfg.playhead === "number") ? cfg.playhead : null;
    if (cfg.targetRate) { state.targetRate = cfg.targetRate | 0; setSegActive("rate-selector", "rate", state.targetRate); }
    if (cfg.quality) { state.quality = cfg.quality; setSegActive("resampler-options", "quality", state.quality); }
    if (typeof cfg.cutoffPct === "number") { state.cutoffPct = cfg.cutoffPct; $("cutoff").value = cfg.cutoffPct; $("cutoff-value").textContent = cfg.cutoffPct + "%"; }
    if (cfg.effort) { state.effort = cfg.effort; setSegActive("effort-selector", "effort", state.effort); }
    state.loopStartFrac = typeof cfg.loopStartFrac === "number" ? cfg.loopStartFrac : 0;
    selectLoop(cfg.loop ? "on" : "off");
    $("loop-start").value = Math.round(state.loopStartFrac * 100);
    updateLoopStartLabel();
    if (typeof cfg.volume === "number") { state.volume = cfg.volume; $("volume").value = Math.round(cfg.volume * 100); $("volume-value").textContent = Math.round(cfg.volume * 100) + "%"; }
    if (typeof cfg.name === "string") { state.name = cfg.name; $("vag-name").value = cfg.name; }
    if (typeof cfg.trimStart === "number") state.trimStart = cfg.trimStart;
    if (typeof cfg.trimEnd === "number") state.trimEnd = cfg.trimEnd;
    if (state.srcMono) {
      // audio already loaded: clamp trim to it and re-encode now
      var fullDur = state.srcMono.length / state.srcRate;
      state.trimStart = Math.max(0, Math.min(state.trimStart, fullDur));
      if (!(state.trimEnd > 0) || state.trimEnd > fullDur) state.trimEnd = fullDur;
      if (state.trimStart >= state.trimEnd) state.trimStart = 0;
      $("trim-start").value = state.trimStart.toFixed(2);
      $("trim-end").value = state.trimEnd.toFixed(2);
      if (pendingPlayhead != null) { pb.offset = pendingPlayhead; pendingPlayhead = null; }
      recompute();
    } else {
      $("trim-start").value = (state.trimStart || 0).toFixed(2);
      $("trim-end").value = (state.trimEnd || 0).toFixed(2);
    }
  }
  $("btn-load-config").addEventListener("click", function () { $("load-config-input").click(); });
  $("load-config-input").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        applyConfig(JSON.parse(reader.result));
        toast(state.srcMono ? "Config applied" : "Config loaded — now drop your .wav");
      } catch (err) { toast(err.message || "Could not read config.", true); }
    };
    reader.onerror = function () { toast("Could not read config.", true); };
    reader.readAsText(file);
    e.target.value = ""; // allow re-loading the same file
  });
})();
