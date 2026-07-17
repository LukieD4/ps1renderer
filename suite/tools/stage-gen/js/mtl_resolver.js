/*
 * mtl_resolver.js
 *
 * A minimal, custom .mtl parser - deliberately NOT Three.js's MTLLoader.
 * MTLLoader expects to load ordinary image textures (PNG/JPG) via
 * TextureLoader and knows nothing about our project's convention that
 * every map_Kd path is actually a lie: it points at a filename with an
 * image-like extension (e.g. "textures/Grass0.png") but the real file
 * on disk is a PS1-native "textures/Grass0.tim" sitting next to it. We
 * need to intercept that path, extract just its filename, rewrite the
 * extension to .tim, resolve THAT against <model_dir>/textures/ (via
 * fs_assets.js), and run it through our own decodeTim() - none of which
 * MTLLoader can do.
 *
 * We only ever use the map_Kd path's FILENAME, never its directory
 * portion - real .mtl files from this pipeline have been observed with
 * meaningless directory prefixes (Blender dev/ working-file paths,
 * absolute machine-specific temp paths), none of which are resolvable or
 * relevant here. See toTimBasename()'s own comment for the full story.
 *
 * Parsing is intentionally minimal: we only care about `newmtl <name>`
 * block boundaries and `map_Kd <path>` lines within each block. Every
 * other .mtl directive (Ka, Kd, Ns, illum, ...) is ignored.
 */

import { resolveRelativePath } from './fs_assets.js';
import { decodeTim } from './tim_reader.js';

/**
 * Parse .mtl text into an array of { name, mapKd } entries.
 * mapKd may be null if the material has no map_Kd line.
 */
function parseMtlText(mtlText) {
  const materials = [];
  let current = null;

  const lines = mtlText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const directive = parts[0];

    if (directive === 'newmtl') {
      const name = parts.slice(1).join(' ');
      current = { name, mapKd: null };
      materials.push(current);
    } else if (directive === 'map_Kd' && current) {
      // Path is everything after the directive (whitespace-split, take
      // the last token as the path - simple .mtl files don't use options).
      const path = parts[parts.length - 1];
      current.mapKd = path.replace(/\\/g, '/');
    }
  }

  return materials;
}

/**
 * Given a map_Kd path, extract JUST the filename (basename) and rewrite its
 * extension to .tim, discarding any directory prefix entirely.
 *
 * This is deliberately more aggressive than "swap the extension and keep
 * the path" - real .mtl files from this pipeline have been observed with:
 *   - relative dev/-prefixed paths, e.g. "dev/textures/House0.tim" (a
 *     Blender working-file artifact - py_convert_assets.py's own model
 *     scanner treats dev/ subfolders as scratch space to be ignored, so
 *     this tool should too rather than trying to resolve into them)
 *   - full ABSOLUTE paths baked in by Blender's texture cache/export
 *     location, e.g. "C:/Users/.../AppData/Local/Temp/TEXTURES/Foo.tim"
 *     (meaningless once opened on a different machine or by this browser
 *     tool, which has no access to arbitrary absolute filesystem paths
 *     anyway - only to the picked assets folder tree)
 * Neither of those paths is resolvable (or even meaningful) relative to
 * the model's own directory handle. The one thing that IS always true,
 * per this project's documented convention, is that the intended texture
 * lives at <model_dir>/textures/<MaterialBasename>.tim - so rather than
 * trying to resolve whatever directory structure the .mtl happens to
 * contain, we throw all of it away except the filename and look it up
 * directly under textures/.
 */
function toTimBasename(mapKdPath) {
  const normalized = mapKdPath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop();
  return basename.replace(/\.[^.]+$/, '.tim');
}

/**
 * Resolve every material in an .mtl file to its decoded .tim texture data.
 *
 * `dirHandle` is the model's own directory handle (the .mtl's map_Kd paths
 * are relative to the model folder, e.g. "textures/Grass0.tim" resolves to
 * <dirHandle>/textures/Grass0.tim).
 *
 * Returns a Map<materialName, decodedTimData | null>. A null entry means
 * the material could not be resolved (missing map_Kd line, missing file,
 * or a decode failure) - this is logged via console.warn but does NOT
 * throw, so one broken material doesn't prevent the rest of the model
 * (and the rest of the stage) from loading.
 */
export async function resolveMaterials(dirHandle, mtlText) {
  const parsed = parseMtlText(mtlText);
  const result = new Map();

  for (const mat of parsed) {
    if (!mat.mapKd) {
      console.warn(`resolveMaterials: material "${mat.name}" has no map_Kd line, skipping`);
      result.set(mat.name, null);
      continue;
    }

    const timBasename = toTimBasename(mat.mapKd);
    const timPath = `textures/${timBasename}`;

    try {
      const fileHandle = await resolveRelativePath(dirHandle, timPath);
      if (!fileHandle) {
        console.warn(`resolveMaterials: material "${mat.name}" - could not resolve "${timPath}" (from map_Kd "${mat.mapKd}")`);
        result.set(mat.name, null);
        continue;
      }

      const file = await fileHandle.getFile();
      const arrayBuffer = await file.arrayBuffer();
      const decoded = decodeTim(arrayBuffer);

      // Diagnostic breadcrumb: dump the decoded header fields so a
      // texture that "loads" but renders wrong (blank, transparent,
      // scrambled) can be diagnosed from the console without needing a
      // debugger - e.g. clutHeight=0 or width/height being absurd
      // instantly points at a mis-parsed block offset for that specific
      // file, vs. every pixel legitimately decoding to black/transparent
      // (which would show a normal width/height/clutHeight but an
      // opaquePixelCount of 0).
      const opaquePixelCount = decoded.getRGBATextureForRow(0).reduce(
        (count, value, idx) => (idx % 4 === 3 && value > 0 ? count + 1 : count),
        0
      );
      console.log(
        `resolveMaterials: "${mat.name}" <- "${timPath}" decoded ` +
        `${decoded.width}x${decoded.height}, clutHeight=${decoded.clutHeight}, ` +
        `row0 opaque pixels=${opaquePixelCount}/${decoded.width * decoded.height}`
      );

      result.set(mat.name, decoded);
    } catch (err) {
      console.warn(`resolveMaterials: material "${mat.name}" - failed to decode "${timPath}": ${err.message}`);
      result.set(mat.name, null);
    }
  }

  return result;
}
