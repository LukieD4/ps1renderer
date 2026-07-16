/* ==========================================================================
   seqvab.js — export a Song to PS1 music files: a VAB instrument bank and a
   SEQ score (PS1AUDIO_SEMANTICS.txt §6-7). Together these are the few-KB
   pair a PS1 plays as music.

   Mapping (Milestone 3, one-tone-per-track):
     each track  -> one VAB PROGRAM (a MIDI instrument)
                 -> one TONE spanning the whole key range
                 -> one VAG waveform (the track's retained SPU-ADPCM body,
                    with the instrument's CURRENT loop points baked into the
                    per-block flag bytes at export time)
     each track's notes -> events on one SEQ MIDI channel, program-selected.

   On-disk conventions (verified against psx-spx / PsyQ formats):
     - VH magic is the bytes "pBAV" (the 32-bit ID "VABp" stored little-endian;
       only VAG files literally begin "VAGp"). SEQ likewise starts "pQES".
     - VH layout: 32-byte header, ProgAtr x128 (fixed 2048 B), then the tone
       table sized 512 bytes PER PROGRAM (16 tones x 32 B), then the 512-byte
       VAG pointer table. The tone table is NOT fixed at 128 programs.
     - VAG pointer table entry 0 is a dummy (0); VAG n's size>>3 lives at
       index n, matching the 1-based VAG refs in the tone entries.
     - SEQ time signature denominator is the SMF power-of-2 exponent (4/4 =
       04 02).

   Exposes window.PS1AUDIO.seqvab { buildVAB, buildSEQ }.
   ========================================================================== */
(function (root) {
  "use strict";

  var BLOCK_BYTES = 16;
  var SAMPLES_PER_BLOCK = 28;
  var VB_MAX_BYTES = 0x7E000; // §6: total ADPCM data cap per VAB (516,096 B)

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // UI-seconds -> SPU ADSR registers.
  //
  // IMPORTANT: SPU envelope rates are INVERTED - value 0 is the FASTEST,
  // 0x7f the slowest (hours). Per psx-spx the envelope steps 7-(rate&3)
  // every 2^max(0,(rate>>2)-11) ticks, so envelope time roughly DOUBLES for
  // every +4 of rate; a linear 0->max attack takes ~0.106 s at rate 44.
  // rateFromTime inverts that law. Decay/release registers are 4/5-bit
  // values that the hardware shifts left by 2 (so /4 here); they're
  // exponential, calibrated to ~0.04 s at effective rate 44.
  function rateFromTime(t, refTime) {
    if (t <= 0) return 0;
    return clamp(Math.round(44 + 4 * Math.log2(t / refTime)), 0, 0x7f);
  }
  function encodeADSR(adsr) {
    var a = adsr || { attack: 0.005, decay: 0.12, sustain: 0.7, release: 0.18 };
    var Ar = rateFromTime(a.attack, 0.106);              // 7-bit, linear rise
    var Dr = clamp(Math.round(rateFromTime(a.decay, 0.04) / 4), 0, 0x0f);
    var Sl = clamp(Math.round(a.sustain * 15), 0, 15);
    var Am = 0;                                          // linear attack
    var adsr1 = (Sl & 0x0f) | ((Dr & 0x0f) << 4) | ((Ar & 0x7f) << 8) | ((Am & 1) << 15);
    var Rr = clamp(Math.round(rateFromTime(a.release, 0.04) / 4), 0, 0x1f);
    var Rm = 1;                                          // exponential release
    var Sr = 0x7f, Sd = 0, Sm = 0; // sustain: slowest increase = hold
    var adsr2 = (Rr & 0x1f) | ((Rm & 1) << 5) | ((Sr & 0x7f) << 6) | ((Sd & 1) << 14) | ((Sm & 1) << 15);
    return [adsr1 & 0xffff, adsr2 & 0xffff];
  }

  // 44100-referenced center note: a lower-rate sample needs a higher center
  // note to compensate for the octave shift (§6 gotcha). The compensation is
  // rarely a whole number of semitones (16 kHz -> 17.55), so the fractional
  // part goes into the tone's FINE PITCH byte (1/128 semitone units) instead
  // of being rounded away - rounding costs up to +/-50 cents of parity
  // between the DAW preview and the console.
  function centerFineFor(inst) {
    var base = inst.centerNote != null ? inst.centerNote : 60;
    var total = base + 12 * Math.log2(44100 / (inst.sampleRate || 44100));
    var c = Math.floor(total);
    var f = Math.round((total - c) * 128);
    if (f === 128) { c++; f = 0; }
    return [clamp(c, 0, 127), clamp(f, 0, 127)];
  }

  // Bake the instrument's CURRENT loop points (edited live in the UI) into
  // the exported SPU-ADPCM body's flag bytes, instead of shipping whatever
  // flags the original encode happened to write.
  //   Looped   : truncate after the loop-end block (the SPU never plays past
  //              it), flag 0x04 on the loop-start block, 0x03 on the end
  //              block (0x07 if they coincide).
  //   One-shot : clear loop flags, 0x01 on the last data block, and append
  //              the mandatory silent 0x07 terminator block (§5).
  // Sample indices are into the decoded body (lead-in block included), which
  // is exactly how inst.loop.start/end are stored by the app.
  function bodyForExport(inst) {
    var src = inst.adpcmBody;
    var nBlocks = Math.floor(src.length / BLOCK_BYTES);
    if (!nBlocks) return new Uint8Array(0);
    var loop = inst.loop && inst.loop.enabled && inst.loop.end > inst.loop.start;
    var b;
    if (loop) {
      var sb = clamp(Math.floor(inst.loop.start / SAMPLES_PER_BLOCK), 0, nBlocks - 1);
      var eb = clamp(Math.ceil(inst.loop.end / SAMPLES_PER_BLOCK) - 1, sb, nBlocks - 1);
      var out = new Uint8Array((eb + 1) * BLOCK_BYTES);
      out.set(src.subarray(0, out.length));
      for (b = 0; b <= eb; b++) out[b * BLOCK_BYTES + 1] = 0x00;
      out[sb * BLOCK_BYTES + 1] |= 0x04; // loop start
      out[eb * BLOCK_BYTES + 1] |= 0x03; // loop end + sustain (0x07 if sb==eb)
      return out;
    }
    // one-shot: drop a pre-existing trailing terminator (we re-append our own)
    var last = nBlocks - 1;
    if (src[last * BLOCK_BYTES + 1] === 0x07) { nBlocks--; last--; }
    if (!nBlocks) return new Uint8Array(0);
    var out2 = new Uint8Array((nBlocks + 1) * BLOCK_BYTES);
    out2.set(src.subarray(0, nBlocks * BLOCK_BYTES));
    for (b = 0; b < nBlocks; b++) out2[b * BLOCK_BYTES + 1] = 0x00;
    out2[last * BLOCK_BYTES + 1] = 0x01;       // end + release/mute
    out2[nBlocks * BLOCK_BYTES + 1] = 0x07;    // silent terminator block
    return out2;
  }

  // ---- VAB ---------------------------------------------------------------
  var VH_HEADER = 0x20;
  var PROG_TABLE = 128 * 16;            // 2048, always all 128 programs
  var VAG_TABLE = 256 * 2;              // 512
  function vhSize(progCount) { return VH_HEADER + PROG_TABLE + progCount * 16 * 32 + VAG_TABLE; }

  function buildVAB(song, opts) {
    opts = opts || {};
    var tracks = song.tracks.slice(0, 128);
    var progCount = tracks.length;
    // collect one VAG per track that actually has ADPCM bytes
    var vags = [];      // { body, size, inst }
    var progVag = [];   // per track -> vag index (0-based) or -1
    tracks.forEach(function (tr) {
      var inst = tr.instrument;
      var body = inst && inst.adpcmBody && inst.adpcmBody.length ? bodyForExport(inst) : null;
      if (body && body.length) { progVag.push(vags.length); vags.push({ body: body, size: body.length, inst: inst }); }
      else progVag.push(-1);
    });
    if (vags.length > 254) throw new Error("Too many instruments for one VAB (max 254).");

    var vbSize = vags.reduce(function (s, v) { return s + v.size; }, 0);
    if (vbSize > VB_MAX_BYTES) throw new Error("Waveform data " + vbSize + " B exceeds the 0x7E000-byte VAB cap — lower sample rates or trim loops.");
    var vhTotal = vhSize(progCount);
    var total = vhTotal + vbSize;
    var buf = new ArrayBuffer(total);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var totalTones = progVag.filter(function (v) { return v >= 0; }).length;

    // --- VH header (0x20). Magic bytes are "pBAV" on disk (LE id "VABp").
    u8[0] = 0x70; u8[1] = 0x42; u8[2] = 0x41; u8[3] = 0x56; // "pBAV"
    dv.setUint32(0x04, 0x00000007, true);   // version
    dv.setUint32(0x08, opts.id || 0, true);  // vab id
    dv.setUint32(0x0c, total, true);         // total file size
    dv.setUint16(0x10, 0, true);             // reserved
    dv.setUint16(0x12, progCount, true);     // program count
    dv.setUint16(0x14, totalTones, true);    // tone count
    dv.setUint16(0x16, vags.length, true);   // vag count
    u8[0x18] = 0x7f; // master vol
    u8[0x19] = 0x40; // master pan
    u8[0x1a] = 0; u8[0x1b] = 0;
    dv.setUint32(0x1c, 0, true);

    // --- Program attribute table (always 128 x 16)
    var pbase = VH_HEADER;
    tracks.forEach(function (tr, i) {
      var o = pbase + i * 16;
      u8[o + 0] = progVag[i] >= 0 ? 1 : 0; // number of tones in program
      u8[o + 1] = clamp(Math.round((tr.instrument ? tr.instrument.gain : 0.9) * 127), 0, 127); // mvol
      u8[o + 2] = 0;      // priority
      u8[o + 3] = 0;      // mode
      u8[o + 4] = clamp(Math.round((((tr.instrument ? tr.instrument.pan : 0) + 1) / 2) * 127), 0, 127); // pan
      // rest reserved (already zero)
    });

    // --- Tone attribute table: 16 tones x 32 B PER PROGRAM (progCount deep)
    var tbase = VH_HEADER + PROG_TABLE;
    tracks.forEach(function (tr, i) {
      var vi = progVag[i];
      if (vi < 0) return; // no waveform -> program has zero tones
      var o = tbase + (i * 16) * 32; // tone 0 of program i
      var inst = tr.instrument || {};
      var adsr = encodeADSR(inst.adsr);
      var cf = centerFineFor(inst);
      u8[o + 0] = 0;                 // priority
      u8[o + 1] = 0;                 // mode
      u8[o + 2] = 127;               // vol
      u8[o + 3] = 64;                // pan
      u8[o + 4] = cf[0];             // center note (whole semitones)
      u8[o + 5] = cf[1];             // fine pitch (1/128 semitone)
      u8[o + 6] = 0;                 // min note
      u8[o + 7] = 127;               // max note
      u8[o + 8] = 0; u8[o + 9] = 0;  // vib w/t
      u8[o + 10] = 0; u8[o + 11] = 0;// por w/t
      u8[o + 12] = 0;                // pbmin
      u8[o + 13] = 0;                // pbmax
      u8[o + 14] = 0; u8[o + 15] = 0;// reserved
      dv.setUint16(o + 16, adsr[0], true); // adsr1
      dv.setUint16(o + 18, adsr[1], true); // adsr2
      dv.setUint16(o + 20, i, true);       // parent program
      dv.setUint16(o + 22, vi + 1, true);  // vag ref (1-based)
      // reserved[4] already zero
    });

    // --- VAG pointer table (256 x u16 = size>>3; entry 0 is a dummy so the
    //     1-based tone refs line up: vag n's size sits at index n)
    var vgbase = tbase + progCount * 16 * 32;
    dv.setUint16(vgbase, 0, true);
    vags.forEach(function (v, j) { dv.setUint16(vgbase + (j + 1) * 2, (v.size >> 3) & 0xffff, true); });

    // --- VB body (raw ADPCM blocks, back to back)
    var vo = vhTotal;
    vags.forEach(function (v) { u8.set(v.body, vo); vo += v.size; });

    return u8;
  }

  // ---- SEQ ---------------------------------------------------------------
  function vlq(arr, n) {
    var stack = [n & 0x7f]; n >>>= 7;
    while (n > 0) { stack.unshift((n & 0x7f) | 0x80); n >>>= 7; }
    for (var i = 0; i < stack.length; i++) arr.push(stack[i]);
  }

  function buildSEQ(song) {
    var ppq = song.ppq, us = Math.round(60000000 / song.bpm);

    // gather events across tracks -> one channel each. PARITY: the DAW's
    // playback applies mute/solo, per-track volume and transpose at play
    // time; none of those exist in the SEQ format, so they are BAKED here -
    // muted (or non-soloed) tracks export no notes, transpose shifts the
    // written pitch, and track volume scales the written velocity.
    var evs = [];
    var anySolo = song.tracks.some(function (t) { return t.solo; });
    song.tracks.forEach(function (tr, i) {
      var ch = i & 0x0f;
      evs.push({ tick: 0, ord: 0, bytes: [0xc0 | ch, i & 0x7f] }); // program change
      var audible = anySolo ? tr.solo : !tr.mute;
      if (!audible) return;
      var tvol = tr.volume != null ? tr.volume : 1;
      var tsp = tr.transpose || 0;
      tr.notes.forEach(function (n) {
        var vel = clamp(Math.round(n.vel * tvol * 127), 1, 127);
        var pitch = clamp(n.pitch + tsp, 0, 127);
        evs.push({ tick: n.start, ord: 2, bytes: [0x90 | ch, pitch, vel] });
        evs.push({ tick: n.start + Math.max(1, n.dur), ord: 1, bytes: [0x80 | ch, pitch, 0] });
      });
    });
    // loop markers via NRPN on channel 0 (§7): MSB 20 = start, 30 = end
    if (song.loop && song.loop.enabled) {
      evs.push({ tick: song.loop.start, ord: 0, bytes: [0xb0, 0x63, 20] });
      evs.push({ tick: song.loop.end, ord: 3, bytes: [0xb0, 0x63, 30] });
    }
    evs.sort(function (a, b) { return a.tick - b.tick || a.ord - b.ord; });

    var body = [];
    var last = 0;
    for (var i = 0; i < evs.length; i++) {
      vlq(body, evs[i].tick - last);
      last = evs[i].tick;
      for (var b = 0; b < evs[i].bytes.length; b++) body.push(evs[i].bytes[b] & 0xff);
    }
    // end of track at the song's END MARKER (not the last note), so a
    // one-shot song terminates in-game exactly where the DAW's playback
    // stops, including any intentional trailing silence.
    var endTick = Math.max(last, song.lengthTicks || 0);
    vlq(body, endTick - last); body.push(0xff, 0x2f, 0x00);

    var head = [];
    head.push(0x70, 0x51, 0x45, 0x53);                 // "pQES"
    head.push(0, 0, 0, 1);                             // version (BE)
    head.push((ppq >> 8) & 0xff, ppq & 0xff);          // resolution (BE u16)
    head.push((us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff); // tempo us/quarter (BE 3)
    head.push(0x04, 0x02);                             // time signature 4/4 (nn, dd = 2^2)

    var out = new Uint8Array(head.length + body.length);
    out.set(head, 0); out.set(body, head.length);
    return out;
  }

  root.PS1AUDIO = root.PS1AUDIO || {};
  root.PS1AUDIO.seqvab = { buildVAB: buildVAB, buildSEQ: buildSEQ, encodeADSR: encodeADSR, bodyForExport: bodyForExport, vhSize: vhSize };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PS1AUDIO.seqvab;
})(typeof window !== "undefined" ? window : globalThis);
