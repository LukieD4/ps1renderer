<p align="center">
  <img src="https://github.com/user-attachments/assets/76555e37-beda-4315-a491-6deab2ade4bf" height="250" />
  <img src="https://github.com/user-attachments/assets/98d6da4e-dbe3-4bbb-9130-a8c238de1f27" height="250" />
</p>


Dates are approximate and represent when a feature first landed in the project.
| Status | Feature | First Landed* | Notes |
|:------:|---------|:-------------:|-------|
| ✅ | OBJ importer | ~25-06-2026 | |
| ✅ | Wireframe | ~28-05-2026 | |
| ✅ | Filled polygons | ~25-06-2026 | |
| ✅ | Perspective | ~26-06-2026 | gte_stsxy3 / gte_SetGeomScreen, live FOV via pad |
| ✅ | Backface culling | ~26-06-2026 | gte_nclip + gte_stopz |
| ✅ | XYZ rotation | ~25-06-2026 | RotMatrix + gte_SetRotMatrix |
| ✅ | Painter's Algorithm | ~25-06-2026 | sort_model(): per-tri GTE avsz3, insertion sort back-to-front |
| ✅ | Flat lighting | ~27-06-2026 | GTE-rotated face normals, directional + ambient |
| ✅ | GTE transforms | ~26-06-2026 | Rotation, projection, normals, backface cull all GTE-driven |
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
| ⏳ | CLUT support (palette swap / shared-texture variants) | — | Scoping in progress - direction not yet decided between palette-swap materials, 8bpp mixed with 4bpp, or shared-pixel-data/multi-CLUT materials |
| ⏳ | Asset pipeline: clean-build verification | — | Stamp-file dependency graph hasn't been build-tested yet |
| ⏳ | CD streaming vs. baked-in assets | — | Everything currently .incbin'd into the ELF; real engine will need on-demand CD reads once multiple levels exist — texture table lookup should stay agnostic to asset source now to ease this later |
| ⏳ | Translation | — | Camera-distance push exists; no independent model translate yet |
| ⏳ | Camera | — | Currently a fixed push-back in update_matrix(); no camera struct/movement/look-at |
| ⏳ | Scene graph | — | |
| ⏳ | Multiple models | — | Single hardcoded #include "generated/house.c" today; MAX_MODEL_VERTS/MAX_MODEL_TRIS sized per-model, not per-scene |
| ⏳ | Ordering Table | — | sort_model()'s depth values are already OT-ready |
| ⏳ | Clipping | — | Only a near-plane SZ<64 skip via gte_stsz3, no real clip |
| ⏳ | Frustum culling | — | |
| ⏳ | Animation | — | |
* Approximate dates inferred from development snapshots.