/*
 * mtl_resolver.js
 *
 * TEXTURE RESOLVER (post-glTF migration).
 *
 * The toolchain moved off OBJ/MTL: glTF carries material NAMES inside the
 * model file, so there is no longer any .mtl to parse. This module now does
 * the one thing that survived that change - turning a material name into its
 * decoded PS1 .tim texture - directly from the name.
 *
 * Convention (identical to the PS1 C converter, py_convert_assets.py +
 * py_convert_textures.py): a material's texture lives at
 *     <model_dir>/textures/<materialName>.tim
 * and the runtime matches a model's material name against the texture blob's
 * name table by that same string. So the glTF material name IS the texture
 * base name - we resolve textures/<name>.tim and decode it, no indirection
 * through map_Kd paths.
 *
 * The old .mtl parser (parseMtlText/toTimBasename/resolveMaterials) is gone;
 * resolveMaterialsByNames() below is its replacement. The filename is kept so
 * existing imports don't churn - the module's JOB is unchanged (name -> tim),
 * only its INPUT (a list of names, not .mtl text) changed.
 */

import { resolveRelativePath } from './fs_assets.js';
import { decodeTim } from './tim_reader.js';

/**
 * Resolve a list of glTF material names to their decoded .tim texture data.
 *
 * `dirHandle` is the model's own directory handle; each name resolves to
 * <dirHandle>/textures/<name>.tim.
 *
 * Returns a Map<materialName, decodedTimData | null>. A null entry means the
 * material could not be resolved (missing file or a decode failure) - logged
 * via console.warn but never thrown, so one broken texture doesn't stop the
 * rest of the model (and the rest of the stage) from loading. The synthetic
 * "(none)" material that untextured glTF primitives carry is skipped up front
 * (it has no texture by definition).
 */
export async function resolveMaterialsByNames(dirHandle, materialNames) {
  const result = new Map();

  // De-dupe while preserving first-seen order - a model can reference the
  // same material on many primitives, but each .tim only needs decoding once.
  const uniqueNames = [...new Set(materialNames)];

  for (const name of uniqueNames) {
    if (!name || name === '(none)') {
      result.set(name, null);
      continue;
    }

    const timPath = `textures/${name}.tim`;

    try {
      const fileHandle = await resolveRelativePath(dirHandle, timPath);
      if (!fileHandle) {
        console.warn(`resolveMaterialsByNames: material "${name}" - could not resolve "${timPath}"`);
        result.set(name, null);
        continue;
      }

      const file = await fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const decoded = decodeTim(arrayBuffer);

      // Diagnostic breadcrumb (kept from the old resolver): a texture that
      // "loads" but renders wrong (blank/transparent/scrambled) can be
      // diagnosed from the console without a debugger - clutHeight=0 or an
      // absurd width/height points at a mis-parsed block offset for that
      // specific file, vs. an opaquePixelCount of 0 (every pixel legitimately
      // decoding to transparent).
      const opaquePixelCount = decoded.getRGBATextureForRow(0).reduce(
        (count, value, idx) => (idx % 4 === 3 && value > 0 ? count + 1 : count),
        0
      );
      console.log(
        `resolveMaterialsByNames: "${name}" <- "${timPath}" decoded ` +
        `${decoded.width}x${decoded.height}, clutHeight=${decoded.clutHeight}, ` +
        `row0 opaque pixels=${opaquePixelCount}/${decoded.width * decoded.height}`
      );

      result.set(name, decoded);
    } catch (err) {
      console.warn(`resolveMaterialsByNames: material "${name}" - failed to decode "${timPath}": ${err.message}`);
      result.set(name, null);
    }
  }

  return result;
}
