PS1 AUDIO BANK — WAV -> VAG encoder
===================================

Drop this "audio-bank" folder into the suite at:

    suite/tools/audio-bank/

It already matches the folder the semantics doc lives in
(suite/tools/audio-bank/PS1AUDIO_SEMANTICS.txt). Keep that .txt alongside it.

TWO one-line edits to register it in the suite (both files currently list
the existing tools; just add the audio-bank entry):

1) suite/js/navbar.js  — add to the NAV_LINKS array:

     { key: "audio", label: "Audio Bank", href: "/tools/audio-bank/index.html" }

2) suite/index.html  — add a card (new section or under an "Audio" heading):

     <a class="home-card" href="tools/audio-bank/index.html">
       <div class="home-card__title">Audio Bank</div>
       <div class="home-card__desc">Convert a .wav into a PS1 SPU-ADPCM .VAG,
       with sample-rate, anti-alias, effort and loop controls, and A/B preview.</div>
     </a>

The page sets  data-nav-key="audio"  so the nav highlights correctly.

WHAT IT DOES
------------
WAV -> mono -> windowed-sinc anti-alias resample to the target rate ->
Int16 -> SPU-ADPCM (best filter+shift per block, decoder-accurate feedback,
silent lead-in, one-shot terminator or loop flags) -> 48-byte big-endian VAG.
The encoded body is decoded back with the exact hardware math for A/B preview
and an estimated-SNR readout. 100% offline, no uploads.

VERIFIED
--------
- Round-trip SNR ~58-64 dB on tones; all shifts within 0..12; filters 0-4.
- Lead-in block 0x00/0x00, one-shot terminator flag 0x07, loop flags 0x04/0x03.
- VAG header exact: "VAGp", version 0x20, big-endian dataSize/freq,
  pitch register (rate<<12)/44100  (44100->0x1000, 22050->0x800).

SCOPE
-----
v1 targets VAG (single SPU-ADPCM sample) — the self-contained, verifiable
format. VAB/SEQ banks and XA CD streams are described in the semantics doc
and are the natural next builds on top of this same adpcm.js core.
