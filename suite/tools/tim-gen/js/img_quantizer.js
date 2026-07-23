/**
 * img_quantizer.js  (Tab 1)
 * Median-cut color quantization, ported from the old BPP tool. Works in
 * [r,g,b] arrays internally for speed; the pipeline converts the result to
 * the canonical {r,g,b} base palette at the boundary.
 *
 * Exposed as window.TG.quantizer.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});

  function buildPalette(data, colorCount) {
    const pixels = [];
    const total = data.length / 4;
    const step = total > 60000 ? Math.floor(total / 60000) : 1;
    for (let i = 0; i < total; i += step) {
      const idx = i * 4;
      if (data[idx + 3] < 8) continue; // skip near-fully-transparent
      pixels.push([data[idx], data[idx + 1], data[idx + 2]]);
    }
    if (pixels.length === 0) return [[0, 0, 0]];

    let buckets = [pixels];

    function bucketRange(bucket, channel) {
      let min = 255, max = 0;
      for (const p of bucket) {
        if (p[channel] < min) min = p[channel];
        if (p[channel] > max) max = p[channel];
      }
      return max - min;
    }
    function widestChannel(bucket) {
      const r = bucketRange(bucket, 0), g = bucketRange(bucket, 1), b = bucketRange(bucket, 2);
      if (r >= g && r >= b) return 0;
      if (g >= r && g >= b) return 1;
      return 2;
    }

    const targetBuckets = Math.max(1, colorCount);
    while (buckets.length < targetBuckets) {
      let splitIdx = -1, bestScore = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].length < 2) continue;
        const ch = widestChannel(buckets[i]);
        const score = bucketRange(buckets[i], ch) * buckets[i].length;
        if (score > bestScore) { bestScore = score; splitIdx = i; }
      }
      if (splitIdx === -1) break;
      const bucket = buckets[splitIdx];
      const channel = widestChannel(bucket);
      bucket.sort((a, b) => a[channel] - b[channel]);
      const mid = Math.floor(bucket.length / 2);
      buckets.splice(splitIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
    }

    return buckets.map((bucket) => {
      let r = 0, g = 0, b = 0;
      for (const p of bucket) { r += p[0]; g += p[1]; b += p[2]; }
      const n = bucket.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function nearestIndex(palette, r, g, b) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestIdx;
  }

  TG.quantizer = { buildPalette, nearestIndex };
})(window);
