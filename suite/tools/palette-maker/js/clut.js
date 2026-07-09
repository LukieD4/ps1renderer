/**
 * ============================================================================
 * clut.js
 *
 * PS1 Native 16-bit CLUT Export (STP | BBBBB | GGGGG | RRRRR)
 * ============================================================================
 */

(function (global) {

    "use strict";

    /**
     * Converts a ColourPalette object into a raw binary PS1 CLUT array.
     * * PS1 Color Format (16-bit):
     * Bit 15: STP (Semi-Transparency / Sprite transparency override)
     * Bits 10-14: Blue (5 bits)
     * Bits 5-9:  Green (5 bits)
     * Bits 0-4:  Red (5 bits)
     */
    function exportBinaryClut(palette, baseFileName) {

        if (!palette || palette.size() === 0) return;

        const clutBuffer = new Uint16Array(palette.size());

        palette.colours.forEach((colour, index) => {

            // User transparency choice
            let preventTransparency = palette.preventTransparency !== false;

            // Downsample 8-bit channels (0-255) to 5-bit channels (0-31)
            let r5 = Math.floor(colour.r / 8) & 0x1F;
            let g5 = Math.floor(colour.g / 8) & 0x1F;
            let b5 = Math.floor(colour.b / 8) & 0x1F;
            let stp = 0;

            // PS1 Hazard Prevention: 0x0000 is hardwired as transparent black.
            // If the downsampled color maps to pure black but was meant to be opaque,
            // we toggle the STP bit to 1 so the hardware renders it as visible black unless the user specified not to.
            if (r5 === 0 && g5 === 0 && b5 === 0 && preventTransparency) {
                stp = 1;
            }

            // Pack into 16-bit short: STP | B(5) | G(5) | R(5)
            const packed16 = (stp << 15) | (b5 << 10) | (g5 << 5) | r5;
            clutBuffer[index] = packed16;

        });

        // Trigger binary blob download
        const blob = new Blob([clutBuffer.buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);

        // Inherit the source image's base filename when available, falling
        // back to the palette name so exports always feel tied to their asset.
        const name = (baseFileName && baseFileName.trim())
            ? baseFileName
            : palette.name.toLowerCase().replace(/\s+/g, "-");

        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.bin`;

        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    }

    global.PaletteClut = {
        exportBinaryClut
    };

})(window);