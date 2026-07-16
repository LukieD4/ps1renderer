/* ==========================================================================
   midi.js — note input: a connected MIDI piano (Web MIDI API) and the
   computer keyboard. Both funnel into the same noteOn / noteOff callbacks
   so the SPU engine doesn't care where a note came from.

   Web MIDI is supported in Chromium browsers; if unavailable the tool still
   works via the computer keyboard and the on-screen piano.

   Exposes window.PS1AUDIO.input with:
     MidiInput   — wraps navigator.requestMIDIAccess, lists devices, routes.
     KeyboardInput — maps the computer keyboard to piano notes + octave shift.
   ========================================================================== */
(function (root) {
  "use strict";

  // ---- Web MIDI ----------------------------------------------------------
  function MidiInput(handlers) {
    this.handlers = handlers || {};   // { noteOn(note,vel), noteOff(note), devices(list) }
    this.access = null;
    this.inputs = [];                 // [{id,name,input}]
    this.boundId = null;              // currently listened device id, or "all"
    this.supported = !!(navigator.requestMIDIAccess);
  }

  MidiInput.prototype.init = function () {
    var self = this;
    if (!this.supported) return Promise.reject(new Error("Web MIDI not supported in this browser."));
    return navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
      self.access = access;
      access.onstatechange = function () { self._refresh(); };
      self._refresh();
      self.listen("all");
      return self.inputs;
    });
  };

  MidiInput.prototype._refresh = function () {
    this.inputs = [];
    if (!this.access) return;
    var it = this.access.inputs.values();
    for (var o = it.next(); !o.done; o = it.next()) {
      var inp = o.value;
      this.inputs.push({ id: inp.id, name: inp.name || "MIDI device", input: inp });
    }
    if (this.handlers.devices) this.handlers.devices(this.inputs);
    // Re-bind in case the chosen device reconnected.
    if (this.boundId) this.listen(this.boundId);
  };

  MidiInput.prototype.listen = function (id) {
    var self = this;
    this.boundId = id;
    // Detach all, then attach the selected (or all).
    this.inputs.forEach(function (d) { d.input.onmidimessage = null; });
    this.inputs.forEach(function (d) {
      if (id === "all" || d.id === id) {
        d.input.onmidimessage = function (e) { self._onMessage(e.data); };
      }
    });
  };

  MidiInput.prototype._onMessage = function (data) {
    var status = data[0] & 0xf0;
    var note = data[1], vel = data[2];
    if (status === 0x90 && vel > 0) {
      if (this.handlers.noteOn) this.handlers.noteOn(note, vel / 127);
    } else if (status === 0x80 || (status === 0x90 && vel === 0)) {
      if (this.handlers.noteOff) this.handlers.noteOff(note);
    }
  };

  // ---- Computer keyboard -------------------------------------------------
  // Two rows of a virtual piano, tracker/DAW style. Lower row (z..) is one
  // octave below the upper row (q..).
  var KEY_MAP = {
    // upper row  — a=C, w=C#, s=D, e=D#, d=E, f=F, t=F#, g=G, y=G#, h=A, u=A#, j=B, k=C
    "a": 0, "w": 1, "s": 2, "e": 3, "d": 4, "f": 5, "t": 6, "g": 7,
    "y": 8, "h": 9, "u": 10, "j": 11, "k": 12, "o": 13, "l": 14, "p": 15
  };

  function KeyboardInput(handlers) {
    this.handlers = handlers || {};   // { noteOn, noteOff, octave(n) }
    this.octave = 4;                  // base octave; 'a' => C4 = MIDI 60
    this.down = {};                   // held keys -> midi note
    this.enabled = true;
    this._bind();
  }

  KeyboardInput.prototype._bind = function () {
    var self = this;
    window.addEventListener("keydown", function (e) { self._onDown(e); });
    window.addEventListener("keyup", function (e) { self._onUp(e); });
  };

  KeyboardInput.prototype._noteFor = function (key) {
    var semitone = KEY_MAP[key];
    if (semitone == null) return null;
    return (this.octave + 1) * 12 + semitone; // MIDI: C4 = 60 at octave 4
  };

  KeyboardInput.prototype._onDown = function (e) {
    if (!this.enabled) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var key = e.key.toLowerCase();

    if (key === "z") { this.setOctave(this.octave - 1); e.preventDefault(); return; }
    if (key === "x") { this.setOctave(this.octave + 1); e.preventDefault(); return; }

    if (e.repeat) return;
    var note = this._noteFor(key);
    if (note == null || this.down[key] != null) return;
    this.down[key] = note;
    if (this.handlers.noteOn) this.handlers.noteOn(note, 0.85);
    e.preventDefault();
  };

  KeyboardInput.prototype._onUp = function (e) {
    var key = e.key.toLowerCase();
    var note = this.down[key];
    if (note == null) return;
    delete this.down[key];
    if (this.handlers.noteOff) this.handlers.noteOff(note);
  };

  KeyboardInput.prototype.setOctave = function (o) {
    this.octave = Math.max(0, Math.min(8, o));
    if (this.handlers.octave) this.handlers.octave(this.octave);
  };

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.input = { MidiInput: MidiInput, KeyboardInput: KeyboardInput, KEY_MAP: KEY_MAP };
})(typeof window !== "undefined" ? window : globalThis);
