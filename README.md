<p align="center">
  <img src="https://github.com/user-attachments/assets/76555e37-beda-4315-a491-6deab2ade4bf" height="250" />
  <img src="https://github.com/user-attachments/assets/d1663f86-dcb7-4632-a6e1-de1c8c2f732a" height="250" />
</p>


Dates are approximate and represent when a feature first landed in the project.
| Status | Feature | First Landed* | Notes |
|:------:|---------|:-------------:|-------|
| ✅ | Wireframe | ~24-05-2026 | |
| ✅ | Filled polygons | ~24-06-2026 | |
| ✅ | OBJ importer | ~25-06-2026 | |
| ✅ | XYZ rotation | ~25-06-2026 | RotMatrix + gte_SetRotMatrix |
| ✅ | Perspective | ~26-06-2026 | gte_stsxy3 / gte_SetGeomScreen, live FOV via pad |
| ✅ | Backface culling | ~26-06-2026 | gte_nclip + gte_stopz |
| ✅ | Flat lighting | ~27-06-2026 | GTE-rotated face normals, directional + ambient |
| ✅ | Painter's Algorithm | ~27-06-2026 | sort_model(): per-tri GTE avsz3, insertion sort back-to-front |
| ✅ | GTE transforms | ~27-06-2026 | Rotation, projection, normals, backface cull all GTE-driven |
| ✅ | Vertex lighting | ~27-06-2026 | Gouraud via POLY_G3, per-vertex normal rotation in update_matrix() |
| ✅ | Texture coordinates | ~28-06-2026 | modelUVs[], emitted by py_convert_assets.py from OBJ vt, split-vertex space |
| ✅ | TIM loader | ~28-06-2026 | load_texture(): GetTimInfo + LoadImage for pixel + CLUT |
| ✅ | Textured polygons | ~28-06-2026 | POLY_FT3 path in draw_model(), TPAGE/CLUT resolved once at load |
| ✅ | Input edge detection | ~30-06-2026 | Toggle buttons (TRIANGLE/SQUARE) now edge-triggered, not held-repeat |
| ✅ | Asset pipeline restructure | ~06-07-2026 | Per-object folders (assets/<obj>/<obj>.obj/.mtl[/textures]), flat generated/ output |
| ✅ | Build system fix | ~06-07-2026 | CMake DEPENDS keyed off source .obj/.mtl/.png + scripts, not generated output; stamp file for convert_assets |
| ✅ | Multi-material support | ~07-07-2026 | py_convert_assets.py parses usemtl, emits real per-triangle material indices + per-model modelMaterialNames[] table |
| ✅ | Multi-texture table | ~07-07-2026 | main.c builds textureTable[] from the blob at load; draw_model() resolves tri->material by name instead of one global faceTexture |
| ✅ | Per-triangle texture/flat dispatch | ~07-07-2026 | triTexture[] cache built once at load (build_triangle_texture_cache()); untextured materials fall back to flat/Gouraud per-triangle, not via one global toggle |
| ✅ | Texture blob + header table | ~07-07-2026 | tex_blob.S (fixed .incbin) + generated tex_blob_table.c (name/offset/length); adding textures touches zero hand-written files |
| ✅ | Asset pipeline: auto-discover textures | ~08-07-2026 | py_convert_textures.py walks assets/*/textures/*.png; filename stem = material name, TEXTURES list removed entirely |
| ✅ | Asset pipeline: auto VRAM packer | ~08-07-2026 | Shelf packer in py_convert_textures.py; reads real PNG dimensions, hard-fails on budget overrun instead of silently overlapping |
| ✅ | Camera | ~08-07-2026 | CAMERA struct (pos/rot) decoupled from model transform; pad 2 translates (D-pad, L1/R1) and yaws (L2/R2), composed against world_matrix in update_matrix() |
| ✅ | Multi-CLUT texture support (palette swap via stacked CLUT rows) | ~09-07-2026 | One .tim can hold N stacked CLUT rows over one shared image block (PaletteGen/tim_writer.js export); active_palette (main.c global, pad 2 SQUARE/CIRCLE) selects the row, clamped per-texture against paletteCount. Required a shared generated/tex_blob_table.h so main.c and the generator's TEX_BLOB_ENTRY struct can't drift out of sync again. CLUT is uploaded row-by-row rather than as one N-row block - a single-block upload hung on DuckStation, root cause unconfirmed, workaround documented in load_textures() |
| ⏳ | Asset pipeline: clean-build verification | — | Stamp-file dependency graph hasn't been build-tested yet |
| ⏳ | CD streaming vs. baked-in assets | — | Everything currently .incbin'd into the ELF; real engine will need on-demand CD reads once multiple levels exist — texture table lookup should stay agnostic to asset source now to ease this later |
| ⏳ | Translation | — | Camera-distance push exists; model_pos is decoupled from camera in update_matrix() but nothing in update() drives it from pad input yet |
| ⏳ | Scene graph | — | |
| ⏳ | Multiple models | — | Single hardcoded #include "generated/house.c" today; MAX_MODEL_VERTS/MAX_MODEL_TRIS sized per-model, not per-scene |
| ⏳ | Ordering Table | — | sort_model()'s depth values are already OT-ready |
| ⏳ | Clipping | — | Only a near-plane SZ<64 skip via gte_stsz3, no real clip |
| ⏳ | Frustum culling | — | |
| ⏳ | Animation | — | |
* Approximate dates inferred from development snapshots.