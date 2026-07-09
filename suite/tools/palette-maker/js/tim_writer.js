/**
 * ============================================================================
 * tim_writer.js
 *
 * Writes a COMPLETE, standalone 4bpp PS1 .tim file - header, CLUT block
 * (now supporting MULTIPLE stacked palettes), and indexed pixel data -
 * directly from this tool's own known color-to-index mapping (the same
 * `colours` array order used by clut.js/image.js).
 *
 * ----------------------------------------------------------------------
 * DESIGN A: multi-palette single TIM (this version)
 * ----------------------------------------------------------------------
 * A single TIM's CLUT block can hold MULTIPLE palettes stacked as extra
 * rows (clut_height > 1), all referring to the SAME image block. This is
 * the native PS1 convention for palette-swappable sprites/textures: pixel
 * data is stored ONCE, and different visual variants are selected purely
 * by pointing at a different CLUT row (clut_y + row_index) at draw time -
 * no pixel data duplication, unlike the earlier one-full-TIM-per-palette
 * approach this file used to take.
 *
 * This ONLY works because every palette passed to buildTim() is required
 * to share the exact same colorToIndex mapping (i.e. they're all
 * recolors of the SAME base image, with the same index assignment) -
 * that invariant is what makes "reuse this pixel data, just look up a
 * different row" valid. Passing palettes derived from different images,
 * or with different index orderings, will silently produce wrong colors -
 * this module does not and cannot verify that the palettes are consistent
 * with each other; that discipline is on the calling UI.
 *
 * Format reference (cross-checked against multiple independent TIM
 * format writeups - qhimm wiki, Klarth's TIM doc, justsolve.archiveteam.org,
 * Kaitai psx_tim spec - all agree on the layout below):
 *
 *   FILE HEADER (8 bytes)
 *     u32 magic = 0x00000010
 *     u32 flags            (bpp code in bits 0-1, CLUT-present in bit 3)
 *
 *   CLUT BLOCK (present because flags has the CLUT-present bit set)
 *     u32 clut_block_length   (includes this 12-byte sub-header)
 *     u16 clut_x              (VRAM X - must be a multiple of 16)
 *     u16 clut_y              (VRAM Y of ROW 0 - row k lives at clut_y + k)
 *     u16 clut_width          (in 16-bit units - 16 for one 4bpp palette)
 *     u16 clut_height         (NUMBER OF STACKED PALETTES - was hardcoded
 *                              to 1 before; now equals palettes.length)
 *     <clut_width * clut_height * 2> bytes: palette 0's 16 colors, then
 *       palette 1's 16 colors, then palette 2's, etc, row-major - each
 *       row is one complete, independently-selectable palette.
 *
 *   IMAGE BLOCK (same shape as the CLUT block - written ONCE, shared by
 *   every palette row above)
 *     u32 image_block_length  (includes this 12-byte sub-header)
 *     u16 image_x             (VRAM X)
 *     u16 image_y             (VRAM Y)
 *     u16 image_width         (in 16-bit units - real_pixel_width / 4 for 4bpp)
 *     u16 image_height        (actual pixel height, NOT divided)
 *     <image_width * image_height * 2> bytes of packed 4-bit indices
 *       (2 pixels per byte, FIRST pixel in the HIGH nibble, per Klarth's
 *       doc and justsolve's writeup, which agree with each other)
 *
 * All multi-byte header fields are little-endian (confirmed by every
 * source above). This module only supports 4bpp - that's the only mode
 * relevant to this project's palette-swap workflow.
 * ============================================================================
 */
(function (global) {
    "use strict";

    const TIM_MAGIC = 0x00000010;
    const BPP_4BIT = 0x0; // bits 0-1 of the flags word
    const CLUT_PRESENT_BIT = 0x8;
    const COLORS_PER_PALETTE = 16; // fixed for 4bpp

    function packColor(r, g, b, preventTransparency) {
        const r5 = Math.floor(r / 8) & 0x1F;
        const g5 = Math.floor(g / 8) & 0x1F;
        const b5 = Math.floor(b / 8) & 0x1F;

        let stp = 0;
        if (r5 === 0 && g5 === 0 && b5 === 0 && preventTransparency !== false) {
            stp = 1;
        }

        return (stp << 15) | (b5 << 10) | (g5 << 5) | r5;
    }

    function buildIndexArray(imageData, colorToIndex) {
        const pixels = imageData.data;
        const pixelCount = imageData.width * imageData.height;
        const indices = new Uint8Array(pixelCount);
        let unmatchedPixelCount = 0;

        for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
            const alpha = pixels[i + 3];

            if (alpha === 0) {
                indices[p] = 0;
                continue;
            }

            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const key = (r << 16) | (g << 8) | b;

            const idx = colorToIndex.get(key);

            if (idx === undefined) {
                indices[p] = 0;
                unmatchedPixelCount++;
                continue;
            }

            if (idx > 15) {
                throw new Error(
                    `Color index ${idx} exceeds 4bpp range (0-15) - ` +
                    `source image has more than 16 unique colors, or ` +
                    `the palette was built from a different image.`
                );
            }

            indices[p] = idx;
        }

        return { indices, unmatchedPixelCount };
    }

    function packIndicesTo4bpp(indices, width, height) {
        const bytesPerRow = Math.ceil(width / 2);
        const packed = new Uint8Array(bytesPerRow * height);

        for (let y = 0; y < height; y++) {
            for (let xByte = 0; xByte < bytesPerRow; xByte++) {
                const x0 = xByte * 2;
                const x1 = x0 + 1;

                const i0 = y * width + x0;
                const i1 = y * width + x1;

                const p0 = indices[i0] & 0x0F;
                const p1 = (x1 < width) ? (indices[i1] & 0x0F) : 0;

                packed[y * bytesPerRow + xByte] = (p0 << 4) | p1;
            }
        }

        return packed;
    }

    function writeU16LE(view, offset, value) {
        view.setUint16(offset, value, true);
    }

    function writeU32LE(view, offset, value) {
        view.setUint32(offset, value, true);
    }

    function normalizePaletteColours(palette) {
        const paletteSize = palette.size ? palette.size() : palette.colours.length;
        if (paletteSize > COLORS_PER_PALETTE) {
            throw new Error(
                `Palette has ${paletteSize} colors - 4bpp supports a ` +
                `maximum of ${COLORS_PER_PALETTE}. Reduce the source ` +
                `image's color count first.`
            );
        }

        const colours = [];
        for (let i = 0; i < COLORS_PER_PALETTE; i++) {
            colours.push(i < paletteSize ? palette.colours[i] : { r: 0, g: 0, b: 0 });
        }
        return colours;
    }

    function buildTim(params) {
        const {
            imageData,
            palettes,
            colorToIndex,
            vramX,
            vramY,
            clutX,
            clutY,
            preventTransparency,
        } = params;

        if (!Array.isArray(palettes) || palettes.length === 0) {
            throw new Error(
                "palettes must be a non-empty array - pass [palette] for " +
                "a single-palette TIM, or [palette0, palette1, ...] to " +
                "stack multiple selectable palettes in one file."
            );
        }

        if (clutX % 16 !== 0) {
            throw new Error(
                `clutX (${clutX}) must be a multiple of 16 - PS1 hardware ` +
                `requirement for CLUT placement, not a project convention.`
            );
        }

        const clutHeight = palettes.length;
        if (clutY + clutHeight > 512) {
            throw new Error(
                `clutY (${clutY}) + palette count (${clutHeight}) exceeds ` +
                `VRAM height (512) - stacked CLUT rows would run off the ` +
                `bottom of VRAM.`
            );
        }

        const normalizedPalettes = palettes.map(normalizePaletteColours);

        const { indices, unmatchedPixelCount } = buildIndexArray(imageData, colorToIndex);

        if (unmatchedPixelCount > 0) {
            console.warn(
                `buildTim: ${unmatchedPixelCount} pixel(s) did not match any ` +
                `color in the supplied palette and were written as index 0. ` +
                `This usually means colorToIndex wasn't built from this ` +
                `exact image (e.g. anti-aliased edges introduced extra ` +
                `colors not in the 16-color set).`
            );
        }

        const packedPixels = packIndicesTo4bpp(indices, imageData.width, imageData.height);

        const clutDataBytes = COLORS_PER_PALETTE * clutHeight * 2;
        const clutBlockLength = 12 + clutDataBytes;

        const imageWidthUnits = Math.ceil(imageData.width / 4);
        const imageHeightPixels = imageData.height;
        const imageDataBytes = imageWidthUnits * imageHeightPixels * 2;
        const imageBlockLength = 12 + imageDataBytes;

        const totalLength = 8 + clutBlockLength + imageBlockLength;
        const buffer = new ArrayBuffer(totalLength);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        let offset = 0;

        writeU32LE(view, offset, TIM_MAGIC); offset += 4;
        writeU32LE(view, offset, CLUT_PRESENT_BIT | BPP_4BIT); offset += 4;

        writeU32LE(view, offset, clutBlockLength); offset += 4;
        writeU16LE(view, offset, clutX); offset += 2;
        writeU16LE(view, offset, clutY); offset += 2;
        writeU16LE(view, offset, COLORS_PER_PALETTE); offset += 2;
        writeU16LE(view, offset, clutHeight); offset += 2;

        for (let row = 0; row < clutHeight; row++) {
            const colours = normalizedPalettes[row];
            for (let i = 0; i < COLORS_PER_PALETTE; i++) {
                const c = colours[i];
                const packed = packColor(c.r, c.g, c.b, preventTransparency);
                writeU16LE(view, offset, packed); offset += 2;
            }
        }

        writeU32LE(view, offset, imageBlockLength); offset += 4;
        writeU16LE(view, offset, vramX); offset += 2;
        writeU16LE(view, offset, vramY); offset += 2;
        writeU16LE(view, offset, imageWidthUnits); offset += 2;
        writeU16LE(view, offset, imageHeightPixels); offset += 2;

        bytes.set(packedPixels, offset);
        offset += packedPixels.length;

        return {
            buffer,
            unmatchedPixelCount,
            imageWidthUnits,
            imageHeightPixels,
            clutHeight,
            paletteRowYCoords: normalizedPalettes.map((_, i) => clutY + i),
        };
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
        URL.revokeObjectURL(url);

        return result;
    }

    global.PaletteTim = {
        buildTim,
        exportTim,
        _internal: { packColor, buildIndexArray, packIndicesTo4bpp, normalizePaletteColours },
    };

})(window);