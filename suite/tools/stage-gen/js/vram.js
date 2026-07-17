/*
 * vram.js
 *
 * VRAM budget estimator for the sidebar "VRAM" panel.
 *
 * This deliberately mirrors py_convert_textures.py's packer 1:1 (same
 * constants, same shelf algorithm, same failure conditions) so the number
 * shown here is not an abstract "sum of texture bytes" but a faithful
 * prediction of what the real converter will do with the currently-loaded
 * textures - including running out of space in exactly the same cases the
 * converter would refuse to build.
 *
 * VRAM model (from py_convert_textures.py + main.c):
 *   - VRAM is 1024x512 16-bit units (2 bytes each).
 *   - x 0-639 is reserved for the framebuffers / display - never packed.
 *   - Texture image region: x 640-1023, y 0-399 (384x400 units). Images
 *     are shelf-packed sorted by height (tallest first), one rect PER
 *     TEXTURE FILE - palette variants share the image rect (stacked CLUT
 *     rows point at one image block).
 *   - CLUT strip: y 480-511 at x 0 (32 rows total). Each texture reserves
 *     clut_height CONSECUTIVE rows (one per palette), 16 units wide.
 *   - 4bpp: image_width_units = pixel_width / 4.
 *
 * Textures are deduplicated by name across models (the converter enforces
 * project-wide unique texture names, and the same Grass0.tim referenced by
 * two models is one VRAM upload, not two).
 */

// ---- constants mirrored from py_convert_textures.py ----
const VRAM_WIDTH = 1024;
const VRAM_HEIGHT = 512;

const TEX_REGION_X = 640;
const TEX_REGION_Y = 0;
const TEX_REGION_HEIGHT = 400; // leaves y:400-511 for the CLUT strip

const CLUT_REGION_Y = 480;
const CLUT_REGION_HEIGHT = VRAM_HEIGHT - CLUT_REGION_Y; // 32 rows

const BYTES_PER_UNIT = 2; // VRAM is 16-bit units

const TEX_REGION_WIDTH_UNITS = VRAM_WIDTH - TEX_REGION_X; // 384
const IMAGE_CAPACITY_BYTES = TEX_REGION_WIDTH_UNITS * TEX_REGION_HEIGHT * BYTES_PER_UNIT;
const CLUT_ROW_BYTES = 16 * BYTES_PER_UNIT; // one palette row = 16 units
const CLUT_CAPACITY_BYTES = CLUT_REGION_HEIGHT * CLUT_ROW_BYTES;

/**
 * Compute VRAM usage for every unique decoded texture across the given
 * models Map (state.models: modelName -> { materialsMap }).
 *
 * Returns {
 *   textures: [{ name, widthPx, height, widthUnits, clutRows, imageBytes, placed }],
 *   imageBytesUsed, imageBytesMax,
 *   clutRowsUsed, clutRowsMax, clutBytesUsed, clutBytesMax,
 *   totalBytesUsed, totalBytesMax,
 *   warnings: [string],
 * }
 */
export function computeVramUsage(models) {
  // Dedupe by texture/material name, exactly like the converter's
  // project-wide unique-name rule.
  const unique = new Map();
  for (const modelData of models.values()) {
    if (!modelData.materialsMap) continue;
    for (const [matName, decoded] of modelData.materialsMap.entries()) {
      if (!decoded || unique.has(matName)) continue;
      unique.set(matName, decoded);
    }
  }

  const textures = Array.from(unique.entries()).map(([name, decoded]) => ({
    name,
    widthPx: decoded.width,
    height: decoded.height,
    widthUnits: Math.ceil(decoded.width / 4), // 4bpp: 4 pixels per 16-bit unit
    clutRows: decoded.clutHeight,
    imageBytes: Math.ceil(decoded.width / 4) * decoded.height * BYTES_PER_UNIT,
    placed: false,
  }));

  const warnings = [];

  // ---- shelf packer, identical to pack_tims() ----
  const items = [...textures].sort((a, b) => b.height - a.height);

  let cursorX = TEX_REGION_X;
  let cursorY = TEX_REGION_Y;
  let shelfHeight = 0;
  const maxTexY = TEX_REGION_Y + TEX_REGION_HEIGHT;

  let clutCursorY = CLUT_REGION_Y;

  for (const item of items) {
    if (item.widthUnits > TEX_REGION_WIDTH_UNITS) {
      warnings.push(
        `"${item.name}" is wider (${item.widthUnits} units / ${item.widthPx}px) than the whole packing region (${TEX_REGION_WIDTH_UNITS} units) - the converter cannot place it.`
      );
    } else {
      if (cursorX + item.widthUnits > VRAM_WIDTH) {
        cursorX = TEX_REGION_X;
        cursorY += shelfHeight;
        shelfHeight = 0;
      }
      if (cursorY + item.height > maxTexY) {
        warnings.push(
          `Out of VRAM image space packing "${item.name}" (${item.widthUnits}x${item.height} units) - the converter would fail here. Reduce texture sizes/count.`
        );
      } else {
        item.placed = true;
        cursorX += item.widthUnits;
        shelfHeight = Math.max(shelfHeight, item.height);
      }
    }

    if (clutCursorY + item.clutRows > CLUT_REGION_Y + CLUT_REGION_HEIGHT) {
      warnings.push(
        `Out of CLUT rows placing "${item.name}" (needs ${item.clutRows}) - the 32-row CLUT strip is exhausted.`
      );
    } else {
      clutCursorY += item.clutRows;
    }
  }

  const imageBytesUsed = textures.reduce((sum, t) => sum + t.imageBytes, 0);
  const clutRowsUsed = textures.reduce((sum, t) => sum + t.clutRows, 0);
  const clutBytesUsed = clutRowsUsed * CLUT_ROW_BYTES;

  return {
    textures,
    imageBytesUsed,
    imageBytesMax: IMAGE_CAPACITY_BYTES,
    clutRowsUsed,
    clutRowsMax: CLUT_REGION_HEIGHT,
    clutBytesUsed,
    clutBytesMax: CLUT_CAPACITY_BYTES,
    totalBytesUsed: imageBytesUsed + clutBytesUsed,
    totalBytesMax: IMAGE_CAPACITY_BYTES + CLUT_CAPACITY_BYTES,
    warnings,
  };
}

/**
 * Human-readable byte count (VRAM sizes are small enough that KiB with
 * one decimal is always the right unit above 1024).
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
