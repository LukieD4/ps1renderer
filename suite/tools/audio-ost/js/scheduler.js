/* ==========================================================================
   scheduler.js — the transport. A Web Audio lookahead scheduler that turns a
   Song's ticks into precisely-timed engine.scheduleNote() calls, drives the
   playhead, loops, and records live input into the selected track.

   Classic two-clock design: a coarse setInterval "scheduler" pushes notes a
   short lookahead into the future against the sample-accurate AudioContext
   clock, while requestAnimationFrame reports the playhead position for the UI.

   Exposes window.PS1AUDIO.Transport (+ a pure collectNotes helper for tests).
   ========================================================================== */
(function (root) {
  "use strict";

  var song = root.PS1AUDIO && root.PS1AUDIO.song;

  function isAudible(sng, tr) {
    var anySolo = sng.tracks.some(function (t) { return t.solo; });
    if (anySolo) return tr.solo && !!tr.instrument;
    return !tr.mute && !!tr.instrument;
  }

  // Pure helper (testable): all {track,note} whose start is in [from, to).
  function collectNotes(sng, from, to) {
    var out = [];
    sng.tracks.forEach(function (tr) {
      if (!isAudible(sng, tr)) return;
      for (var i = 0; i < tr.notes.length; i++) {
        var n = tr.notes[i];
        if (n.start >= from && n.start < to) out.push({ track: tr, note: n });
      }
    });
    return out;
  }

  var LOOKAHEAD = 0.12;   // seconds scheduled ahead
  var INTERVAL = 25;      // ms between scheduler ticks

  // PARITY: the console's sequencer processes events once per vblank, so
  // every note on/off lands on that grid. Quantizing the preview's event
  // times UP to the same grid reproduces the (<=20 ms) timing texture the
  // PS1 will have, instead of previewing sample-accurate timing the
  // hardware can't deliver. The game ships on a PAL (SCEE) disc and runs
  // 240p progressive: 314 lines/frame = 49.76 Hz (music.c detects the same
  // rate at runtime - keep the two in sync). NTSC would be 100 / 5983.
  var VBLANK_SEC = 100 / 4976;
  function quantizeUp(anchor, t) {
    return anchor + Math.ceil((t - anchor - 1e-9) / VBLANK_SEC) * VBLANK_SEC;
  }

  function Transport(engine, cb) {
    this.engine = engine;
    this.cb = cb || {};              // getSong, onTick(tick), onStateChange(playing,recording)
    this.playing = false;
    this.recording = false;
    this._timer = null;
    this._raf = null;
    this.startCtxTime = 0;
    this.startTick = 0;
    this.schedFromTick = 0;
    this._openRec = {};              // pitch -> startTick during recording
    this._recSnap = 0;               // snap ticks for recording (0 = off)
  }

  Transport.prototype._spt = function () { var s = this.cb.getSong(); return song.secPerTick(s.bpm, s.ppq); };

  // Fold a "virtual" (monotonically increasing) tick into song ticks: before
  // the first pass over loop.end it's identity; after that it wraps into the
  // loop region. Keeping the transport's own clock virtual (never re-anchored)
  // lets the scheduler look AHEAD across the loop seam, so notes at the start
  // of the loop are scheduled while the previous pass is still sounding.
  function foldTick(s, v) {
    if (!s.loop.enabled) return v;
    var st = s.loop.start, en = s.loop.end, span = Math.max(1, en - st);
    if (v < en) return v;
    return st + ((v - en) % span);
  }

  Transport.prototype.currentTick = function () {
    var s = this.cb.getSong();
    if (!this.playing) return this.startTick;
    var v = this.startTick + (this.engine.now() - this.startCtxTime) / song.secPerTick(s.bpm, s.ppq);
    return foldTick(s, v);
  };

  Transport.prototype.play = function (fromTick) {
    if (this.playing) return;
    this.engine.resume();
    var s = this.cb.getSong();
    this.startTick = fromTick != null ? fromTick : this.startTick;
    this.startCtxTime = this.engine.now() + 0.06;
    this.schedFromTick = this.startTick;
    this.playing = true;
    var self = this;
    this._timer = setInterval(function () { self._schedule(); }, INTERVAL);
    this._schedule();
    this._loopRaf();
    if (this.cb.onStateChange) this.cb.onStateChange(true, this.recording);
  };

  Transport.prototype._schedule = function () {
    var s = this.cb.getSong();
    var spt = song.secPerTick(s.bpm, s.ppq);
    var now = this.engine.now();

    // The scheduling window in VIRTUAL ticks (never wraps). Each virtual
    // sub-range maps onto a contiguous run of song ticks; a window that spans
    // the loop seam is split into segments, so notes right after loop.start
    // are scheduled with sample-accurate timing even while the tail of the
    // previous pass is still playing.
    var windowEndTick = this.startTick + (now + LOOKAHEAD - this.startCtxTime) / spt;
    var cur = this.schedFromTick;

    while (cur < windowEndTick) {
      var sCur = foldTick(s, cur);
      var segEnd = windowEndTick;
      if (s.loop.enabled) segEnd = Math.min(windowEndTick, cur + Math.max(1, s.loop.end - sCur));

      var events = collectNotes(s, sCur, sCur + (segEnd - cur));
      for (var i = 0; i < events.length; i++) {
        var tr = events[i].track, n = events[i].note;
        var vStart = cur + (n.start - sCur); // virtual tick of this occurrence
        var startTime = this.startCtxTime + (vStart - this.startTick) * spt;
        var endTime = startTime + Math.max(1, n.dur) * spt;
        // snap both edges to the console's vblank event grid
        startTime = quantizeUp(this.startCtxTime, startTime);
        endTime = Math.max(startTime + VBLANK_SEC, quantizeUp(this.startCtxTime, endTime));
        if (startTime < now) startTime = now;
        var vol = tr.volume != null ? tr.volume : 1;
        var pitch = n.pitch + (tr.transpose || 0);
        this.engine.scheduleNote(tr.instrument, pitch, n.vel * vol, startTime, endTime);
      }
      cur = segEnd;
    }
    this.schedFromTick = windowEndTick;

    // Non-looping: when the playhead leaves the final block of the sheet,
    // stop and reset the scrub position back to the start.
    if (!s.loop.enabled && this.startTick + (now - this.startCtxTime) / spt > s.lengthTicks) {
      this.stop(); this.seek(0);
    }
  };

  Transport.prototype._loopRaf = function () {
    var self = this;
    function frame() {
      if (!self.playing) return;
      if (self.cb.onTick) self.cb.onTick(self.currentTick());
      self._raf = requestAnimationFrame(frame);
    }
    this._raf = requestAnimationFrame(frame);
  };

  Transport.prototype.stop = function () {
    if (!this.playing) return;
    this.startTick = this.currentTick();  // pause at position
    this.playing = false;
    clearInterval(this._timer); this._timer = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.engine.allNotesOff();
    // close any open recorded notes
    for (var pitch in this._openRec) this.recordNoteOff(pitch | 0);
    if (this.cb.onStateChange) this.cb.onStateChange(false, this.recording);
  };

  Transport.prototype.seek = function (tick) {
    this.startTick = Math.max(0, tick);
    this.schedFromTick = this.startTick;
    if (this.playing) this.startCtxTime = this.engine.now();
    if (this.cb.onTick) this.cb.onTick(this.startTick);
  };

  Transport.prototype.setRecording = function (on, snapTicks) {
    this.recording = !!on; this._recSnap = snapTicks || 0;
    if (this.cb.onStateChange) this.cb.onStateChange(this.playing, this.recording);
  };

  Transport.prototype.recordNoteOn = function (pitch) {
    if (!this.recording || !this.playing) return;
    this._openRec[pitch] = this.currentTick();
  };
  Transport.prototype.recordNoteOff = function (pitch) {
    if (this._openRec[pitch] == null) return;
    var startT = this._openRec[pitch];
    delete this._openRec[pitch];
    var endT = this.currentTick();
    var tr = this.cb.getSelectedTrack && this.cb.getSelectedTrack();
    if (!tr) return;
    if (this._recSnap) startT = Math.round(startT / this._recSnap) * this._recSnap;
    var dur = Math.max(this._recSnap || (this.cb.getSong().ppq / 8), endT - startT);
    if (this.cb.onEdit) this.cb.onEdit(); // snapshot for undo before mutating
    tr.notes.push({ start: Math.max(0, startT), dur: dur, pitch: pitch, vel: 0.85 });
    if (this.cb.onRecord) this.cb.onRecord();
  };

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.Transport = Transport;
  root.PS1AUDIO.scheduler = { collectNotes: collectNotes, isAudible: isAudible };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PS1AUDIO.scheduler;
})(typeof window !== "undefined" ? window : globalThis);
