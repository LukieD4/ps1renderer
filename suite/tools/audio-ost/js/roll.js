/* ==========================================================================
   roll.js — the piano-roll canvas: draw + edit notes on the selected track.

   Coordinates: time runs left->right in ticks; pitch runs bottom->top (MIDI
   0..127). A fixed keyboard gutter on the left scrolls vertically with the
   pitches. Editing (create / move / resize / delete) affects the SELECTED
   track only; other tracks render dimmed for context.

   The app supplies getSong() and getSelectedTrack(); the roll calls back
   onChange() after edits, onSeek(tick) when the ruler is clicked, and
   onPreview(pitch) to audition notes while drawing. onEdit() fires just
   BEFORE any mutation so the app can snapshot for undo.

   Mouse map: LMB click = create note; LMB drag on empty = marquee select;
   LMB drag on a selected note = move the group; MMB drag = pan the sheet.

   Exposes window.PS1AUDIO.PianoRoll.
   ========================================================================== */
(function (root) {
  "use strict";

  var GUTTER = 44;      // keyboard gutter width
  var RULER = 22;       // top ruler height
  var EDGE = 6;         // px hot-zone for resize

  function isBlack(m) { var s = ((m % 12) + 12) % 12; return s === 1 || s === 3 || s === 6 || s === 8 || s === 10; }
  var NN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  function noteName(m) { return NN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }

  function PianoRoll(canvas, cb) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cb = cb || {};
    this.pxPerTick = 0.12;      // horizontal zoom
    this.rowH = 12;             // pitch row height
    this.scrollX = 0;           // ticks scrolled off left (in px)
    this.scrollY = 0;           // px scrolled from top (pitch 127 at top)
    this.snap = 120;            // snap grid in ticks (set by app: ppq/4 etc.)
    this.playTick = 0;
    this.selected = null;       // selected note ref
    this.selectedNotes = [];    // marquee multi-selection (refs into track.notes)
    this._drag = null;
    this._bindEvents();
    this.resize();
  }

  PianoRoll.prototype.song = function () { return this.cb.getSong(); };
  PianoRoll.prototype.track = function () { return this.cb.getSelectedTrack(); };

  PianoRoll.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    // center vertical scroll on middle register initially
    if (this._firstLayout !== true) { this.scrollY = (127 - 84) * this.rowH; this._firstLayout = true; }
    this.draw();
  };

  // ---- transforms --------------------------------------------------------
  PianoRoll.prototype.tickToX = function (t) { return GUTTER + t * this.pxPerTick - this.scrollX; };
  PianoRoll.prototype.xToTick = function (x) { return (x - GUTTER + this.scrollX) / this.pxPerTick; };
  PianoRoll.prototype.pitchToY = function (m) { return RULER + (127 - m) * this.rowH - this.scrollY; };
  PianoRoll.prototype.yToPitch = function (y) { return 127 - Math.floor((y - RULER + this.scrollY) / this.rowH); };
  PianoRoll.prototype.snapTick = function (t) { return Math.round(t / this.snap) * this.snap; };
  // last tick that contains note content (across all tracks)
  PianoRoll.prototype.contentEnd = function () {
    var song = this.song(), max = 0;
    song.tracks.forEach(function (t) { t.notes.forEach(function (n) { if (n.start + n.dur > max) max = n.start + n.dur; }); });
    return max;
  };

  // ---- drawing -----------------------------------------------------------
  PianoRoll.prototype.draw = function () {
    var c = this.ctx, W = this.W, H = this.H, song = this.song();
    if (!song) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#0b0d12"; c.fillRect(0, 0, W, H);

    var ppq = song.ppq, barT = ppq * 4;
    var firstTick = Math.max(0, this.xToTick(GUTTER));
    var lastTick = this.xToTick(W);

    // pitch lanes
    var topPitch = this.yToPitch(RULER), botPitch = this.yToPitch(H);
    for (var m = botPitch - 1; m <= topPitch + 1; m++) {
      if (m < 0 || m > 127) continue;
      var y = this.pitchToY(m);
      c.fillStyle = isBlack(m) ? "#0f131a" : "#141821";
      c.fillRect(GUTTER, y, W - GUTTER, this.rowH);
      if (((m % 12) + 12) % 12 === 0) { c.fillStyle = "rgba(94,234,212,0.06)"; c.fillRect(GUTTER, y, W - GUTTER, this.rowH); }
      c.strokeStyle = "#1a1e28"; c.beginPath(); c.moveTo(GUTTER, y + 0.5); c.lineTo(W, y + 0.5); c.stroke();
    }

    // vertical grid (beats + bars)
    var beatT = ppq;
    var startBeat = Math.floor(firstTick / beatT) * beatT;
    for (var t = startBeat; t <= lastTick; t += beatT) {
      var x = this.tickToX(t);
      var isBar = (t % barT) === 0;
      c.strokeStyle = isBar ? "#2a2f3a" : "#191d26";
      c.beginPath(); c.moveTo(x + 0.5, RULER); c.lineTo(x + 0.5, H); c.stroke();
    }

    // notes: other tracks dimmed, selected track bright
    var sel = this.track();
    for (var ti = 0; ti < song.tracks.length; ti++) {
      var tr = song.tracks[ti];
      var isSel = sel ? tr.id === sel.id : true; // no focused track = global scope
      if (tr.mute && !isSel) continue;
      c.globalAlpha = isSel ? 1 : 0.32;
      for (var i = 0; i < tr.notes.length; i++) this._drawNote(tr.notes[i], tr.color, isSel);
      c.globalAlpha = 1;
    }

    // song end marker
    var ex = this.tickToX(song.lengthTicks);
    c.strokeStyle = "#3a4151"; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(ex, RULER); c.lineTo(ex, H); c.stroke(); c.setLineDash([]);

    // loop region
    if (song.loop.enabled) {
      var lx = this.tickToX(song.loop.start), lw = (song.loop.end - song.loop.start) * this.pxPerTick;
      c.fillStyle = "rgba(245,158,11,0.08)"; c.fillRect(lx, RULER, lw, H - RULER);
      c.strokeStyle = "rgba(245,158,11,0.7)";
      c.beginPath(); c.moveTo(lx, RULER); c.lineTo(lx, H); c.moveTo(lx + lw, RULER); c.lineTo(lx + lw, H); c.stroke();
    }

    this._drawKeys(botPitch, topPitch);
    this._drawRuler(firstTick, lastTick, barT);

    // draggable ruler handles: loop start/end (amber flags) + song-end marker
    if (song.loop.enabled) {
      this._rulerHandle(this.tickToX(song.loop.start), "rgba(245,158,11,0.95)", 1);
      this._rulerHandle(this.tickToX(song.loop.end), "rgba(245,158,11,0.95)", -1);
    }
    this._rulerHandle(this.tickToX(song.lengthTicks), "#8b93a3", -1);

    // marquee selection rectangle
    if (this._drag && this._drag.mode === "marquee") {
      var d = this._drag;
      var mx = Math.min(d.x0, d.x1), my = Math.min(d.y0, d.y1);
      var mw = Math.abs(d.x1 - d.x0), mh = Math.abs(d.y1 - d.y0);
      c.fillStyle = "rgba(94,234,212,0.08)"; c.fillRect(mx, my, mw, mh);
      c.strokeStyle = "rgba(94,234,212,0.7)"; c.strokeRect(mx + 0.5, my + 0.5, mw, mh);
    }

    // playhead
    var px = this.tickToX(this.playTick);
    if (px >= GUTTER) {
      c.strokeStyle = "#f59e0b"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(px, 0); c.lineTo(px, H); c.stroke(); c.lineWidth = 1;
    }
  };

  PianoRoll.prototype._drawNote = function (n, color, sel) {
    var c = this.ctx;
    var x = this.tickToX(n.start), y = this.pitchToY(n.pitch), w = Math.max(2, n.dur * this.pxPerTick);
    if (x + w < GUTTER || x > this.W || y + this.rowH < RULER || y > this.H) return;
    c.fillStyle = color;
    c.fillRect(x, y + 1, w, this.rowH - 2);
    if (sel && (n === this.selected || this.selectedNotes.indexOf(n) >= 0)) { c.strokeStyle = "#fff"; c.strokeRect(x + 0.5, y + 1.5, w - 1, this.rowH - 3); }
    // velocity as inner darkening
    c.fillStyle = "rgba(0,0,0," + (0.55 * (1 - n.vel)).toFixed(2) + ")";
    c.fillRect(x, y + 1, w, this.rowH - 2);
  };

  PianoRoll.prototype._drawKeys = function (botPitch, topPitch) {
    var c = this.ctx;
    c.fillStyle = "#0d0f14"; c.fillRect(0, RULER, GUTTER, this.H - RULER);
    for (var m = botPitch - 1; m <= topPitch + 1; m++) {
      if (m < 0 || m > 127) continue;
      var y = this.pitchToY(m);
      c.fillStyle = isBlack(m) ? "#151922" : "#c7ccd4";
      c.fillRect(0, y, GUTTER - 1, this.rowH);
      c.strokeStyle = "#0b0d12"; c.strokeRect(0.5, y + 0.5, GUTTER - 1, this.rowH);
      if (((m % 12) + 12) % 12 === 0) {
        c.fillStyle = "#565f70"; c.font = "8px monospace"; c.textAlign = "right";
        c.fillText(noteName(m), GUTTER - 4, y + this.rowH - 2);
      }
    }
    c.fillStyle = "#0d0f14"; c.fillRect(0, 0, GUTTER, RULER);
  };

  PianoRoll.prototype._drawRuler = function (firstTick, lastTick, barT) {
    var c = this.ctx;
    c.fillStyle = "#151922"; c.fillRect(GUTTER, 0, this.W - GUTTER, RULER);
    c.strokeStyle = "#2a2f3a"; c.beginPath(); c.moveTo(GUTTER, RULER + 0.5); c.lineTo(this.W, RULER + 0.5); c.stroke();
    var startBar = Math.floor(firstTick / barT) * barT;
    c.fillStyle = "#8b93a3"; c.font = "9px monospace"; c.textAlign = "left";
    for (var t = startBar; t <= lastTick; t += barT) {
      var x = this.tickToX(t);
      c.fillText((t / barT + 1), x + 3, 14);
    }
  };

  // small flag in the ruler band; dir = +1 flag opens right, -1 left
  PianoRoll.prototype._rulerHandle = function (x, color, dir) {
    if (x < GUTTER || x > this.W) return;
    var c = this.ctx;
    c.strokeStyle = color;
    c.beginPath(); c.moveTo(x + 0.5, 2); c.lineTo(x + 0.5, RULER); c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x, 3); c.lineTo(x + 8 * dir, 8); c.lineTo(x, 13);
    c.closePath(); c.fill();
  };

  // ---- hit testing -------------------------------------------------------
  // Which track owns a note object (selection can span tracks in global scope).
  PianoRoll.prototype._ownerOf = function (note) {
    var ts = this.song().tracks;
    for (var i = 0; i < ts.length; i++) if (ts[i].notes.indexOf(note) >= 0) return ts[i];
    return null;
  };

  // Hit test the selected track, or EVERY track when no track is focused
  // (global scope - the app passes getSelectedTrack() == null).
  PianoRoll.prototype._noteAt = function (x, y) {
    var sel = this.track();
    var scope = sel ? [sel] : this.song().tracks;
    for (var s = scope.length - 1; s >= 0; s--) {
      var tr = scope[s];
      for (var i = tr.notes.length - 1; i >= 0; i--) {
        var n = tr.notes[i];
        var nx = this.tickToX(n.start), ny = this.pitchToY(n.pitch), nw = Math.max(2, n.dur * this.pxPerTick);
        if (x >= nx && x <= nx + nw && y >= ny && y <= ny + this.rowH) {
          return { note: n, edge: (x >= nx + nw - EDGE), track: tr };
        }
      }
    }
    return null;
  };

  // ---- interaction -------------------------------------------------------
  PianoRoll.prototype._bindEvents = function () {
    var self = this;
    var cv = this.canvas;

    cv.addEventListener("pointerdown", function (e) {
      var r = cv.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;

      if (y < RULER && x > GUTTER) { // ruler: handles > shift-loop > scrub
        cv.setPointerCapture(e.pointerId);
        var sg = self.song(), HGRAB = 6;
        if (sg.loop.enabled && Math.abs(x - self.tickToX(sg.loop.start)) <= HGRAB) {
          if (self.cb.onEdit) self.cb.onEdit();
          self._drag = { mode: "loopstart" }; return;
        }
        if (sg.loop.enabled && Math.abs(x - self.tickToX(sg.loop.end)) <= HGRAB) {
          if (self.cb.onEdit) self.cb.onEdit();
          self._drag = { mode: "loopend" }; return;
        }
        if (Math.abs(x - self.tickToX(sg.lengthTicks)) <= HGRAB) {
          if (self.cb.onEdit) self.cb.onEdit();
          self._drag = { mode: "endmark" }; return;
        }
        if (e.shiftKey) { // shift-drag: paint a new loop region
          if (self.cb.onEdit) self.cb.onEdit();
          var a = Math.max(0, self.snapTick(self.xToTick(x)));
          sg.loop.enabled = true;
          sg.loop.user = true;
          sg.loop.start = a; sg.loop.end = a + self.snap;
          self._drag = { mode: "loopnew", anchor: a };
          if (self.cb.onLoopChange) self.cb.onLoopChange();
          self.draw(); return;
        }
        var t0 = Math.max(0, self.xToTick(x)); // plain drag: scrub
        self._scrub = { last: t0 };
        self.playTick = t0;
        if (self.cb.onSeek) self.cb.onSeek(t0);
        self.draw(); return;
      }
      if (x < GUTTER) { // keyboard gutter: audition pitch
        var pk = self.yToPitch(y); if (self.cb.onPreview) self.cb.onPreview(pk); return;
      }

      if (e.button === 1) { // middle mouse: pan the sheet
        e.preventDefault();
        cv.setPointerCapture(e.pointerId);
        self._drag = { mode: "pan", x0: x, y0: y, sx: self.scrollX, sy: self.scrollY };
        return;
      }

      var tr = self.track(); // null = global scope (all tracks)
      cv.setPointerCapture(e.pointerId);

      if (e.button === 2) { // right-click erase sweep
        if (self.cb.onEdit) self.cb.onEdit();
        self._drag = { mode: "erase" };
        self._eraseAt(x, y); self.draw(); return;
      }

      var hit = self._noteAt(x, y);
      if (hit) {
        if (e.shiftKey) { // delete
          if (self.cb.onEdit) self.cb.onEdit();
          var own = hit.track || tr;
          var idx = own.notes.indexOf(hit.note); if (idx >= 0) own.notes.splice(idx, 1);
          self.selected = null;
          self.selectedNotes = self.selectedNotes.filter(function (n) { return n !== hit.note; });
          self._change(); self.draw(); return;
        }
        self.selected = hit.note;
        if (self.cb.onEdit) self.cb.onEdit();
        if (!hit.edge && self.selectedNotes.indexOf(hit.note) >= 0 && self.selectedNotes.length > 1) {
          // drag the whole marquee selection
          self._drag = { mode: "movesel",
            grabTick: self.xToTick(x), grabPitch: self.yToPitch(y),
            items: self.selectedNotes.map(function (n) { return { n: n, start0: n.start, pitch0: n.pitch }; }) };
        } else {
          self.selectedNotes = [];
          self._drag = { mode: hit.edge ? "resize" : "move", note: hit.note,
            grabTick: self.xToTick(x), grabPitch: self.yToPitch(y),
            startTick0: hit.note.start, pitch0: hit.note.pitch, dur0: hit.note.dur };
        }
      } else {
        // empty space: a plain click creates a note; holding + dragging LMB
        // sweeps a rectangular selection instead (resolved in pointermove).
        self.selectedNotes = [];
        self.selected = null;
        self._drag = { mode: "maybe", x0: x, y0: y, x1: x, y1: y };
      }
      self.draw();
    });

    cv.addEventListener("pointermove", function (e) {
      var r = cv.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (self._scrub) { // jog the playhead + audition notes crossed
        var nt = Math.max(0, self.xToTick(x));
        if (self.cb.onScrub) self.cb.onScrub(self._scrub.last, nt);
        self._scrub.last = nt; self.playTick = nt;
        if (self.cb.onSeek) self.cb.onSeek(nt);
        self.draw(); return;
      }
      if (!self._drag) {
        // cursor hint
        if (y < RULER && x > GUTTER) {
          var sgh = self.song(), H = 6;
          var near = (sgh.loop.enabled && (Math.abs(x - self.tickToX(sgh.loop.start)) <= H ||
                                           Math.abs(x - self.tickToX(sgh.loop.end)) <= H)) ||
                     Math.abs(x - self.tickToX(sgh.lengthTicks)) <= H;
          cv.style.cursor = near ? "ew-resize" : "col-resize";
          return;
        }
        var hint = self._noteAt(x, y);
        cv.style.cursor = x < GUTTER ? "pointer" : (hint ? (hint.edge ? "ew-resize" : "move") : "crosshair");
        return;
      }
      var d = self._drag, n = d.note;
      if (d.mode === "loopstart" || d.mode === "loopend" || d.mode === "loopnew" || d.mode === "endmark") {
        var sg2 = self.song();
        var t2 = Math.max(0, self.snapTick(self.xToTick(x)));
        if (d.mode === "loopstart") {
          sg2.loop.start = Math.max(0, Math.min(t2, sg2.loop.end - self.snap));
          sg2.loop.user = true;
        } else if (d.mode === "loopend") {
          sg2.loop.end = Math.max(t2, sg2.loop.start + self.snap);
          sg2.loop.user = true;
        } else if (d.mode === "loopnew") {
          sg2.loop.start = Math.min(d.anchor, t2);
          sg2.loop.end = Math.max(d.anchor + self.snap, t2);
          sg2.loop.user = true;
        } else { // endmark: song terminates here; never cut existing notes off
          sg2.lengthTicks = Math.max(self.contentEnd(), Math.max(self.snap, t2));
          // dropping it back onto the auto position un-pins it (auto-fit again)
          sg2.endUser = (sg2.lengthTicks !== self.autoLength());
        }
        if (self.cb.onLoopChange) self.cb.onLoopChange();
        self.draw(); return;
      }
      if (d.mode === "pan") {
        self.scrollX = Math.max(0, d.sx - (x - d.x0));
        self.scrollY = Math.max(0, Math.min((128 * self.rowH) - (self.H - RULER), d.sy - (y - d.y0)));
        self.draw(); return;
      }
      if (d.mode === "maybe") { // resolve: enough movement -> marquee
        if (Math.abs(x - d.x0) + Math.abs(y - d.y0) > 4) { d.mode = "marquee"; }
        else return;
      }
      if (d.mode === "marquee") {
        d.x1 = x; d.y1 = y;
        var tr2 = self.track();
        var scope2 = tr2 ? [tr2] : self.song().tracks;
        var t0 = self.xToTick(Math.min(d.x0, d.x1)), t1 = self.xToTick(Math.max(d.x0, d.x1));
        var pHi = self.yToPitch(Math.min(d.y0, d.y1)), pLo = self.yToPitch(Math.max(d.y0, d.y1));
        var picked = [];
        scope2.forEach(function (trk) {
          trk.notes.forEach(function (nn) {
            if (nn.start < t1 && (nn.start + nn.dur) > t0 && nn.pitch >= pLo && nn.pitch <= pHi) picked.push(nn);
          });
        });
        self.selectedNotes = picked;
        self.draw(); return;
      }
      if (d.mode === "movesel") {
        var dt2 = self.xToTick(x) - d.grabTick;
        var dp2 = self.yToPitch(y) - d.grabPitch;
        for (var mi = 0; mi < d.items.length; mi++) {
          var it = d.items[mi];
          it.n.start = Math.max(0, self.snapTick(it.start0 + dt2));
          it.n.pitch = Math.max(0, Math.min(127, it.pitch0 + dp2));
        }
        self._change(true); self.draw(); return;
      }
      if (d.mode === "erase") { self._eraseAt(x, y); self.draw(); return; }
      if (d.mode === "move") {
        var dt = self.xToTick(x) - d.grabTick;
        n.start = Math.max(0, self.snapTick(d.startTick0 + dt));
        n.pitch = Math.max(0, Math.min(127, d.pitch0 + (self.yToPitch(y) - d.grabPitch)));
      } else { // resize
        var newDur = self.snapTick(self.xToTick(x) - n.start);
        n.dur = Math.max(self.snap, newDur);
      }
      self._change(true);
      self.draw();
    });

    function endDrag(e) {
      if (self._scrub) { self._scrub = null; return; }
      if (!self._drag) return;
      var d = self._drag; self._drag = null;
      if (d.mode === "pan") return;
      if (d.mode === "marquee") { self.draw(); return; } // selection finalized live
      if (d.mode === "maybe") {
        // plain click on empty space: create a note
        var tr = self.track(); if (!tr) return;
        if (self.cb.onEdit) self.cb.onEdit();
        var pitch = self.yToPitch(d.y0);
        var startT = Math.max(0, self.snapTick(self.xToTick(d.x0)));
        var n = { start: startT, dur: self.snap, pitch: pitch, vel: 0.85 };
        tr.notes.push(n);
        self.selected = n;
        if (self.cb.onPreview) self.cb.onPreview(pitch);
        self._change(); self.draw(); return;
      }
      self._change();
    }
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("dblclick", function (e) {
      var r = cv.getBoundingClientRect();
      var hit = self._noteAt(e.clientX - r.left, e.clientY - r.top);
      if (hit) { var tr = self.track(); var i = tr.notes.indexOf(hit.note); if (i >= 0) { if (self.cb.onEdit) self.cb.onEdit(); tr.notes.splice(i, 1); self.selected = null; self._change(); self.draw(); } }
    });
    cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    // suppress the browser's middle-click autoscroll so MMB pans instead
    cv.addEventListener("mousedown", function (e) { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener("auxclick", function (e) { if (e.button === 1) e.preventDefault(); });

    cv.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { // zoom X
        var factor = e.deltaY < 0 ? 1.15 : 0.87;
        self.pxPerTick = Math.max(0.02, Math.min(1.2, self.pxPerTick * factor));
      } else if (e.shiftKey) {
        self.scrollX = Math.max(0, self.scrollX + e.deltaY);
      } else {
        self.scrollY = Math.max(0, Math.min((128 * self.rowH) - (self.H - RULER), self.scrollY + e.deltaY));
        self.scrollX = Math.max(0, self.scrollX + e.deltaX);
      }
      self.draw();
    }, { passive: false });

    window.addEventListener("keydown", function (e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)) return;

      if (e.ctrlKey || e.metaKey) {
        var k = (e.key || "").toLowerCase();
        if (k === "a") {              // select all notes in the current scope
          e.preventDefault();
          var selTr = self.track();
          var scopeA = selTr ? [selTr] : self.song().tracks;
          var all = [];
          scopeA.forEach(function (t) { t.notes.forEach(function (n) { all.push(n); }); });
          self.selectedNotes = all; self.selected = null; self.draw();
        } else if (k === "c" || k === "x") {   // copy / cut
          if (!self.selectedNotes.length && self.selected) self.selectedNotes = [self.selected];
          if (!self.selectedNotes.length) return;
          e.preventDefault();
          var ts = self.song().tracks, base = Infinity;
          self.selectedNotes.forEach(function (n) { if (n.start < base) base = n.start; });
          // clipboard entries remember their owner track INDEX and the start
          // offset relative to the earliest copied note
          self._clip = self.selectedNotes.map(function (n) {
            var ti = 0;
            for (var i = 0; i < ts.length; i++) if (ts[i].notes.indexOf(n) >= 0) { ti = i; break; }
            return { ti: ti, start: n.start - base, dur: n.dur, pitch: n.pitch, vel: n.vel };
          });
          if (k === "x") {
            if (self.cb.onEdit) self.cb.onEdit();
            ts.forEach(function (t) { t.notes = t.notes.filter(function (n) { return self.selectedNotes.indexOf(n) < 0; }); });
            self.selectedNotes = []; self.selected = null;
            self._change();
          }
          self.draw();
        } else if (k === "v") {       // paste at the playhead (snapped)
          if (!self._clip || !self._clip.length) return;
          e.preventDefault();
          if (self.cb.onEdit) self.cb.onEdit();
          var ts2 = self.song().tracks;
          var at = Math.max(0, self.snapTick(self.playTick));
          var selTr2 = self.track();
          // a single-track clip follows the focused track; a multi-track
          // clip goes back to its original tracks (clamped if some are gone)
          var firstTi = self._clip[0].ti;
          var single = self._clip.every(function (c) { return c.ti === firstTi; });
          var fresh = [];
          self._clip.forEach(function (c) {
            var target = (single && selTr2) ? selTr2 : ts2[Math.min(c.ti, ts2.length - 1)];
            var n = { start: at + c.start, dur: c.dur, pitch: c.pitch, vel: c.vel };
            target.notes.push(n); fresh.push(n);
          });
          self.selectedNotes = fresh; self.selected = null;
          self._change(); self.draw();
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (self.selectedNotes.length) {
          if (self.cb.onEdit) self.cb.onEdit();
          self.song().tracks.forEach(function (t) {
            t.notes = t.notes.filter(function (n) { return self.selectedNotes.indexOf(n) < 0; });
          });
          self.selectedNotes = []; self.selected = null;
          self._change(); self.draw(); e.preventDefault();
        } else if (self.selected) {
          var own = self._ownerOf(self.selected);
          if (own) {
            if (self.cb.onEdit) self.cb.onEdit();
            own.notes.splice(own.notes.indexOf(self.selected), 1);
            self.selected = null; self._change(); self.draw(); e.preventDefault();
          }
        }
      }
    });
  };

  PianoRoll.prototype._eraseAt = function (x, y) {
    var hit = this._noteAt(x, y);
    if (hit && hit.track) {
      var i = hit.track.notes.indexOf(hit.note);
      if (i >= 0) { hit.track.notes.splice(i, 1); if (this.selected === hit.note) this.selected = null; }
    }
  };

  // Auto-fit length rounded up to whole bars, 4-bar minimum working area.
  PianoRoll.prototype.autoLength = function () {
    var song = this.song(), barT = song.ppq * 4;
    return Math.max(barT * 4, Math.ceil((this.contentEnd() + 1) / barT) * barT);
  };

  PianoRoll.prototype._change = function (light) {
    var song = this.song();
    var ce = this.contentEnd();
    // Sheet end AUTO-TRACKS the content - it grows when notes extend past it
    // and SHRINKS back when they're deleted - unless the user pinned the end
    // marker by dragging it (song.endUser). A pinned end still never cuts
    // notes off.
    if (song.endUser) song.lengthTicks = Math.max(song.lengthTicks, ce);
    else song.lengthTicks = this.autoLength();
    // Loop region likewise tracks the end of content (rounded up to a beat)
    // until the user paints their own region (song.loop.user).
    if (!song.loop.user) {
      song.loop.start = 0;
      song.loop.end = Math.max(song.ppq, Math.ceil(ce / song.ppq) * song.ppq);
    }
    if (!light && this.cb.onChange) this.cb.onChange();
  };

  PianoRoll.prototype.setPlayhead = function (tick) {
    this.playTick = tick;
    // auto-scroll to keep playhead in view
    var px = this.tickToX(tick);
    if (px > this.W - 80) this.scrollX += (px - (this.W - 80));
    else if (px < GUTTER && tick > 0) this.scrollX = Math.max(0, tick * this.pxPerTick - 40);
    this.draw();
  };
  PianoRoll.prototype.setSnap = function (t) { this.snap = t; };
  PianoRoll.prototype.zoom = function (f) { this.pxPerTick = Math.max(0.02, Math.min(1.2, this.pxPerTick * f)); this.draw(); };

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.PianoRoll = PianoRoll;
})(typeof window !== "undefined" ? window : globalThis);
