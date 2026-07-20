/* ==========================================================================
   app.js — OST Studio wiring (Milestone 2).

   Ties together: the SPU engine, the multi-track Song model, the piano-roll
   canvas, the transport scheduler, MIDI-file import + song save/load, and
   live audition/recording from the computer keyboard and a MIDI piano.

   Two views share the left-rail instrument editor and the engine:
     - Arrange : the DAW — track list + piano roll + transport.
     - Live    : the Milestone-1 instrument tester (piano + waveform + meter).
   The left rail always edits the "active" instrument (selected track in
   Arrange, the live demo in Live).
   ========================================================================== */
(function () {
  "use strict";

  var P = window.PS1AUDIO;
  var engine = new P.SpuEngine();
  var S = P.song;

  var NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  function noteName(m) { return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  function isBlack(m) { var s = ((m % 12) + 12) % 12; return s === 1 || s === 3 || s === 6 || s === 8 || s === 10; }
  var $ = function (id) { return document.getElementById(id); };

  // ---- Toast -------------------------------------------------------------
  var toastEl = $("toast"), toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg; toastEl.classList.toggle("is-error", !!isErr);
    toastEl.classList.add("is-visible"); clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, 2600);
  }

  // ---- State -------------------------------------------------------------
  var song = S.makeSong();
  var selectedId = song.tracks[0].id;
  var globalScope = false;   // true = no focused track: roll edits span ALL tracks
  var view = "arrange";
  var liveInstrument = null;

  // ---- Undo / redo ---------------------------------------------------------
  // Snapshots store the song JSON plus live instrument object refs by track
  // index, so undo/redo never has to re-decode ADPCM.
  var undoStack = [], redoStack = [], HISTORY_MAX = 100;
  function snapshot() {
    return { json: S.toJSON(song), insts: song.tracks.map(function (t) { return t.instrument; }),
             selIdx: song.tracks.findIndex(function (t) { return t.id === selectedId; }) };
  }
  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function applySnapshot(s) {
    var ns = S.fromJSON(s.json);
    ns.tracks.forEach(function (t, i) { t.instrument = s.insts[i] || null; delete t.instrumentData; });
    song = ns;
    song.tracks.forEach(function (t) { if (!t.instrument) t.instrument = buildDemoInstrument("Demo saw"); });
    var idx = Math.max(0, Math.min(song.tracks.length - 1, s.selIdx));
    selectedId = song.tracks[idx].id;
    $("bpm-input").value = song.bpm;
    syncSongName();
    engine.instrument = selectedTrack().instrument;
    updateLoopButton();
    roll.selected = null; roll.selectedNotes = [];
    renderTracks(); refreshInstrumentControls(); refreshTrackControls(); roll.draw();
  }
  function undo() { if (!undoStack.length) { toast("Nothing to undo"); return; } redoStack.push(snapshot()); applySnapshot(undoStack.pop()); }
  function redo() { if (!redoStack.length) { toast("Nothing to redo"); return; } undoStack.push(snapshot()); applySnapshot(redoStack.pop()); }
  window.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
    var k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  function selectedTrack() { for (var i = 0; i < song.tracks.length; i++) if (song.tracks[i].id === selectedId) return song.tracks[i]; return song.tracks[0]; }
  function activeInstrument() { return view === "live" ? liveInstrument : (selectedTrack() && selectedTrack().instrument); }

  // ---- Demo instrument (fresh copy per track) ----------------------------
  function buildDemoInstrument(name) {
    var spc = 168, cycles = 64, n = spc * cycles, rate = 44100;
    var pcm = new Int16Array(n);
    for (var i = 0; i < n; i++) pcm[i] = Math.round((((i % spc) / spc) * 2 - 1) * 0.4 * 32767);
    var enc = P.adpcm.encode(pcm, { effort: "fast", loop: true, loopStart: 0 });
    var loop = P.vag.findLoop(enc.body);
    return engine.buildInstrumentFromAdpcm(enc.body, rate, loop, { centerNote: 60, name: name || "Demo saw" });
  }

  // ---- Voice meter -------------------------------------------------------
  var slotEls = [];
  (function () { var w = $("voice-slots"); for (var i = 0; i < P.MAX_VOICES; i++) { var d = document.createElement("div"); d.className = "vslot"; w.appendChild(d); slotEls.push(d); } })();
  engine.onVoices = function (active, peak) {
    for (var i = 0; i < slotEls.length; i++) { slotEls[i].classList.remove("is-on", "is-warn"); if (i < active) slotEls[i].classList.add(active >= P.MAX_VOICES ? "is-warn" : "is-on"); }
    $("voice-count").textContent = active; $("voice-peak").textContent = peak; $("voice-count-mini").textContent = active;
  };

  // ---- Live-view piano (Milestone 1) -------------------------------------
  var keyEls = {}, activeNotes = {};
  (function buildPiano() {
    var piano = $("piano"), LO = 48, HI = 84, whites = [];
    for (var m = LO; m <= HI; m++) if (!isBlack(m)) whites.push(m);
    var ww = 100 / whites.length;
    whites.forEach(function (m) { var k = document.createElement("div"); k.className = "pkey pkey--white"; k.dataset.note = m; if (m % 12 === 0) { var l = document.createElement("span"); l.className = "pkey__lbl"; l.textContent = noteName(m); k.appendChild(l); } piano.appendChild(k); keyEls[m] = k; });
    for (var b = LO; b <= HI; b++) { if (!isBlack(b)) continue; var pw = 0; for (var w = LO; w < b; w++) if (!isBlack(w)) pw++; var k2 = document.createElement("div"); k2.className = "pkey pkey--black"; k2.dataset.note = b; k2.style.left = (pw * ww) + "%"; k2.style.width = (ww * 0.62) + "%"; piano.appendChild(k2); keyEls[b] = k2; }
    var pn = null;
    function noteFromEvt(e) { var t = e.target.closest ? e.target.closest(".pkey") : null; return t ? parseInt(t.dataset.note, 10) : null; }
    piano.addEventListener("pointerdown", function (e) { var n = noteFromEvt(e); if (n == null) return; pn = n; pressNote(n, 0.9); piano.setPointerCapture(e.pointerId); e.preventDefault(); });
    piano.addEventListener("pointerup", function () { if (pn != null) { releaseNote(pn); pn = null; } });
    piano.addEventListener("pointercancel", function () { if (pn != null) { releaseNote(pn); pn = null; } });
  })();

  function highlight(n, on) { var el = keyEls[n]; if (el) el.classList.toggle("is-on", on); }

  // ---- Note in/out (audition + record) -----------------------------------
  function pressNote(note, vel) {
    engine.resume();
    engine.noteOn(note, vel);
    transport.recordNoteOn(note);
    if (view === "live") { activeNotes[note] = (activeNotes[note] || 0) + 1; if (activeNotes[note] === 1) highlight(note, true); $("now-note").innerHTML = "Playing <b>" + noteName(note) + "</b> (MIDI " + note + ")"; }
  }
  function releaseNote(note) {
    engine.noteOff(note);
    transport.recordNoteOff(note);
    if (view === "live") { if (activeNotes[note]) { activeNotes[note]--; if (activeNotes[note] <= 0) { delete activeNotes[note]; highlight(note, false); } } }
  }
  function previewNote(pitch) { engine.resume(); engine.noteOn(pitch, 0.85); setTimeout(function () { engine.noteOff(pitch); }, 260); }
  // Scrub audition: fire short notes whose starts were crossed by the playhead.
  function scrubAudition(a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi - lo < 1) return;
    var now = engine.now(), count = 0;
    for (var t = 0; t < song.tracks.length; t++) {
      var tr = song.tracks[t];
      if (!P.scheduler.isAudible(song, tr)) continue;
      for (var i = 0; i < tr.notes.length; i++) {
        var n = tr.notes[i];
        if (n.start >= lo && n.start < hi) {
          if (++count > 8) return;
          engine.scheduleNote(tr.instrument, n.pitch + (tr.transpose || 0), n.vel * (tr.volume != null ? tr.volume : 1) * 0.9, now, now + 0.18);
        }
      }
    }
  }

  // ---- Piano roll --------------------------------------------------------
  var roll = new P.PianoRoll($("roll-canvas"), {
    getSong: function () { return song; },
    getSelectedTrack: function () { return globalScope ? null : selectedTrack(); },
    onEdit: pushHistory,
    onChange: function () { renderTracks(); },
    onLoopChange: function () { updateLoopButton(); },
    onSeek: function (t) { transport.seek(t); updatePos(t); },
    onScrub: function (a, b) { scrubAudition(a, b); },
    onPreview: previewNote
  });
  roll.setSnap(song.ppq); // 1/4 default

  // ---- Transport ---------------------------------------------------------
  var transport = new P.Transport(engine, {
    getSong: function () { return song; },
    getSelectedTrack: selectedTrack,
    onEdit: pushHistory,
    onTick: function (t) { roll.setPlayhead(t); updatePos(t); },
    onStateChange: function (playing, rec) {
      var pb = $("btn-play");
      pb.classList.toggle("is-playing", playing);
      pb.querySelector(".ico-play").hidden = playing; pb.querySelector(".ico-stop").hidden = !playing;
    },
    onRecord: function () { roll.draw(); renderTracks(); }
  });

  function updatePos(tick) {
    var barT = song.ppq * 4, bar = Math.floor(tick / barT) + 1, beat = Math.floor((tick % barT) / song.ppq) + 1;
    $("pos-readout").textContent = bar + " : " + beat;
  }

  // ---- Track list --------------------------------------------------------
  function renderTracks() {
    var host = $("tracklist"); host.innerHTML = "";
    song.tracks.forEach(function (tr) {
      var row = document.createElement("div");
      row.className = "trackrow" + (!globalScope && tr.id === selectedId ? " is-sel" : "");
      row.style.borderLeftColor = tr.color;
      var instName = tr.instrument ? tr.instrument.meta.name : "no instrument";
      var opts = "", found = false;
      library.forEach(function (item) {
        var sel = item.inst === tr.instrument; if (sel) found = true;
        opts += '<option value="' + item.id + '"' + (sel ? " selected" : "") + '>' + escapeHtml(item.inst.meta.name) + '</option>';
      });
      if (!found) opts = '<option value="cur" selected>' + escapeHtml(instName) + '</option>' + opts;
      row.innerHTML =
        '<div class="trackrow__top">' +
          '<input class="trackrow__name" value="' + escapeHtml(tr.name) + '" />' +
          '<span class="tbadge' + (tr.mute ? " is-on" : "") + '" data-k="m" title="Mute">M</span>' +
          '<span class="tbadge' + (tr.solo ? " is-on" : "") + '" data-k="s" title="Solo">S</span>' +
          '<span class="tbadge tbadge--del" data-k="x" title="Delete track">×</span>' +
        '</div>' +
        '<div class="trackrow__row2">' +
          '<select class="trackrow__inst-select" title="Swap instrument (from library)">' + opts + '</select>' +
          '<span class="trackrow__notes">' + tr.notes.length + ' n</span>' +
        '</div>';
      row.addEventListener("pointerdown", function (e) { if (e.target.closest(".tbadge") || e.target.tagName === "SELECT" || e.target.classList.contains("trackrow__name")) return; selectTrack(tr.id); });
      row.querySelector(".trackrow__inst-select").addEventListener("change", function () {
        var val = this.value, item = null;
        for (var k = 0; k < library.length; k++) if (String(library[k].id) === val) item = library[k];
        if (item) { tr.instrument = item.inst; if (tr.id === selectedId) { engine.instrument = item.inst; refreshInstrumentControls(); } renderTracks(); renderLibrary(); }
      });
      row.querySelector(".trackrow__name").addEventListener("input", function () { tr.name = this.value; if (tr.id === selectedId) { $("inst-target").textContent = "— " + tr.name; $("track-target").textContent = tr.name; } });
      row.querySelector('[data-k="m"]').addEventListener("click", function (e) { e.stopPropagation(); tr.mute = !tr.mute; renderTracks(); });
      row.querySelector('[data-k="s"]').addEventListener("click", function (e) { e.stopPropagation(); tr.solo = !tr.solo; renderTracks(); });
      row.querySelector('[data-k="x"]').addEventListener("click", function (e) { e.stopPropagation(); deleteTrack(tr.id); });
      host.appendChild(row);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function selectTrack(id) {
    globalScope = false;
    selectedId = id;
    if (view === "arrange") engine.instrument = selectedTrack().instrument;
    $("inst-target").textContent = "— " + selectedTrack().name;
    refreshInstrumentControls(); refreshTrackControls();
    renderTracks(); renderLibrary(); roll.selected = null; roll.selectedNotes = []; roll.draw();
  }
  function deleteTrack(id) {
    if (song.tracks.length <= 1) { toast("Keep at least one track", true); return; }
    pushHistory();
    var i = song.tracks.findIndex(function (t) { return t.id === id; });
    song.tracks.splice(i, 1);
    if (selectedId === id) selectedId = song.tracks[Math.max(0, i - 1)].id;
    selectTrack(selectedId);
  }
  // Click the empty space below the track rows to leave track focus: the
  // piano roll then shows every track bright and box-select / Ctrl-A / move /
  // delete operate across ALL tracks. Click any track row to focus again.
  $("tracklist").addEventListener("pointerdown", function (e) {
    if (e.target !== this) return; // row clicks are handled by the rows
    if (globalScope) return;
    globalScope = true;
    roll.selected = null; roll.selectedNotes = [];
    renderTracks(); roll.draw();
    toast("All-track scope - box-select spans every track; click a track to focus it again");
  });

  $("btn-add-track").addEventListener("click", function () {
    pushHistory();
    var tr = S.makeTrack("Track " + (song.tracks.length + 1), song.tracks.length);
    tr.instrument = buildDemoInstrument("Demo saw");
    song.tracks.push(tr); selectTrack(tr.id);
  });

  // ---- Instrument controls (bind to active instrument) -------------------
  var centerInput = $("center-note");
  function syncCenterName() { $("center-note-name").textContent = noteName(parseInt(centerInput.value, 10) || 0); }
  function readADSR() { return { attack: (+$("adsr-attack").value || 0) / 1000, decay: (+$("adsr-decay").value || 0) / 1000, sustain: (+$("adsr-sustain").value || 0) / 100, release: (+$("adsr-release").value || 0) / 1000 }; }
  function adsrLabels() { $("atk-value").textContent = $("adsr-attack").value + " ms"; $("dec-value").textContent = $("adsr-decay").value + " ms"; $("sus-value").textContent = $("adsr-sustain").value + "%"; $("rel-value").textContent = $("adsr-release").value + " ms"; }

  centerInput.addEventListener("input", function () { var v = Math.max(0, Math.min(127, parseInt(centerInput.value, 10) || 0)); var inst = activeInstrument(); if (inst) { inst.centerNote = v; engine.applyLiveParams(inst); } syncCenterName(); });
  ["adsr-attack","adsr-decay","adsr-sustain","adsr-release"].forEach(function (id) { $(id).addEventListener("input", function () { var inst = activeInstrument(); if (inst) inst.adsr = readADSR(); adsrLabels(); }); });
  $("pan").addEventListener("input", function () { var p = (+this.value || 0) / 100; var inst = activeInstrument(); if (inst) { inst.pan = p; engine.applyLiveParams(inst); } $("pan-value").textContent = p === 0 ? "C" : (p < 0 ? "L" + Math.round(-p * 100) : "R" + Math.round(p * 100)); });

  var loopMode = "on";
  // Auto loop: skip the attack (~20% in) and end before the trailing silence,
  // so a held note plays the attack once then repeats a steady sustain region.
  function autoTrimLoop(inst) {
    var d = inst.buffer.getChannelData(0), n = d.length, thr = 0.015;
    var end = n; for (var i = n - 1; i >= 0; i--) { if (Math.abs(d[i]) > thr) { end = i + 1; break; } }
    var onset = 0; for (var j = 0; j < end; j++) { if (Math.abs(d[j]) > thr) { onset = j; break; } }
    var start = onset + Math.floor((end - onset) * 0.2);
    start = Math.round(start / 28) * 28; end = Math.round(end / 28) * 28;
    if (end <= start) end = start + 28;
    inst.loop.start = Math.max(0, Math.min(n - 28, start));
    inst.loop.end = Math.min(n, end);
    inst.loop.enabled = true;
  }
  function setLoopSlidersFrom(inst) {
    var n = inst.buffer.length || 1;
    $("loop-start").value = Math.round(inst.loop.start / n * 1000);
    $("loop-end").value = Math.round(inst.loop.end / n * 1000);
    $("loopstart-value").textContent = Math.round(inst.loop.start / n * 100) + "%";
    $("loopend-value").textContent = Math.round(inst.loop.end / n * 100) + "%";
  }
  function applyLoopFromSliders(inst) {
    var n = inst.buffer.length;
    var s = Math.round((+$("loop-start").value / 1000) * n / 28) * 28;
    var e = Math.round((+$("loop-end").value / 1000) * n / 28) * 28;
    if (e <= s) e = s + 28;
    inst.loop.start = Math.max(0, Math.min(n - 28, s));
    inst.loop.end = Math.min(n, e);
    $("loopstart-value").textContent = Math.round(inst.loop.start / n * 100) + "%";
    $("loopend-value").textContent = Math.round(inst.loop.end / n * 100) + "%";
  }
  $("loop-options").addEventListener("click", function (e) {
    var opt = e.target.closest(".dither-option"); if (!opt) return;
    Array.prototype.forEach.call(this.children, function (c) { c.classList.remove("is-active"); });
    opt.classList.add("is-active"); loopMode = opt.dataset.loop;
    var inst = activeInstrument();
    if (inst) {
      inst.loop.enabled = loopMode === "on";
      if (loopMode === "on") {
        var n = inst.buffer.length;
        if (!(inst.loop.end > inst.loop.start) || (inst.loop.start === 0 && inst.loop.end >= n)) autoTrimLoop(inst);
        setLoopSlidersFrom(inst);
      }
      engine.applyLiveParams(inst); drawSample();
    }
    $("loop-region").hidden = loopMode !== "on";
    refreshStats();
  });
  $("loop-start").addEventListener("input", function () { var i = activeInstrument(); if (i) { applyLoopFromSliders(i); engine.applyLiveParams(i); drawSample(); } });
  $("loop-end").addEventListener("input", function () { var i = activeInstrument(); if (i) { applyLoopFromSliders(i); engine.applyLiveParams(i); drawSample(); } });
  $("btn-trim-loop").addEventListener("click", function () { var i = activeInstrument(); if (!i) return; autoTrimLoop(i); setLoopSlidersFrom(i); engine.applyLiveParams(i); drawSample(); refreshStats(); toast("Loop set to the sustain region"); });

  // Fine tune + tone-shaping (per instrument)
  $("detune").addEventListener("input", function () { var i = activeInstrument(); if (i) { i.detune = +this.value || 0; engine.applyLiveParams(i); } $("detune-value").textContent = (this.value > 0 ? "+" : "") + this.value + " ¢"; });
  $("cutoff").addEventListener("input", function () { var c = +this.value || 20000; var i = activeInstrument(); if (i) { i.cutoff = c; engine.applyLiveParams(i); } $("cutoff-value").textContent = c >= 20000 ? "off" : (c >= 1000 ? (c / 1000).toFixed(1) + "k" : c + " Hz"); });
  $("resonance").addEventListener("input", function () { var q = (+this.value || 7) / 10; var i = activeInstrument(); if (i) { i.resonance = q; engine.applyLiveParams(i); } $("reso-value").textContent = q.toFixed(1); });
  $("reverb-send").addEventListener("input", function () { var s = (+this.value || 0) / 100; var i = activeInstrument(); if (i) { i.reverbSend = s; engine.applyLiveParams(i); } $("reverb-value").textContent = this.value + "%"; });
  $("glide").addEventListener("input", function () { var g = (+this.value || 0) / 1000; var i = activeInstrument(); if (i) i.glide = g; $("glide-value").textContent = this.value + " ms"; });

  // Track params (per track)
  $("track-volume").addEventListener("input", function () { var t = selectedTrack(); if (t) t.volume = (+this.value || 0) / 100; $("tvol-value").textContent = this.value + "%"; });
  $("track-transpose").addEventListener("input", function () { var v = Math.max(-48, Math.min(48, parseInt(this.value, 10) || 0)); var t = selectedTrack(); if (t) t.transpose = v; $("track-transpose-oct").textContent = (v > 0 ? "+" : "") + v; });
  function refreshTrackControls() {
    var t = selectedTrack(); if (!t) return;
    $("track-target").textContent = t.name;
    $("track-volume").value = Math.round((t.volume != null ? t.volume : 1) * 100); $("tvol-value").textContent = $("track-volume").value + "%";
    $("track-transpose").value = t.transpose || 0; $("track-transpose-oct").textContent = ((t.transpose || 0) > 0 ? "+" : "") + (t.transpose || 0);
  }

  function refreshInstrumentControls() {
    var inst = activeInstrument(); if (!inst) return;
    centerInput.value = inst.centerNote; syncCenterName();
    $("adsr-attack").value = Math.round(inst.adsr.attack * 1000);
    $("adsr-decay").value = Math.round(inst.adsr.decay * 1000);
    $("adsr-sustain").value = Math.round(inst.adsr.sustain * 100);
    $("adsr-release").value = Math.round(inst.adsr.release * 1000);
    adsrLabels();
    $("pan").value = Math.round(inst.pan * 100); $("pan").dispatchEvent(new Event("input"));
    loopMode = inst.loop.enabled ? "on" : "off";
    Array.prototype.forEach.call($("loop-options").children, function (c) { c.classList.toggle("is-active", c.dataset.loop === loopMode); });
    $("loop-region").hidden = loopMode !== "on";
    setLoopSlidersFrom(inst);
    $("detune").value = inst.detune || 0;
    $("cutoff").value = inst.cutoff != null ? inst.cutoff : 20000;
    $("resonance").value = Math.round((inst.resonance != null ? inst.resonance : 0.7) * 10);
    $("reverb-send").value = Math.round((inst.reverbSend || 0) * 100);
    $("glide").value = Math.round((inst.glide || 0) * 1000);
    ["detune","cutoff","resonance","reverb-send","glide"].forEach(function (id) { $(id).dispatchEvent(new Event("input")); });
    refreshStats(); drawSample();
  }
  function refreshStats() {
    var inst = activeInstrument(); if (!inst) return;
    $("stat-rate").textContent = (inst.sampleRate / 1000).toFixed(1) + "k";
    $("stat-len").textContent = inst.meta.seconds.toFixed(2) + "s";
    $("stat-loop").textContent = inst.loop.enabled ? "on" : "off";
    $("sample-name").textContent = inst.meta.name;
    var tt = document.getElementById("tone-target"); if (tt) tt.textContent = "— " + inst.meta.name;
  }

  function drawSample() {
    var cv = $("sample-canvas"), ctx = cv.getContext("2d"); var w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, w, h);
    var inst = activeInstrument(); if (!inst) return;
    var data = inst.buffer.getChannelData(0), n = data.length, mid = h / 2;
    ctx.strokeStyle = "#232834"; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    ctx.strokeStyle = "#5eead4"; ctx.beginPath();
    for (var x = 0; x < w; x++) { var i0 = Math.floor(x / w * n), i1 = Math.floor((x + 1) / w * n), mn = 1, mx = -1; for (var i = i0; i < i1 && i < n; i++) { var v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; } ctx.moveTo(x + 0.5, mid - mx * mid * 0.95); ctx.lineTo(x + 0.5, mid - mn * mid * 0.95); }
    ctx.stroke();
    if (inst.loop.enabled) { var ls = inst.loop.start / n * w, le = inst.loop.end / n * w; ctx.fillStyle = "rgba(245,158,11,0.10)"; ctx.fillRect(ls, 0, le - ls, h); }
  }

  // ---- Sample library ----------------------------------------------------
  var library = [], libId = 1;
  function addToLibrary(inst, tag) {
    library.push({ id: libId++, inst: inst, tag: tag || "" });
    renderLibrary(); renderTracks();
  }
  function removeFromLibrary(id) { library = library.filter(function (i) { return i.id !== id; }); renderLibrary(); renderTracks(); }
  function renderLibrary() {
    var box = $("sample-lib"), list = $("sample-lib-list");
    box.hidden = library.length === 0; list.innerHTML = "";
    library.forEach(function (item) {
      var el = document.createElement("div");
      el.className = "libitem" + (activeInstrument() === item.inst ? " is-active" : "");
      el.innerHTML = '<span class="libitem__name">' + escapeHtml(item.inst.meta.name) + '</span>' +
                     '<span class="libitem__tag">' + item.tag + '</span>' +
                     '<span class="libitem__del" title="Remove from library">×</span>';
      el.addEventListener("click", function (e) {
        if (e.target.classList.contains("libitem__del")) { e.stopPropagation(); removeFromLibrary(item.id); return; }
        assignInstrument(item.inst);
      });
      list.appendChild(el);
    });
  }

  // ---- Instrument file loading -------------------------------------------
  function instOptsFromUI(name) { return { centerNote: parseInt(centerInput.value, 10) || 60, adsr: readADSR(), pan: (+$("pan").value || 0) / 100, name: name }; }
  function assignInstrument(inst) {
    if (view === "live") { liveInstrument = inst; engine.instrument = inst; }
    else { selectedTrack().instrument = inst; engine.instrument = inst; }
    refreshInstrumentControls(); renderTracks(); renderLibrary();
  }

  function loadVAG(arrayBuffer, fileName, done) {
    var v = P.vag.parse(arrayBuffer);
    var inst = engine.buildInstrumentFromAdpcm(v.body, v.sampleRate, v.loop, instOptsFromUI(v.name || fileName));
    done(inst, "VAG");
    toast("Loaded VAG: " + (v.name || fileName) + (v.loop.enabled ? " (looped)" : " (one-shot)"));
  }
  function handleInstrumentFile(file, assign) {
    var name = file.name || "sample";
    if (!/\.vag$/i.test(name)) { toast("Only .VAG samples are accepted - convert audio with the audio-vag tool first", true); return; }
    var r = new FileReader();
    r.onload = function () {
      try {
        var done = function (inst, tag) { addToLibrary(inst, tag); if (assign) assignInstrument(inst); };
        loadVAG(r.result, name, done);
      } catch (e) { toast("Load failed: " + e.message, true); }
    };
    r.readAsArrayBuffer(file);
  }
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    files.forEach(function (f, i) { handleInstrumentFile(f, i === files.length - 1); });
  }
  var dz = $("dropzone"), fi = $("file-input");
  fi.addEventListener("change", function () { if (fi.files.length) handleFiles(fi.files); fi.value = ""; });
  ["dragenter","dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("is-dragover"); }); });
  ["dragleave","drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("is-dragover"); }); });
  dz.addEventListener("drop", function (e) { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  // ---- Song name (editable chip in the transport bar) ---------------------
  var nameEl = $("file-chip-name");
  function sanitizeName(s) { return String(s || "").replace(/[\\/:*?"<>|\n\r]/g, "").trim().slice(0, 60) || "song"; }
  function syncSongName() { if (nameEl.textContent !== (song.name || "song")) nameEl.textContent = song.name || "song"; }
  nameEl.addEventListener("input", function () { song.name = sanitizeName(nameEl.textContent); });
  nameEl.addEventListener("blur", function () { song.name = sanitizeName(nameEl.textContent); syncSongName(); });
  nameEl.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); } });

  // ---- MIDI file import + song save/load ---------------------------------

  // Rebuild a live engine instrument from the serialized form in a save file.
  function instrumentFromData(d) {
    var body = S.b64decode(d.adpcm);
    var inst = engine.buildInstrumentFromAdpcm(body, d.sampleRate || 22050, d.loop, {
      centerNote: d.centerNote, adsr: d.adsr, pan: d.pan, gain: d.gain, detune: d.detune,
      cutoff: d.cutoff, resonance: d.resonance, reverbSend: d.reverbSend, glide: d.glide,
      name: d.name || "Sample"
    });
    if (d.loop) inst.loop = { enabled: !!d.loop.enabled, start: d.loop.start | 0, end: d.loop.end | 0 };
    return inst;
  }

  function loadSongObject(newSong, label) {
    song = newSong;
    song.tracks.forEach(function (t) {
      if (!t.instrument && t.instrumentData) {
        try { t.instrument = instrumentFromData(t.instrumentData); addToLibrary(t.instrument, "SAVE"); }
        catch (e) { /* corrupt data -> demo fallback below */ }
        delete t.instrumentData;
      }
      if (!t.instrument) t.instrument = buildDemoInstrument("Demo saw");
    });
    undoStack.length = 0; redoStack.length = 0;
    selectedId = song.tracks[0].id;
    $("bpm-input").value = song.bpm;
    syncSongName();
    roll.setSnap(currentSnapTicks());
    engine.instrument = selectedTrack().instrument;
    updateLoopButton();
    roll.selected = null; roll.selectedNotes = [];
    roll._change(true); // auto-fit sheet + loop to content (fixes stale saves)
    renderTracks(); refreshInstrumentControls(); refreshTrackControls(); roll.scrollX = 0; roll.draw();
    updatePos(0);
    toast(label);
  }
  $("btn-import-midi").addEventListener("click", function () { $("midi-file-input").click(); });
  $("midi-file-input").addEventListener("change", function () {
    var f = this.files[0]; if (!f) return; var r = new FileReader();
    r.onload = function () { try { var s = S.parseSMF(r.result); loadSongObject(s, "Imported " + f.name + " — " + s.tracks.length + " track(s), " + s.bpm + " BPM"); } catch (e) { toast("MIDI import failed: " + e.message, true); } };
    r.readAsArrayBuffer(f); this.value = "";
  });
  $("btn-export-midi").addEventListener("click", function () {
    try {
      var notes = song.tracks.reduce(function (n, t) { return n + t.notes.length; }, 0);
      if (!notes) { toast("Nothing to export - add some notes first", true); return; }
      var mid = S.buildSMF(song);
      var fname = sanitizeName(song.name) + ".mid";
      saveWithPicker(fname, mid, "Standard MIDI file", ".mid", "audio/midi")
        .then(function (ok) { if (ok) toast("Exported " + fname + " (" + mid.length + " B)"); })
        .catch(function (err) { toast("MIDI export failed: " + err.message, true); });
    } catch (err) { toast("MIDI export failed: " + err.message, true); }
  });
  function download(name, text, type) { var b = new Blob([text], { type: type || "application/json" }); var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); }

  // Save through the File System Access API where available: it lets us set
  // the "Save as type" filter to just the wanted extension, and (for export)
  // present the .vab and .seq dialogs strictly ONE AT A TIME — firing two
  // <a download> clicks back-to-back is what confused Explorer on Windows.
  // Returns false if the user cancelled the dialog.
  function saveWithPicker(name, data, desc, ext, mime) {
    if (!window.showSaveFilePicker) {
      download(name, data, mime); // fallback: classic download
      return Promise.resolve(true);
    }
    var accept = {}; accept[mime] = [ext];
    return window.showSaveFilePicker({ suggestedName: name, types: [{ description: desc, accept: accept }] })
      .then(function (h) { return h.createWritable(); })
      .then(function (w) { return w.write(data).then(function () { return w.close(); }); })
      .then(function () { return true; })
      .catch(function (err) { if (err && err.name === "AbortError") return false; throw err; });
  }

  $("btn-save-song").addEventListener("click", function () {
    var fname = sanitizeName(song.name) + ".OstSong";
    saveWithPicker(fname, S.toJSON(song), "OST Studio song", ".OstSong", "application/json")
      .then(function (ok) { if (ok) toast("Saved " + fname); })
      .catch(function (e) { toast("Save failed: " + e.message, true); });
  });

  $("btn-export").addEventListener("click", function () {
    try {
      var notes = song.tracks.reduce(function (a, t) { return a + t.notes.length; }, 0);
      if (!notes) { toast("Nothing to export — add some notes first", true); return; }
      var base = sanitizeName(song.name);
      var vab = P.seqvab.buildVAB(song);
      var seq = P.seqvab.buildSEQ(song);
      // strictly sequential: the .seq dialog only opens once the .vab one closed
      saveWithPicker(base + ".vab", vab, "PS1 VAB instrument bank", ".vab", "application/octet-stream")
        .then(function (ok) {
          if (!ok) { toast("Export cancelled"); return; }
          return saveWithPicker(base + ".seq", seq, "PS1 SEQ score", ".seq", "application/octet-stream");
        })
        .then(function (ok) {
          if (ok === true) toast("Exported " + base + ".vab (" + (vab.length / 1024 | 0) + "KB) + " + base + ".seq (" + seq.length + "B)");
          else if (ok === false) toast("Export: .seq skipped");
        })
        .catch(function (e) { toast("Export failed: " + e.message, true); });
    } catch (e) { toast("Export failed: " + e.message, true); }
  });

  // Delivery size cap: prompt to compress (downsample) if the exported WAV
  // would land over this. 9.5MB, not the full 10MB, to leave headroom.
  var WAV_SIZE_PROMPT_BYTES = 9.5 * 1024 * 1024;
  var WAV_SIZE_HARD_CAP_BYTES = 10 * 1024 * 1024;

  $("btn-export-wav").addEventListener("click", function () {
    var notes = song.tracks.reduce(function (a, t) { return a + t.notes.length; }, 0);
    if (!notes) { toast("Nothing to export — add some notes first", true); return; }
    var btn = this; btn.disabled = true;
    var base = sanitizeName(song.name);
    toast("Rendering " + base + ".wav…");
    engine.renderOffline(song, P.scheduler, { secPerTick: S.secPerTick })
      .then(function (buffer) {
        // Bandaid trim: this song never loops, so lop a hardcoded 2s off the
        // exported WAV's tail. Encoding-only — doesn't touch note/ADSR timing.
        var trimmed = P.wav.trimEndSeconds(buffer, 2.0);
        var finalBuffer = trimmed;
        var compressed = false;

        var estBytes = P.wav.estimateBytes(trimmed);
        if (estBytes > WAV_SIZE_PROMPT_BYTES) {
          var mb = (estBytes / 1024 / 1024).toFixed(1);
          var wantsCompress = window.confirm(
            base + ".wav is ~" + mb + "MB, over your specified 9.5MB limit.\n\n" +
            "Compress it (downsample sample rate, then mono if needed) to fit under 10MB?\n\n" +
            "OK = compress and export smaller file\nCancel = export the full-size WAV anyway"
          );
          if (wantsCompress) {
            var shrunk = P.wav.shrinkToFit(trimmed, WAV_SIZE_HARD_CAP_BYTES - 64 * 1024); // small safety margin
            finalBuffer = shrunk.buffer;
            compressed = shrunk.steps.length > 0;
            if (!compressed) toast("Couldn't shrink further — exporting as-is", true);
          }
        }

        var wavBytes = P.wav.encode(finalBuffer);
        return saveWithPicker(base + ".wav", wavBytes, "WAV audio", ".wav", "audio/wav")
          .then(function (ok) {
            if (!ok) { toast("Export cancelled"); return; }
            var sizeMsg = (wavBytes.length / 1024 / 1024).toFixed(1) + "MB";
            if (compressed) {
              toast("Exported " + base + ".wav (" + sizeMsg + ", compressed to " + finalBuffer.sampleRate + "Hz"
                + (finalBuffer.numberOfChannels === 1 ? "/mono" : "") + ")");
            } else {
              toast("Exported " + base + ".wav (" + sizeMsg + ")");
            }
          });
      })
      .catch(function (e) { toast("WAV export failed: " + e.message, true); })
      .then(function () { btn.disabled = false; });
  });

  $("btn-load-song").addEventListener("click", function () { $("song-file-input").click(); });
  $("song-file-input").addEventListener("change", function () { var f = this.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { try { loadSongObject(S.fromJSON(r.result), "Loaded " + f.name); } catch (e) { toast("Load failed: " + e.message, true); } }; r.readAsText(f); this.value = ""; });

  // ---- Transport controls -----------------------------------------------
  function togglePlay() { if (transport.playing) transport.stop(); else transport.play(); }
  $("btn-play").addEventListener("click", togglePlay);
  $("btn-record").addEventListener("click", function () { var on = !transport.recording; transport.setRecording(on, currentSnapTicks()); this.classList.toggle("is-armed", on); toast(on ? "Recording armed — press play" : "Recording off"); });

  // ---- Stamp tool ---------------------------------------------------------
  // Like FL Studio's stamp: pick a pattern from the dropdown, toggle Stamp
  // on, then click the roll to drop the whole pattern at once instead of a
  // single note.
  roll.setStampPattern($("stamp-pattern").value);
  $("btn-stamp").addEventListener("click", function () {
    var on = !roll.stampMode;
    roll.setStampMode(on);
    this.classList.toggle("is-active", on);
    toast(on ? "Stamp armed — click the roll to place a pattern" : "Stamp off");
  });
  $("stamp-pattern").addEventListener("change", function () { roll.setStampPattern(this.value); });
  window.addEventListener("keydown", function (e) {
    if (e.code !== "KeyS" || !e.shiftKey) return;
    var t = e.target, tag = t && t.tagName;
    var typing = tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable) ||
                 (tag === "INPUT" && (t.type === "text" || t.type === "number"));
    if (typing) return;
    $("btn-stamp").click();
  });
  $("bpm-input").addEventListener("input", function () { var b = Math.max(20, Math.min(300, parseInt(this.value, 10) || 120)); song.bpm = b; });
  function currentSnapTicks() { var v = parseInt($("snap-select").value, 10); return v === 0 ? 1 : (song.ppq * 4) / v; }
  $("snap-select").addEventListener("change", function () { roll.setSnap(currentSnapTicks()); });
  function updateLoopButton() { $("btn-loop").classList.toggle("is-active", song.loop.enabled); }
  $("btn-loop").addEventListener("click", function (e) {
    if (e.ctrlKey) { // Ctrl+click: forget the painted region, back to auto
      song.loop.user = false;
      song.loop.enabled = true;
    } else {
      song.loop.enabled = !song.loop.enabled;
    }
    if (song.loop.enabled && !song.loop.user) {
      // auto region: start of sheet -> end of CONTENT (rounded up to a
      // beat); it keeps tracking the content as notes are added/removed
      var ce = roll.contentEnd();
      song.loop.start = 0;
      song.loop.end = Math.max(song.ppq, Math.ceil(ce / song.ppq) * song.ppq);
      toast("Looping to the end of content - shift-drag the ruler to pin your own region");
    }
    updateLoopButton(); roll.draw();
  });
  $("btn-to-start").addEventListener("click", function () { transport.seek(0); roll.setPlayhead(0); roll.scrollX = 0; roll.draw(); updatePos(0); });
  $("btn-to-end").addEventListener("click", function () { var t = song.lengthTicks; transport.seek(t); roll.setPlayhead(t); updatePos(t); });
  $("btn-zoom-in").addEventListener("click", function () { roll.zoom(1.25); });
  $("btn-zoom-out").addEventListener("click", function () { roll.zoom(0.8); });

  // ---- Master / panic ----------------------------------------------------
  $("master-gain").addEventListener("input", function () { engine.setMasterGain((+this.value || 0) / 100); });
  $("btn-panic").addEventListener("click", function () { if (transport.playing) transport.stop(); engine.panic(); for (var n in activeNotes) highlight(n | 0, false); activeNotes = {}; toast("All voices stopped"); });

  // ---- Keyboard + MIDI input ---------------------------------------------
  var kbd = new P.input.KeyboardInput({ noteOn: pressNote, noteOff: releaseNote, octave: function (o) { $("kbd-octave").textContent = o; } });
  var midi = new P.input.MidiInput({
    noteOn: pressNote, noteOff: releaseNote,
    devices: function (list) { var sel = $("midi-select"); if (!list.length) { sel.hidden = true; return; } sel.hidden = false; sel.innerHTML = '<option value="all">All devices</option>' + list.map(function (d) { return '<option value="' + d.id + '">' + d.name + '</option>'; }).join(""); }
  });
  $("btn-midi").addEventListener("click", function () {
    if (!midi.supported) { setMidiStatus("err", "Web MIDI unsupported"); toast("This browser has no Web MIDI. Use Chrome/Edge.", true); return; }
    midi.init().then(function (list) { setMidiStatus("on", list.length ? (list.length + " device" + (list.length > 1 ? "s" : "")) : "No devices found"); toast(list.length ? "MIDI connected" : "MIDI ready — plug in a keyboard"); })
      .catch(function (err) { setMidiStatus("err", "Denied"); toast("MIDI: " + err.message, true); });
  });
  $("midi-select").addEventListener("change", function () { midi.listen(this.value); });
  function setMidiStatus(state, text) { var box = $("midi-status"); box.classList.remove("is-on", "is-err"); if (state === "on") box.classList.add("is-on"); if (state === "err") box.classList.add("is-err"); $("midi-status-text").textContent = text; }

  // Space bar = GLOBAL play/stop. Capture phase + preventDefault, so a
  // button or slider still holding focus from a previous click can never
  // swallow the key (its own space-activation would fire later, in the
  // default action we cancel); focus is blurred to unstick the control.
  // The only exceptions are places where space IS typing: text/number
  // inputs, the song-name chip, and <select> dropdowns.
  window.addEventListener("keydown", function (e) {
    if (e.code !== "Space") return;
    var t = e.target, tag = t && t.tagName;
    var typing = tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable) ||
                 (tag === "INPUT" && (t.type === "text" || t.type === "number"));
    if (typing) return;
    e.preventDefault();
    e.stopPropagation();
    if (t && t.blur && tag !== "BODY") t.blur();
    togglePlay();
  }, true);

  // ---- View switching ----------------------------------------------------
  $("viewswitch").addEventListener("click", function (e) {
    var opt = e.target.closest(".segmented__option"); if (!opt) return;
    Array.prototype.forEach.call(this.children, function (c) { c.classList.remove("is-active"); });
    opt.classList.add("is-active");
    view = opt.dataset.view;
    document.body.setAttribute("data-view", view);
    $("view-arrange").hidden = view !== "arrange";
    $("view-live").hidden = view !== "live";
    $("inst-target").textContent = view === "live" ? "— live" : "— " + selectedTrack().name;
    engine.instrument = activeInstrument();
    refreshInstrumentControls(); refreshTrackControls(); renderLibrary();
    if (view === "arrange") { roll.resize(); }
  });
  window.addEventListener("resize", function () { if (view === "arrange") roll.resize(); });

  // ---- Init --------------------------------------------------------------
  liveInstrument = buildDemoInstrument("Demo saw (built-in)");
  song.tracks[0].instrument = buildDemoInstrument("Demo saw");
  engine.instrument = song.tracks[0].instrument;
  $("inst-target").textContent = "— " + song.tracks[0].name;
  syncSongName();
  adsrLabels(); syncCenterName(); refreshInstrumentControls(); refreshTrackControls();
  renderTracks(); updatePos(0); updateLoopButton();
  engine.onVoices(0, 0);
  // ensure the roll lays out once the arrange view has real dimensions
  requestAnimationFrame(function () { roll.resize(); });
  window.addEventListener("pointerdown", function once() { engine.resume(); window.removeEventListener("pointerdown", once); }, { once: true });
})();
