/* ==========================================================================
   spu.js — the PS1 SPU playback engine (Web Audio).

   The "HTML/JavaScript interpretation" of the console's sound hardware.
   Takes SPU-ADPCM sample data (decoded bit-exactly by adpcm.js, so you hear
   the real quantization) and voices it like the SPU:

     - up to 24 hardware voices, oldest-stolen when exceeded (§9);
     - per-note pitch = 2^((note - centerNote) / 12)   (§6);
     - per-voice ADSR envelope, pan, velocity;
     - sample looping on the recovered loop region for sustain.

   Milestone 2 adds:
     - instruments are standalone objects (buildInstrument), so each DAW track
       has its own; and
     - scheduleNote() plays a note at an absolute AudioContext time for a set
       duration, which the transport scheduler uses to render a song.

   PARITY NOTE: envelopes are quantized through the exporter's SPU register
   mapping (see spuQuantizeADSR), so what previews here is the envelope the
   console will actually produce: linear attack, exponential decay/release,
   rate-quantized durations, 1/15-step sustain.

   FIDELITY NOTE: pitch uses Web Audio's resampler, not the SPU's 4-tap
   Gaussian interpolation, so timbre is a close approximation. The ADPCM
   decode itself is exact. Gaussian interpolation is a later milestone.

   Exposes window.PS1AUDIO.SpuEngine.
   ========================================================================== */
(function (root) {
  "use strict";

  var MAX_VOICES = 24;
  var adpcm = root.PS1AUDIO && root.PS1AUDIO.adpcm;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  var DEFAULT_ADSR = { attack: 0.005, decay: 0.12, sustain: 0.7, release: 0.18 };

  // PARITY: quantize the UI envelope through the SAME register mapping the
  // exporter uses (seqvab.js encodeADSR), then convert the quantized
  // registers back to times. Preview then plays the envelope the console
  // will actually produce: rate-quantized durations, 1/15-step sustain
  // level, LINEAR attack, EXPONENTIAL decay and release.
  function spuQuantizeADSR(a) {
    a = a || DEFAULT_ADSR;
    function rate(t, ref) {
      if (t <= 0) return 0;
      var r = Math.round(44 + 4 * Math.log2(t / ref));
      return r < 0 ? 0 : r > 127 ? 127 : r;
    }
    var Ar = rate(a.attack, 0.106);
    var Dr = Math.max(0, Math.min(15, Math.round(rate(a.decay, 0.04) / 4)));
    var Rr = Math.max(0, Math.min(31, Math.round(rate(a.release, 0.04) / 4)));
    return {
      attack:  0.106 * Math.pow(2, (Ar - 44) / 4),
      decay:   0.04  * Math.pow(2, (4 * Dr - 44) / 4),
      sustain: Math.round((a.sustain != null ? a.sustain : 0.7) * 15) / 15,
      release: 0.04  * Math.pow(2, (4 * Rr - 44) / 4)
    };
  }
  var FILTER_OFF = 20000; // cutoff at/above this = filter bypassed

  // Synthetic impulse response for the reverb bus (exponentially-decaying
  // noise) — a stand-in for the SPU's reverb work-area effect.
  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function SpuEngine() {
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.instrument = null;          // the "live"/default instrument (M1 keyboard)
    this.voices = [];                // active Voice objects, oldest first
    this.maxVoices = MAX_VOICES;
    this.onVoices = null;            // callback(activeCount, peakCount)
    this._peak = 0;
  }

  SpuEngine.prototype.ensureContext = function () {
    if (this.ctx) return this.ctx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    // reverb send/return bus (voices tap into it per their reverbSend amount)
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = makeImpulse(this.ctx, 1.8, 2.6);
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);
    this._lastPitch = null; // for glide/portamento
    return this.ctx;
  };
  SpuEngine.prototype.setReverbReturn = function (v) { this.ensureContext(); this.reverbReturn.gain.value = clamp(v, 0, 1.5); };

  SpuEngine.prototype.now = function () { this.ensureContext(); return this.ctx.currentTime; };
  SpuEngine.prototype.resume = function () {
    this.ensureContext();
    if (this.ctx.state === "suspended") return this.ctx.resume();
    return Promise.resolve();
  };
  SpuEngine.prototype.setMasterGain = function (v) { this.ensureContext(); this.master.gain.value = clamp(v, 0, 1); };

  // ---- Instrument building (standalone objects) --------------------------

  // Build an instrument from Int16 PCM. Returns a plain object; does NOT set
  // it as the live instrument (caller decides).
  SpuEngine.prototype.buildInstrument = function (pcm16, sampleRate, loop, opts) {
    this.ensureContext();
    opts = opts || {};
    var n = pcm16.length;
    var buf = this.ctx.createBuffer(1, Math.max(1, n), sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) ch[i] = pcm16[i] / 32768;
    return {
      buffer: buf,
      sampleRate: sampleRate,
      centerNote: opts.centerNote != null ? opts.centerNote : 60,
      loop: loop && loop.enabled
        ? { enabled: true, start: loop.start | 0, end: loop.end | 0 }
        : { enabled: false, start: 0, end: n },
      adsr: opts.adsr || Object.assign({}, DEFAULT_ADSR),
      pan: opts.pan != null ? opts.pan : 0,
      gain: opts.gain != null ? opts.gain : 0.9,
      detune: opts.detune || 0,               // fine tune, cents
      cutoff: opts.cutoff != null ? opts.cutoff : FILTER_OFF, // lowpass Hz
      resonance: opts.resonance != null ? opts.resonance : 0.7, // filter Q
      reverbSend: opts.reverbSend || 0,        // 0..1 wet send
      glide: opts.glide || 0,                  // portamento seconds
      meta: { name: opts.name || "Sample", samples: n, seconds: n / sampleRate, sampleRate: sampleRate }
    };
  };

  SpuEngine.prototype.buildInstrumentFromAdpcm = function (body, sampleRate, loop, opts) {
    if (!adpcm) throw new Error("adpcm.js not loaded");
    var inst = this.buildInstrument(adpcm.decode(body), sampleRate, loop, opts);
    inst.adpcmBody = body;   // retained so the bank exporter can emit a VAB/VB
    return inst;
  };

  // M1 compatibility: load and set as the live instrument.
  SpuEngine.prototype.loadFromPCM = function (pcm16, sampleRate, loop, opts) {
    this.instrument = this.buildInstrument(pcm16, sampleRate, loop, opts);
    return this.instrument;
  };
  SpuEngine.prototype.loadFromAdpcm = function (body, sampleRate, loop, opts) {
    this.instrument = this.buildInstrumentFromAdpcm(body, sampleRate, loop, opts);
    return this.instrument;
  };
  SpuEngine.prototype.hasInstrument = function () { return !!this.instrument; };

  // Push an instrument's current params onto any of its voices that are
  // already sounding, so slider tweaks are heard immediately.
  SpuEngine.prototype.applyLiveParams = function (instrument) {
    if (!this.ctx || !instrument) return;
    var t = this.ctx.currentTime;
    for (var i = 0; i < this.voices.length; i++) {
      var v = this.voices[i];
      if (v.instrument !== instrument) continue;
      try { if (v.src && v.src.detune) v.src.detune.setValueAtTime(instrument.detune || 0, t); } catch (e) {}
      try { if (v.src) v.src.playbackRate.setValueAtTime(Math.pow(2, (v.note - instrument.centerNote) / 12), t); } catch (e) {}
      if (v.filter) {
        var fc = (instrument.cutoff != null && instrument.cutoff < FILTER_OFF) ? Math.max(60, instrument.cutoff) : FILTER_OFF;
        try { v.filter.frequency.setValueAtTime(fc, t); v.filter.Q.setValueAtTime(instrument.resonance != null ? instrument.resonance : 0.7, t); } catch (e) {}
      }
      if (v.pan) try { v.pan.pan.setValueAtTime(clamp(instrument.pan, -1, 1), t); } catch (e) {}
      if (v.send) try { v.send.gain.setValueAtTime(instrument.reverbSend || 0, t); } catch (e) {}
      if (v.src) {
        var on = !!(instrument.loop && instrument.loop.enabled && instrument.loop.end > instrument.loop.start);
        try {
          if (on) { v.src.loopStart = instrument.loop.start / instrument.sampleRate; v.src.loopEnd = instrument.loop.end / instrument.sampleRate; v.src.loop = true; }
          else { v.src.loop = false; }
        } catch (e) {}
      }
    }
  };
  SpuEngine.prototype.setCenterNote = function (n) { if (this.instrument) this.instrument.centerNote = n; };
  SpuEngine.prototype.setADSR = function (a) { if (this.instrument) this.instrument.adsr = a; };
  SpuEngine.prototype.setPan = function (p) { if (this.instrument) this.instrument.pan = clamp(p, -1, 1); };
  SpuEngine.prototype.setLoopEnabled = function (on) { if (this.instrument) this.instrument.loop.enabled = !!on; };

  // ---- Voice -------------------------------------------------------------
  // when   : absolute start time
  // until  : absolute release time, or null to sustain until release()
  function Voice(engine, instrument, note, velocity, when, until) {
    var ctx = engine.ctx;
    var inst = instrument;

    var src = ctx.createBufferSource();
    src.buffer = inst.buffer;
    if (src.detune) src.detune.value = inst.detune || 0; // fine tune (cents)
    var targetRate = Math.pow(2, (note - inst.centerNote) / 12);
    var glide = inst.glide || 0;
    if (glide > 0 && engine._lastPitch != null && engine._lastPitch !== note) {
      var fromRate = Math.pow(2, (engine._lastPitch - inst.centerNote) / 12);
      src.playbackRate.setValueAtTime(Math.max(0.0001, fromRate), when);
      src.playbackRate.exponentialRampToValueAtTime(Math.max(0.0001, targetRate), when + glide);
    } else {
      src.playbackRate.setValueAtTime(targetRate, when);
    }
    if (inst.loop.enabled && inst.loop.end > inst.loop.start) {
      src.loop = true;
      src.loopStart = inst.loop.start / inst.sampleRate;
      src.loopEnd = inst.loop.end / inst.sampleRate;
    }

    var gain = ctx.createGain();
    var pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

    var adsr = spuQuantizeADSR(inst.adsr);   // console-accurate envelope
    var peak = clamp(velocity, 0, 1) * inst.gain;
    var sustainLevel = Math.max(0.0001, peak * adsr.sustain);
    var atk = Math.max(0.001, adsr.attack), dec = Math.max(0.001, adsr.decay);

    var g = gain.gain;
    g.setValueAtTime(0.0001, when);
    g.linearRampToValueAtTime(Math.max(0.0001, peak), when + atk);   // SPU attack: linear
    g.setTargetAtTime(sustainLevel, when + atk, dec / 3);            // SPU decay: exponential

    // lowpass filter always in the path (transparent at FILTER_OFF) so cutoff
    // and resonance can be adjusted live on a held note.
    var filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = (inst.cutoff != null && inst.cutoff < FILTER_OFF) ? Math.max(60, inst.cutoff) : FILTER_OFF;
    filt.Q.value = inst.resonance != null ? inst.resonance : 0.7;
    src.connect(filt); filt.connect(gain);

    // gain -> pan -> master (dry), plus a reverb send (always present, gain
    // may be 0) so the send amount is also live-adjustable.
    var out = gain;
    if (pan) { pan.pan.value = inst.pan; gain.connect(pan); out = pan; }
    out.connect(engine.master);
    var sg = null;
    if (engine.reverb) { sg = ctx.createGain(); sg.gain.value = inst.reverbSend || 0; out.connect(sg); sg.connect(engine.reverb); }

    src.start(when);
    engine._lastPitch = note;

    this.engine = engine;
    this.instrument = inst;
    this.note = note;
    this.src = src;
    this.gain = gain;
    this.pan = pan;
    this.filter = filt;
    this.send = sg;
    this.startTime = when;
    this.released = false;

    var self = this;
    src.onended = function () { engine._removeVoice(self); };

    if (until != null) {
      // Scheduled note: release at `until`. setTargetAtTime continues from
      // wherever the decay curve is - exponential, like the SPU's release.
      var rel = Math.max(0.005, adsr.release);
      var relStart = Math.max(until, when + atk); // don't release before attack peak
      g.setTargetAtTime(0.0001, relStart, rel / 3);
      try { src.stop(relStart + rel + 0.05); } catch (e) {}
      this.released = true; // won't be released again by noteOff
    }
  }

  Voice.prototype.release = function () {
    if (this.released) return;
    this.released = true;
    var ctx = this.engine.ctx;
    var now = ctx.currentTime;
    var rel = Math.max(0.005, spuQuantizeADSR(this.instrument.adsr).release);
    var g = this.gain.gain;
    if (g.cancelAndHoldAtTime) { g.cancelAndHoldAtTime(now); }
    else { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
    g.setTargetAtTime(0.0001, now, rel / 3);   // SPU release: exponential
    try { this.src.stop(now + rel + 0.05); } catch (e) {}
  };

  Voice.prototype.kill = function () {
    this.released = true;
    try { this.src.onended = null; this.src.stop(); } catch (e) {}
  };

  SpuEngine.prototype._removeVoice = function (v) {
    var i = this.voices.indexOf(v);
    if (i >= 0) { this.voices.splice(i, 1); this._emitVoices(); }
  };
  SpuEngine.prototype._emitVoices = function () {
    var active = this.voices.length;
    if (active > this._peak) this._peak = active;
    if (this.onVoices) this.onVoices(active, this._peak);
  };
  SpuEngine.prototype.resetPeak = function () { this._peak = this.voices.length; this._emitVoices(); };

  SpuEngine.prototype._stealIfNeeded = function () {
    while (this.voices.length >= this.maxVoices) {
      var victim = this.voices[0];
      for (var k = 0; k < this.voices.length; k++) { if (this.voices[k].released) { victim = this.voices[k]; break; } }
      victim.kill();
      this._removeVoice(victim);
    }
  };

  // Live note (sustained until noteOff) on the live instrument.
  SpuEngine.prototype.noteOn = function (note, velocity) {
    if (!this.instrument) return null;
    this.ensureContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    this._stealIfNeeded();
    var v = new Voice(this, this.instrument, note, velocity == null ? 1 : velocity, this.ctx.currentTime, null);
    this.voices.push(v); this._emitVoices();
    return v;
  };

  SpuEngine.prototype.noteOff = function (note) {
    for (var i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].note === note && !this.voices[i].released && this.voices[i].instrument === this.instrument) {
        this.voices[i].release();
        return;
      }
    }
  };

  // Scheduled note for the transport: fixed instrument, start + end times.
  SpuEngine.prototype.scheduleNote = function (instrument, note, velocity, startTime, endTime) {
    if (!instrument) return null;
    this.ensureContext();
    this._stealIfNeeded();
    var v = new Voice(this, instrument, note, velocity == null ? 1 : velocity, startTime, endTime);
    this.voices.push(v); this._emitVoices();
    return v;
  };

  SpuEngine.prototype.allNotesOff = function () {
    var copy = this.voices.slice();
    for (var i = 0; i < copy.length; i++) copy[i].release();
  };
  SpuEngine.prototype.panic = function () {
    var copy = this.voices.slice();
    for (var i = 0; i < copy.length; i++) copy[i].kill();
    this.voices = []; this._peak = 0; this._emitVoices();
  };

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.SpuEngine = SpuEngine;
  root.PS1AUDIO.MAX_VOICES = MAX_VOICES;
  root.PS1AUDIO.spuQuantizeADSR = spuQuantizeADSR;
})(typeof window !== "undefined" ? window : globalThis);
