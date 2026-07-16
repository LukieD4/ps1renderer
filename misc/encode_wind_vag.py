#!/usr/bin/env python3
"""
encode_wind_vag.py  -  wind1.wav -> looped SPU-ADPCM WIND.VAG

Faithful to PS1AUDIO_SEMANTICS.txt:
  - 16-byte blocks, 28 samples each, 3.5:1
  - brute-force filter(0-4) x shift search with decoder-accurate feedback
  - continuous prev1/prev2 state across the whole sample
  - silent lead-in block (flag 0x00), loop-start (0x04), loop-end (0x03)
  - 48-byte big-endian VAG header

Ambient wind is long; a full 42 s loop won't fit 512 KB SPU RAM, so we take an
~8 s segment and crossfade the seam to make it loop seamlessly. Loop length is
kept a multiple of 28 samples so the loop region lands on a block boundary.
"""

import wave, struct, sys
import numpy as np
from scipy.signal import resample_poly

SRC       = "wind1.wav"
OUT       = "WIND.VAG"
NAME      = "WIND"
TARGET_HZ = 22050
SEG_START_S = 5.0      # skip any intro
SEG_LEN_S   = 8.0      # loop body length (seconds, snapped to *28 below)
XFADE_S     = 0.30     # crossfade length for a seamless seam

POS = [0, 60, 115, 98, 122]     # k1 table (section 2)
NEG = [0,  0, -52, -55, -60]    # k2 table

def clamp16(x):
    return -32768 if x < -32768 else (32767 if x > 32767 else x)

# ---- 1. read wav -> mono float ------------------------------------------------
w = wave.open(SRC, "rb")
ch, rate, width, n = (w.getnchannels(), w.getframerate(),
                      w.getsampwidth(), w.getnframes())
raw = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float64)
w.close()
if ch == 2:
    raw = raw.reshape(-1, 2).mean(axis=1)

# ---- 2. slice, resample to target --------------------------------------------
a = int(SEG_START_S * rate)
b = a + int((SEG_LEN_S + XFADE_S + 0.2) * rate)
seg = raw[a:b]
res = resample_poly(seg, TARGET_HZ, rate)          # anti-aliased downsample

L = (int(SEG_LEN_S * TARGET_HZ) // 28) * 28         # loop length, multiple of 28
X = int(XFADE_S * TARGET_HZ)
assert len(res) >= L + X, "segment too short for crossfade"

# ---- 3. seamless-loop crossfade ----------------------------------------------
# loop[i]=res[i] for i>=X; for i<X blend res[i] (fade in) with res[i+L] (fade out)
loop = res[:L].copy()
t = np.arange(X) / X
loop[:X] = res[:X] * t + res[L:L + X] * (1.0 - t)

pcm = np.clip(np.round(loop), -32768, 32767).astype(np.int64)
assert len(pcm) % 28 == 0

# ---- 4. encode one 28-sample block (brute force) -----------------------------
def encode_block(samples, prev1, prev2, flag):
    best = None
    for filt in range(5):
        k1, k2 = POS[filt], NEG[filt]
        # residual range for min-shift derivation
        s_min = s_max = 0
        p1, p2 = prev1, prev2
        for s in samples:
            pred = (k1 * p1 + k2 * p2 + 32) >> 6
            r = s - pred
            s_min = min(s_min, r); s_max = max(s_max, r)
            p1, p2 = s, p1            # range pass uses originals (approx), refined below
        rs = 0
        while ((s_max >> rs) > (0x7FFF >> 12) or (s_min >> rs) < (-0x8000 >> 12)) and rs < 12:
            rs += 1
        min_shift = 12 - rs
        for shift in range(max(0, min_shift - 1), min(12, min_shift + 1) + 1):
            p1, p2 = prev1, prev2
            mse = 0
            nibbles = []
            for s in samples:
                pred = (k1 * p1 + k2 * p2 + 32) >> 6
                resid = s - pred
                # quantize with rounding into 4-bit range
                q = (resid << shift) + (1 << 11)     # (12-1)=11 rounding term, doc s.4.4
                q >>= 12
                if q > 7: q = 7
                if q < -8: q = -8
                # reconstruct exactly as hardware
                recon = clamp16(((q << (12 - shift)) if (12 - shift) >= 0 else (q >> (shift - 12))) + pred)
                err = s - recon
                mse += err * err
                nibbles.append(q & 0x0F)
                p1, p2 = recon, p1
            if best is None or mse < best[0]:
                best = (mse, filt, shift, nibbles)
    mse, filt, shift, nibbles = best
    # commit: reconstruct to carry exact state
    p1, p2 = prev1, prev2
    k1, k2 = POS[filt], NEG[filt]
    for i, s in enumerate(samples):
        pred = (k1 * p1 + k2 * p2 + 32) >> 6
        q = nibbles[i]
        d = q - 16 if q >= 8 else q                 # sign-extend 4-bit
        recon = clamp16((d << (12 - shift)) + pred)
        p1, p2 = recon, p1
    hdr = (shift & 0x0F) | (filt << 4)
    packed = bytearray(16)
    packed[0] = hdr
    packed[1] = flag
    for i in range(14):
        packed[2 + i] = (nibbles[2 * i] & 0x0F) | ((nibbles[2 * i + 1] & 0x0F) << 4)
    return bytes(packed), p1, p2

# ---- 5. assemble body: lead-in + loop ----------------------------------------
body = bytearray()
body += bytes(16)                                   # silent lead-in, flag 0x00
prev1 = prev2 = 0
nblocks = len(pcm) // 28
for bi in range(nblocks):
    blk = pcm[bi * 28:(bi + 1) * 28]
    if bi == 0:
        flag = 0x04                                 # loop start
    elif bi == nblocks - 1:
        flag = 0x03                                 # loop end + sustain
    else:
        flag = 0x00
    enc, prev1, prev2 = encode_block(blk, prev1, prev2, flag)
    body += enc

# ---- 6. write big-endian VAG header ------------------------------------------
name = NAME.encode("ascii")[:16].ljust(16, b"\0")
hdr = struct.pack(">4sIII I 12x 16s",
                  b"VAGp", 0x20, 0, len(body), TARGET_HZ, name)
with open(OUT, "wb") as f:
    f.write(hdr); f.write(body)

# ---- 7. round-trip decode + SNR ----------------------------------------------
def decode(body):
    out = []; s1 = s2 = 0
    for off in range(16, len(body), 16):   # skip lead-in
        b = body[off:off + 16]
        shift = b[0] & 0x0F; filt = b[0] >> 4
        k1, k2 = POS[filt], NEG[filt]
        for i in range(28):
            byte = b[2 + i // 2]
            n = (byte & 0x0F) if (i % 2 == 0) else (byte >> 4)
            d = n - 16 if n >= 8 else n
            sample = d << (12 - shift)
            pred = (k1 * s1 + k2 * s2 + 32) >> 6
            o = clamp16(sample + pred)
            out.append(o); s2 = s1; s1 = o
    return np.array(out, dtype=np.float64)

dec = decode(body)
ref = pcm.astype(np.float64)
m = min(len(dec), len(ref))
noise = dec[:m] - ref[:m]
snr = 10 * np.log10((ref[:m] ** 2).sum() / max(1e-9, (noise ** 2).sum()))
shifts = [body[o] & 0x0F for o in range(16, len(body), 16)]
filts  = [body[o] >> 4 for o in range(16, len(body), 16)]
print(f"OUT={OUT} rate={TARGET_HZ} loopSamples={L} blocks={nblocks}(+1 lead-in)")
print(f"body={len(body)} bytes ({len(body)/1024:.1f} KB SPU RAM)")
print(f"shift range={min(shifts)}..{max(shifts)}  filters={sorted(set(filts))}")
print(f"round-trip SNR={snr:.1f} dB")
print(f"lead-in flag=0x{body[1]:02x} firstbody=0x{body[17]:02x} last=0x{body[16*nblocks+1]:02x}")
