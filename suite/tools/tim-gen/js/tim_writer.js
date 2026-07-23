/**
 * tim_writer.js
 * Writes a standalone PS1 .tim file — header, one CLUT block with N stacked
 * palette rows, and one shared indexed image block. Supports BOTH 4bpp
 * (16-color rows) and 8bpp (256-color rows).
 *
 * Key difference from the old PaletteGen writer: this is fed the REAL index
 * buffer produced by Tab 1's quantizer, so there is no RGB re-matching and no
 * "unmatched pixel" guesswork — the pixels are already indices.
 *
 * Layout (little-endian), per the qhimm/Klarth/justsolve/Kaitai TIM specs:
 *   FILE HEADER (8)
 *     u32 magic  = 0x00000010
 *     u32 flags  = bpp code (bits 0-1: 0=4bpp, 1=8bpp) | 0x8 (CLUT present)
 *   CLUT BLOCK
 *     u32 length (incl 12-byte sub-header)
 *     u16 clut_x (mult of 16)   u16 clut_y (row 0)
 *     u16 clut_width  = colors per palette (16 or 256, in 16-bit units)
 *     u16 clut_height = number of stacked palettes
 *     <colors * height * 2> bytes, row-major (palette 0, then 1, ...)
 *   IMAGE BLOCK
 *     u32 length (incl 12-byte sub-header)
 *     u16 image_x   u16 image_y
 *     u16 image_width  = pixel_width / 4 (4bpp) or / 2 (8bpp), in 16-bit units
 *     u16 image_height = actual pixel height
 *     <width_units * height * 2> bytes of packed indices
 *       4bpp: 2 px/byte, FIRST pixel in the HIGH nibble
 *       8bpp: 1 px/byte
 *
 * Exposed as window.TG.tim.
 */
(function (global) {
  "use strict";
  const TG = (global.TG = global.TG || {});
  const { packPs1 } = TG.color;

  const TIM_MAGIC = 0x00000010;
  const CLUT_PRESENT_BIT = 0x8;

  function colorsForBpp(bpp) { return bpp === 8 ? 256 : 16; }
  function bppCode(bpp) { return bpp === 8 ? 0x1 : 0x0; }

  function normalizeRow(colours, colorsPerPalette) {
    if (colours.length > colorsPerPalette) {
      throw new Error(`Palette has ${colours.length} colors but ${colorsPerPalette === 16 ? "4bpp" : "8bpp"} allows ${colorsPerPalette}.`);
    }
    const out = [];
    for (let i = 0; i < colorsPerPalette; i++) out.push(colours[i] || { r: 0, g: 0, b: 0 });
    return out;
  }

  function packIndices(indices, width, height, bpp) {
    if (bpp === 8) {
      const units = Math.ceil(width / 2);        // 2 px per 16-bit unit
      const bytesPerRow = units * 2;             // 1 byte per pixel, padded to unit
      const packed = new Uint8Array(bytesPerRow * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < bytesPerRow; x++) {
          packed[y * bytesPerRow + x] = x < width ? indices[y * width + x] & 0xff : 0;
        }
      }
      return { packed, units };
    }
    // 4bpp
    const units = Math.ceil(width / 4);          // 4 px per 16-bit unit
    const bytesPerRow = units * 2;               // 2 px per byte
    const packed = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
      for (let xByte = 0; xByte < bytesPerRow; xByte++) {
        const x0 = xByte * 2, x1 = x0 + 1;
        const p0 = x0 < width ? indices[y * width + x0] & 0x0f : 0;
        const p1 = x1 < width ? indices[y * width + x1] & 0x0f : 0;
        packed[y * bytesPerRow + xByte] = (p0 << 4) | p1;
      }
    }
    return { packed, units };
  }

  /**
   * @param {object} p
   *   indices:Uint8Array, width, height, bpp(4|8),
   *   palettes:[[{r,g,b}...], ...]  already baked (slider/lock flattened),
   *   clutX, clutY, vramX, vramY, preventTransparency
   */
  function buildTim(p) {
    const colorsPerPalette = colorsForBpp(p.bpp);
    if (!Array.isArray(p.palettes) || p.palettes.length === 0) {
      throw new Error("Need at least one palette to export a .tim.");
    }
    if ((p.clutX || 0) % 16 !== 0) throw new Error(`clutX (${p.clutX}) must be a multiple of 16 (PS1 hardware requirement).`);

    const clutHeight = p.palettes.length;
    if ((p.clutY || 0) + clutHeight > 512) {
      throw new Error(`clutY (${p.clutY}) + ${clutHeight} palette row(s) would run past VRAM's 512 lines.`);
    }

    const rows = p.palettes.map((row) => normalizeRow(row, colorsPerPalette));
    const { packed, units } = packIndices(p.indices, p.width, p.height, p.bpp);

    const clutDataBytes = colorsPerPalette * clutHeight * 2;
    const clutBlockLength = 12 + clutDataBytes;
    const imageDataBytes = units * p.height * 2;
    const imageBlockLength = 12 + imageDataBytes;
    const totalLength = 8 + clutBlockLength + imageBlockLength;

    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let o = 0;
    const u16 = (v) => { view.setUint16(o, v, true); o += 2; };
    const u32 = (v) => { view.setUint32(o, v, true); o += 4; };

    u32(TIM_MAGIC);
    u32(CLUT_PRESENT_BIT | bppCode(p.bpp));

    u32(clutBlockLength);
    u16(p.clutX || 0);
    u16(p.clutY || 0);
    u16(colorsPerPalette);
    u16(clutHeight);
    for (let row = 0; row < clutHeight; row++) {
      const cols = rows[row];
      for (let i = 0; i < colorsPerPalette; i++) u16(packPs1(cols[i], p.preventTransparency));
    }

    u32(imageBlockLength);
    u16(p.vramX || 0);
    u16(p.vramY || 0);
    u16(units);
    u16(p.height);
    bytes.set(packed, o);
    o += packed.length;

    return { buffer, clutHeight, imageWidthUnits: units, imageHeightPixels: p.height, bpp: p.bpp };
  }

  function exportTim(params, fileName) {
    const result = buildTim(params);
    const blob = new Blob([result.buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.endsWith(".tim") ? fileName : `${fileName}.tim`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return result;
  }

  TG.tim = { buildTim, exportTim, colorsForBpp };
})(window);
