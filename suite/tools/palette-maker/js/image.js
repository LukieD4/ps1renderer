/**
 * ============================================================================
 * image.js
 *
 * Image loading and colour extraction.
 *
 * Responsibilities:
 *
 *  • Load an image file
 *  • Draw it onto a canvas
 *  • Extract every unique RGB colour
 *  • Preserve first appearance order
 *
 * No UI logic belongs here.
 * ============================================================================
 */

(function (global) {

    "use strict";

    /**
     * Load an image File into an off-screen canvas.
     *
     * Returns:
     *
     * {
     *     canvas,
     *     width,
     *     height,
     *     imageData
     * }
     */
    async function loadImage(file) {

        return new Promise((resolve, reject) => {

            const reader = new FileReader();

            reader.onload = event => {

                const image = new Image();

                image.onload = () => {

                    const canvas = document.createElement("canvas");

                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;

                    const ctx = canvas.getContext("2d");

                    ctx.drawImage(image, 0, 0);

                    resolve({

                        canvas,

                        width: canvas.width,

                        height: canvas.height,

                        imageData: ctx.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        )

                    });

                };

                image.onerror = () =>
                    reject(new Error("Unable to decode image."));

                image.src = event.target.result;

            };

            reader.onerror = () =>
                reject(new Error("Unable to read file."));

            reader.readAsDataURL(file);

        });

    }

    //========================================================================

    /**
     * Extract every unique RGB colour.
     *
     * Returns:
     *
     * [
     *     { r,g,b,count },
     *     ...
     * ]
     *
     * Colours remain in first-seen order.
     */

    function extractColours(imageData) {

        const pixels = imageData.data;

        const map = new Map();

        const colours = [];

        for (let i = 0; i < pixels.length; i += 4) {

            const alpha = pixels[i + 3];

            //
            // Ignore completely transparent pixels.
            //

            if (alpha === 0)
                continue;

            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];

            //
            // Pack RGB into one integer.
            //

            const key =
                (r << 16) |
                (g << 8) |
                b;

            const existing = map.get(key);

            if (existing !== undefined) {

                colours[existing].count++;

                continue;

            }

            map.set(key, colours.length);

            colours.push({

                r,

                g,

                b,

                count: 1

            });

        }

        return colours;

    }

    //========================================================================

    /**
     * Draw canvas onto another canvas.
     */

    function drawPreview(sourceCanvas, targetCanvas) {

        targetCanvas.width = sourceCanvas.width;
        targetCanvas.height = sourceCanvas.height;

        const ctx = targetCanvas.getContext("2d");

        ctx.imageSmoothingEnabled = false;

        ctx.clearRect(
            0,
            0,
            targetCanvas.width,
            targetCanvas.height
        );

        ctx.drawImage(sourceCanvas, 0, 0);

    }

    /**
     * Builds a Map from packed (r<<16)|(g<<8)|b colour key to palette index,
     * using the ORIGINAL palette's colour order. This is the single source
     * of truth for "what index does this colour map to" - both the preview
     * remap and tim_writer.js's pixel-index export must build this the same
     * way, or palette swaps and exported CLUT/TIM data will disagree.
     */
    function buildColorToIndexMap(originalPalette) {
        const colorToIndex = new Map();
        originalPalette.colours.forEach((c, idx) => {
            const key = (c.r << 16) | (c.g << 8) | c.b;
            colorToIndex.set(key, idx);
        });
        return colorToIndex;
    }

    /**
     * Re-maps pixels from a source canvas onto a target canvas using a modified active palette.
     */
    function drawRemappedPreview(sourceCanvas, targetCanvas, originalPalette, activePalette) {

        targetCanvas.width = sourceCanvas.width;
        targetCanvas.height = sourceCanvas.height;

        const ctx = targetCanvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sourceCanvas, 0, 0);

        const imgData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
        const pixels = imgData.data;

        // Map original color RGB space integers to their respective index allocations
        const colorToIndex = buildColorToIndexMap(originalPalette);

        // Mutate matching pixels
        for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] === 0) continue; // Skip transparency channels

            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const key = (r << 16) | (g << 8) | b;

            const idx = colorToIndex.get(key);
            if (idx !== undefined) {
                // Use adjusted color generation if available, fallback to default base
                const newColor = activePalette.getAdjusted ? activePalette.getAdjusted(idx) : activePalette.get(idx);
                if (newColor) {
                    pixels[i] = newColor.r;
                    pixels[i + 1] = newColor.g;
                    pixels[i + 2] = newColor.b;
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);

    }

    //========================================================================

    global.PaletteImage = {

        loadImage,

        extractColours,

        drawPreview,

        drawRemappedPreview,

        buildColorToIndexMap

    };

})(window);