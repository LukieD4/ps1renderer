/**
 * quantizer.js
 * Median-cut color quantization: builds an N-color palette from an
 * RGBA pixel buffer, and maps arbitrary colors to their nearest
 * palette entry.
 */
(function (global) {
  /**
   * Build a palette of `colorCount` [r,g,b] entries from pixel data
   * using median-cut.
   * @param {Uint8ClampedArray} data - RGBA pixel buffer
   * @param {number} colorCount - target palette size (power of 2 typically)
   * @returns {number[][]} array of [r,g,b] 0-255
   */
  function buildPalette(data, colorCount) {
    // Collect distinct-ish pixels (sample if huge, to keep this fast)
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
      const rRange = bucketRange(bucket, 0);
      const gRange = bucketRange(bucket, 1);
      const bRange = bucketRange(bucket, 2);
      if (rRange >= gRange && rRange >= bRange) return 0;
      if (gRange >= rRange && gRange >= bRange) return 1;
      return 2;
    }

    const targetBuckets = Math.max(1, colorCount);

    while (buckets.length < targetBuckets) {
      // split the bucket with the largest population * range (biggest impact)
      let splitIdx = -1;
      let bestScore = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].length < 2) continue;
        const ch = widestChannel(buckets[i]);
        const score = bucketRange(buckets[i], ch) * buckets[i].length;
        if (score > bestScore) {
          bestScore = score;
          splitIdx = i;
        }
      }
      if (splitIdx === -1) break; // nothing left splittable

      const bucket = buckets[splitIdx];
      const channel = widestChannel(bucket);
      bucket.sort((a, b) => a[channel] - b[channel]);
      const mid = Math.floor(bucket.length / 2);
      const left = bucket.slice(0, mid);
      const right = bucket.slice(mid);

      buckets.splice(splitIdx, 1, left, right);
    }

    return buckets.map((bucket) => {
      let r = 0, g = 0, b = 0;
      for (const p of bucket) { r += p[0]; g += p[1]; b += p[2]; }
      const n = bucket.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  /**
   * Find the nearest palette entry (by squared Euclidean RGB distance).
   * @returns {number} index into palette
   */
  function nearestIndex(palette, r, g, b) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  global.BppQuantizer = { buildPalette, nearestIndex };
})(window);
