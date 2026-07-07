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
| ✅ | Asset pipeline restructure | ~06-07-2026 | Per-object folders (assets/<obj>/<obj>.obj/.mtl[/textures]), flat assets_c/ output |
| ✅ | Build system fix | ~06-07-2026 | CMake DEPENDS keyed off source .obj/.mtl/.png + scripts, not generated output; stamp file for convert_assets |
| ⏳ | Translation | — | Camera-distance push exists; no independent model translate yet |
| ⏳ | Camera | — | Currently a fixed push-back in update_matrix(); no camera struct/movement/look-at |
| ⏳ | Scene graph | — | |
| ⏳ | Multiple models | — | Single hardcoded #include "assets_c/ball.c" today; MAX_MODEL_VERTS/MAX_MODEL_TRIS sized per-model, not per-scene |
| ⏳ | Ordering Table | — | sort_model()'s depth values are already OT-ready |
| ⏳ | Clipping | — | Only a near-plane SZ<64 skip via gte_stsz3, no real clip |
| ⏳ | Frustum culling | — | |
| ⏳ | Animation | — | |
| ⏳ | Asset pipeline: auto-discover textures | — | TEXTURES list in py_convert_textures.py is hand-maintained per model |
| ⏳ | Asset pipeline: clean-build verification | — | Stamp-file dependency graph hasn't been build-tested yet |
* Approximate dates inferred from development snapshots.
