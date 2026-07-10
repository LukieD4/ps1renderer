/*
 * tim_reader.js
 *
 * Decodes a PS1 native ".tim" texture file (as an ArrayBuffer) into RGBA
 * pixel data usable by Three.js DataTextures.
 *
 * ----------------------------------------------------------------------
 * TIM binary format (4bpp / CLUT variant, exactly what this pipeline uses)
 * ----------------------------------------------------------------------
 * Offset 0x00: 4 bytes magic (0x00000010)
 * Offset 0x04: 4 bytes flags (bpp code bits 0-1, CLUT-present bit 0x8)
 * -- CLUT BLOCK --
 * 0x08: 4 bytes clut_block_length (includes this 12-byte sub-header)
 * 0x0C: 2 bytes clut_x (VRAM X)
 * 0x0E: 2 bytes clut_y (VRAM Y of row 0)
 * 0x10: 2 bytes clut_width (16 = one row's color count)
 * 0x12: 2 bytes clut_height (N = number of stacked palette rows) <-- critical
 * 0x14: 32*N bytes CLUT color data, N rows x 16 colors x 2 bytes each, row-major
 * -- IMAGE BLOCK (starts right after CLUT block, i.e. at 0x08 + clut_block_length) --
 * +0: 4 bytes image_block_length (includes this 12-byte sub-header)
 * +4: 2 bytes image_x
 * +6: 2 bytes image_y
 * +8: 2 bytes image_width (in 16-bit units = pixel_width/4, since 4bpp = 4 pixels per 16-bit unit)
 * +10: 2 bytes image_height (actual pixel height)
 * +12: packed pixel data, 4 bits per pixel, 2 pixels per byte, FIRST pixel in the HIGH nibble
 *
 * All multi-byte fields are little-endian.
 *
 * One CLUT color entry is a 16-bit PS1 color:
 *   bit15       = STP (semi-transparency flag)
 *   bits14-10   = BLUE  (5 bits)
 *   bits9-5     = GREEN (5 bits)
 *   bits4-0     = RED   (5 bits)
 * Each 5-bit channel is expanded to 8-bit via (v << 3) | (v >> 2).
 * Special case: if STP is 0 AND the color is pure black (r=g=b=0), the
 * color is treated as fully transparent (alpha=0) - this is the PS1's
 * "black = transparent" convention for non-STP pixels. Otherwise alpha=255.
 *
 * A single .tim can contain multiple stacked CLUT rows (clutHeight = N);
 * each row is an alternate palette for the same indexed pixel data. This
 * is how this toolchain implements "PS1 palette swaps" per object
 * instance (the `palette` field in scene.json selects which row to use).
 */

/**
 * Expand a 5-bit PS1 color channel to 8-bit.
 */
function expand5to8(v) {
  return (v << 3) | (v >> 2);
}

/**
 * Decode one 16-bit PS1 color entry (read via DataView.getUint16, LE) into
 * [r, g, b, a] 8-bit channels.
 */
function decodeColor16(word) {
  const stp = (word >> 15) & 0x1;
  const b5 = (word >> 10) & 0x1f;
  const g5 = (word >> 5) & 0x1f;
  const r5 = word & 0x1f;

  const r = expand5to8(r5);
  const g = expand5to8(g5);
  const b = expand5to8(b5);

  let a = 255;
  if (stp === 0 && r === 0 && g === 0 && b === 0) {
    a = 0;
  }

  return [r, g, b, a];
}

/**
 * Decode a full .tim file ArrayBuffer.
 *
 * Returns:
 * {
 *   clutHeight,               // N, number of palette rows available
 *   width,                    // pixel width
 *   height,                   // pixel height
 *   indices: Uint8Array,      // flat width*height array of palette indices (0-15)
 *   clutRows: Uint8Array[],   // N entries, each a 64-byte RGBA row (16 colors * 4 bytes)
 *   getRGBATextureForRow(row) // decode `indices` against clutRows[row] -> Uint8ClampedArray
 * }
 */
export function decodeTim(arrayBuffer) {
  const view = new DataView(arrayBuffer);

  const magic = view.getUint32(0x00, true);
  if (magic !== 0x00000010) {
    console.warn(`decodeTim: unexpected magic 0x${magic.toString(16)} (expected 0x00000010)`);
  }

  // -- CLUT block --
  const clutBlockLength = view.getUint32(0x08, true);
  const clutWidth = view.getUint16(0x10, true); // expected 16
  const clutHeight = view.getUint16(0x12, true); // N palette rows

  const clutDataOffset = 0x14;
  const clutRows = [];
  for (let row = 0; row < clutHeight; row++) {
    const rowRGBA = new Uint8Array(clutWidth * 4);
    for (let col = 0; col < clutWidth; col++) {
      const wordOffset = clutDataOffset + (row * clutWidth + col) * 2;
      const word = view.getUint16(wordOffset, true);
      const [r, g, b, a] = decodeColor16(word);
      rowRGBA[col * 4 + 0] = r;
      rowRGBA[col * 4 + 1] = g;
      rowRGBA[col * 4 + 2] = b;
      rowRGBA[col * 4 + 3] = a;
    }
    clutRows.push(rowRGBA);
  }

  // -- Image block: starts right after the CLUT block --
  const imageBlockStart = 0x08 + clutBlockLength;
  const imageWidthField = view.getUint16(imageBlockStart + 8, true); // in 16-bit units
  const imageHeight = view.getUint16(imageBlockStart + 10, true);
  const imageWidth = imageWidthField * 4; // 4bpp = 4 pixels per 16-bit unit

  const pixelDataOffset = imageBlockStart + 12;
  const indices = new Uint8Array(imageWidth * imageHeight);

  let pixelCursor = 0;
  const totalPixels = imageWidth * imageHeight;
  const totalBytes = Math.ceil(totalPixels / 2);

  for (let byteIdx = 0; byteIdx < totalBytes; byteIdx++) {
    const byte = view.getUint8(pixelDataOffset + byteIdx);
    const highNibble = (byte >> 4) & 0x0f; // first pixel
    const lowNibble = byte & 0x0f; // second pixel

    if (pixelCursor < totalPixels) {
      indices[pixelCursor] = highNibble;
      pixelCursor++;
    }
    if (pixelCursor < totalPixels) {
      indices[pixelCursor] = lowNibble;
      pixelCursor++;
    }
  }

  function getRGBATextureForRow(row) {
    const clampedRow = Math.max(0, Math.min(clutHeight - 1, row));
    const clutRow = clutRows[clampedRow];
    const out = new Uint8ClampedArray(imageWidth * imageHeight * 4);

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const srcOffset = idx * 4;
      const dstOffset = i * 4;
      out[dstOffset + 0] = clutRow[srcOffset + 0];
      out[dstOffset + 1] = clutRow[srcOffset + 1];
      out[dstOffset + 2] = clutRow[srcOffset + 2];
      out[dstOffset + 3] = clutRow[srcOffset + 3];
    }

    return out;
  }

  return {
    clutHeight,
    width: imageWidth,
    height: imageHeight,
    indices,
    clutRows,
    getRGBATextureForRow,
  };
}
