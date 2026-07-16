/* ==========================================================================
   song.js — the DAW's data model + Standard MIDI File import + JSON I/O.

   Model (all note timing in TICKS at song.ppq pulses-per-quarter):
     Song  = { ppq, bpm, lengthTicks, loop:{enabled,start,end}, tracks:[Track] }
     Track = { id, name, color, mute, solo, program, notes:[Note], instrument }
     Note  = { start, dur, pitch, vel }   // vel 0..1

   The `instrument` on a track is an SPU engine instrument object (set by the
   app after loading a VAG); its ADPCM body IS serialized (base64) so saves
   remember their instruments.

   Exposes window.PS1AUDIO.song.
   ========================================================================== */
(function (root) {
  "use strict";

  var TRACK_COLORS = ["#5eead4", "#f59e0b", "#a78bfa", "#f472b6", "#60a5fa", "#4ade80", "#fb923c", "#e879f9"];
  var _id = 1;

  function makeTrack(name, colorIdx) {
    return {
      id: _id++,
      name: name || ("Track " + _id),
      color: TRACK_COLORS[(colorIdx || 0) % TRACK_COLORS.length],
      mute: false, solo: false, program: 0,
      volume: 1, transpose: 0,
      notes: [], instrument: null
    };
  }

  function makeSong() {
    return {
      name: "song",
      endUser: false, // true once the user pins the end marker by dragging it
      ppq: 480, bpm: 120, lengthTicks: 480 * 4 * 8, // 8 bars default
      loop: { enabled: false, start: 0, end: 480 * 4 * 4 },
      tracks: [makeTrack("Track 1", 0)]
    };
  }

  // ---- tick <-> time -----------------------------------------------------
  function secPerTick(bpm, ppq) { return 60 / (bpm * ppq); }
  function ticksToSec(ticks, bpm, ppq) { return ticks * secPerTick(bpm, ppq); }
  function secToTicks(sec, bpm, ppq) { return sec / secPerTick(bpm, ppq); }

  // ---- JSON save / load --------------------------------------------------

  // base64 helpers so a track's SPU-ADPCM body survives the JSON round-trip
  // (this is what lets a loaded save remember its instruments).
  function b64encode(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(str) {
    var s = atob(str), u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  // Everything needed to rebuild an engine instrument after load. Returns
  // null for tracks without ADPCM data (they fall back to the demo).
  function serializeInstrument(inst) {
    if (!inst || !inst.adpcmBody) return null;
    return {
      adpcm: b64encode(inst.adpcmBody),
      sampleRate: inst.sampleRate,
      centerNote: inst.centerNote,
      loop: { enabled: !!inst.loop.enabled, start: inst.loop.start | 0, end: inst.loop.end | 0 },
      adsr: inst.adsr, pan: inst.pan, gain: inst.gain, detune: inst.detune,
      cutoff: inst.cutoff, resonance: inst.resonance, reverbSend: inst.reverbSend,
      glide: inst.glide, name: inst.meta && inst.meta.name
    };
  }

  function toJSON(song) {
    return JSON.stringify({
      name: song.name || "song",
      endUser: !!song.endUser,
      ppq: song.ppq, bpm: song.bpm, lengthTicks: song.lengthTicks, loop: song.loop,
      tracks: song.tracks.map(function (t) {
        return { name: t.name, color: t.color, mute: t.mute, solo: t.solo, program: t.program,
                 volume: t.volume, transpose: t.transpose,
                 instrument: serializeInstrument(t.instrument),
                 notes: t.notes.map(function (n) { return [n.start, n.dur, n.pitch, Math.round(n.vel * 127)]; }) };
      })
    });
  }
  function fromJSON(str) {
    var o = JSON.parse(str);
    var song = { name: o.name || "song", endUser: !!o.endUser, ppq: o.ppq || 480, bpm: o.bpm || 120,
      lengthTicks: o.lengthTicks || 480 * 32,
      loop: o.loop || { enabled: false, start: 0, end: 480 * 16 }, tracks: [] };
    (o.tracks || []).forEach(function (t, i) {
      var tr = makeTrack(t.name, i);
      tr.color = t.color || tr.color; tr.mute = !!t.mute; tr.solo = !!t.solo; tr.program = t.program || 0;
      tr.volume = t.volume != null ? t.volume : 1; tr.transpose = t.transpose || 0;
      tr.instrumentData = t.instrument || null; // rebuilt into a live instrument by the app
      tr.notes = (t.notes || []).map(function (a) { return { start: a[0], dur: a[1], pitch: a[2], vel: (a[3] == null ? 100 : a[3]) / 127 }; });
      song.tracks.push(tr);
    });
    if (!song.tracks.length) song.tracks.push(makeTrack("Track 1", 0));
    return song;
  }

  // ---- Standard MIDI File writer -----------------------------------------
  // Format-1 SMF: track 0 = tempo/time-signature, then one track per DAW
  // track. Transpose is baked into the written pitches (same as SEQ export)
  // so the file plays back at the pitch you hear; velocities are raw note
  // velocities. All tracks are written, muted or not - MIDI export is a data
  // export, not a mixdown.
  function buildSMF(song) {
    function vlq(arr, n) {
      var stack = [n & 0x7f]; n >>>= 7;
      while (n > 0) { stack.unshift((n & 0x7f) | 0x80); n >>>= 7; }
      for (var i = 0; i < stack.length; i++) arr.push(stack[i]);
    }
    var chunks = [];

    // track 0: time signature 4/4 + tempo
    var t0 = [];
    vlq(t0, 0); t0.push(0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    var us = Math.round(60000000 / song.bpm);
    vlq(t0, 0); t0.push(0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
    vlq(t0, 0); t0.push(0xff, 0x2f, 0x00);
    chunks.push(t0);

    song.tracks.forEach(function (tr, i) {
      var ch = i & 0x0f, tsp = tr.transpose || 0;
      var d = [];
      var nm = String(tr.name || ("Track " + (i + 1))).slice(0, 64);
      vlq(d, 0); d.push(0xff, 0x03); vlq(d, nm.length);
      for (var c = 0; c < nm.length; c++) d.push(nm.charCodeAt(c) & 0x7f);

      var evs = [];
      tr.notes.forEach(function (n) {
        var p = Math.max(0, Math.min(127, n.pitch + tsp));
        var v = Math.max(1, Math.min(127, Math.round(n.vel * 127)));
        evs.push({ tick: n.start, ord: 1, bytes: [0x90 | ch, p, v] });
        evs.push({ tick: n.start + Math.max(1, n.dur), ord: 0, bytes: [0x80 | ch, p, 0] });
      });
      evs.sort(function (a, b) { return a.tick - b.tick || a.ord - b.ord; });
      var last = 0;
      evs.forEach(function (ev) {
        vlq(d, ev.tick - last); last = ev.tick;
        for (var b = 0; b < ev.bytes.length; b++) d.push(ev.bytes[b]);
      });
      vlq(d, 0); d.push(0xff, 0x2f, 0x00);
      chunks.push(d);
    });

    var total = 14 + chunks.reduce(function (a, c) { return a + 8 + c.length; }, 0);
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    out.set([0x4d, 0x54, 0x68, 0x64], 0);            // "MThd"
    dv.setUint32(4, 6, false);
    dv.setUint16(8, 1, false);                        // format 1
    dv.setUint16(10, chunks.length, false);
    dv.setUint16(12, song.ppq, false);
    var o = 14;
    chunks.forEach(function (c) {
      out.set([0x4d, 0x54, 0x72, 0x6b], o);           // "MTrk"
      dv.setUint32(o + 4, c.length, false);
      out.set(c, o + 8); o += 8 + c.length;
    });
    return out;
  }

  // ---- Standard MIDI File parser ----------------------------------------
  // Returns a Song. Format 0 is split by channel; format 1 keeps its tracks.
  function parseSMF(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var p = 0;

    function str4(off) { return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]); }
    if (str4(0) !== "MThd") throw new Error("Not a MIDI file (missing MThd).");
    var format = dv.getUint16(8, false);
    var ntrks = dv.getUint16(10, false);
    var division = dv.getInt16(12, false);
    var ppq = division > 0 ? division : 480; // SMPTE timecode not supported -> fallback
    p = 14;

    var tempoBpm = 120;
    var rawTracks = []; // { name, notes:[{start,dur,pitch,vel,channel}] }

    for (var t = 0; t < ntrks; t++) {
      if (str4(p) !== "MTrk") break;
      var len = dv.getUint32(p + 4, false);
      var end = p + 8 + len;
      p += 8;

      var abs = 0, running = 0;
      var name = "";
      var open = {};        // key = channel*128+pitch -> {start, vel}
      var notes = [];

      function readVLQ() {
        var v = 0, b;
        do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
        return v >>> 0;
      }

      while (p < end) {
        abs += readVLQ();
        var status = u8[p];
        if (status & 0x80) { running = status; p++; }
        else { status = running; }          // running status
        var type = status & 0xf0;
        var chan = status & 0x0f;

        if (status === 0xff) {              // meta
          var metaType = u8[p++];
          var mlen = readVLQ();
          if (metaType === 0x51 && mlen === 3) {
            var us = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
            tempoBpm = Math.round(60000000 / us);
          } else if (metaType === 0x03) {
            for (var s = 0; s < mlen; s++) name += String.fromCharCode(u8[p + s]);
          }
          p += mlen;
        } else if (status === 0xf0 || status === 0xf7) { // sysex
          var slen = readVLQ(); p += slen;
        } else if (type === 0x90) {         // note on
          var pitch = u8[p++], vel = u8[p++];
          var key = chan * 128 + pitch;
          if (vel > 0) { open[key] = { start: abs, vel: vel / 127 }; }
          else if (open[key]) { notes.push({ start: open[key].start, dur: abs - open[key].start, pitch: pitch, vel: open[key].vel, channel: chan }); delete open[key]; }
        } else if (type === 0x80) {         // note off
          var pitch2 = u8[p++]; p++; // vel ignored
          var key2 = chan * 128 + pitch2;
          if (open[key2]) { notes.push({ start: open[key2].start, dur: abs - open[key2].start, pitch: pitch2, vel: open[key2].vel, channel: chan }); delete open[key2]; }
        } else if (type === 0xc0 || type === 0xd0) { // program change / channel pressure (1 byte)
          p += 1;
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) { // 2-byte messages
          p += 2;
        } else {
          p += 1; // unknown; best-effort advance
        }
      }
      p = end;
      // close any still-open notes at track end
      for (var ok in open) { var o = open[ok]; notes.push({ start: o.start, dur: Math.max(1, abs - o.start), pitch: ok % 128, vel: o.vel, channel: Math.floor(ok / 128) }); }
      rawTracks.push({ name: name.trim(), notes: notes });
    }

    // Build the Song. Split format 0 by channel.
    var song = { name: "song", ppq: ppq, bpm: tempoBpm, lengthTicks: 0, loop: { enabled: false, start: 0, end: 0 }, tracks: [] };
    var groups = [];
    if (format === 0 && rawTracks.length) {
      var byChan = {};
      rawTracks[0].notes.forEach(function (n) { (byChan[n.channel] = byChan[n.channel] || []).push(n); });
      Object.keys(byChan).sort(function (a, b) { return a - b; }).forEach(function (c) {
        groups.push({ name: "Channel " + c, notes: byChan[c] });
      });
    } else {
      rawTracks.forEach(function (rt, i) { if (rt.notes.length) groups.push({ name: rt.name || ("Track " + (i + 1)), notes: rt.notes }); });
    }
    if (!groups.length) groups.push({ name: "Track 1", notes: [] });

    var maxTick = 0;
    groups.forEach(function (g, i) {
      var tr = makeTrack(g.name, i);
      tr.notes = g.notes.map(function (n) { return { start: n.start, dur: Math.max(1, n.dur), pitch: n.pitch, vel: n.vel }; })
                        .sort(function (a, b) { return a.start - b.start; });
      tr.notes.forEach(function (n) { if (n.start + n.dur > maxTick) maxTick = n.start + n.dur; });
      song.tracks.push(tr);
    });

    var barTicks = ppq * 4;
    song.lengthTicks = Math.max(barTicks * 4, Math.ceil((maxTick + 1) / barTicks) * barTicks);
    song.loop.end = song.lengthTicks;
    return song;
  }

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.song = {
    makeSong: makeSong, makeTrack: makeTrack, TRACK_COLORS: TRACK_COLORS,
    secPerTick: secPerTick, ticksToSec: ticksToSec, secToTicks: secToTicks,
    toJSON: toJSON, fromJSON: fromJSON, parseSMF: parseSMF, buildSMF: buildSMF,
    b64encode: b64encode, b64decode: b64decode, serializeInstrument: serializeInstrument
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PS1AUDIO.song;
})(typeof window !== "undefined" ? window : globalThis);
