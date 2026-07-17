<p align="center">
  <img src="https://github.com/user-attachments/assets/object/76555e37-beda-4315-a491-6deab2ade4bf" height="250" />
  <img src="https://github.com/user-attachments/assets/object/d1663f86-dcb7-4632-a6e1-de1c8c2f732a" height="250" />
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
| ✅ | Painter's Algorithm | ~27-06-2026 | sort_model(): per-tri GTE avsz3, insertion sort back-to-front (since superseded by the GPU Ordering Table below) |
| ✅ | GTE transforms | ~27-06-2026 | Rotation, projection, normals, backface cull all GTE-driven |
| ✅ | Vertex lighting | ~27-06-2026 | Gouraud via POLY_G3, per-vertex normal rotation in update_matrix() |
| ✅ | Texture coordinates | ~28-06-2026 | modelUVs[], emitted by py_convert_assets.py from OBJ vt, split-vertex space |
| ✅ | TIM loader | ~28-06-2026 | load_texture(): GetTimInfo + LoadImage for pixel + CLUT |
| ✅ | Textured polygons | ~28-06-2026 | POLY_FT3 path in draw_model(), TPAGE/CLUT resolved once at load |
| ✅ | Input edge detection | ~30-06-2026 | Toggle buttons (TRIANGLE/SQUARE) now edge-triggered, not held-repeat |
| ✅ | Asset pipeline restructure | ~06-07-2026 | Per-object folders (assets/object/<obj>/<obj>.obj/.mtl[/textures]), flat generated/ output |
| ✅ | Build system fix | ~06-07-2026 | CMake DEPENDS keyed off source .obj/.mtl/.png + scripts, not generated output; stamp file for convert_assets |
| ✅ | Multi-material support | ~07-07-2026 | py_convert_assets.py parses usemtl, emits real per-triangle material indices + per-model modelMaterialNames[] table |
| ✅ | Multi-texture table | ~07-07-2026 | main.c builds textureTable[] from the blob at load; draw_model() resolves tri->material by name instead of one global faceTexture |
| ✅ | Per-triangle texture/flat dispatch | ~07-07-2026 | triTexture[] cache built once at load (build_triangle_texture_cache()); untextured materials fall back to flat/Gouraud per-triangle, not via one global toggle |
| ✅ | Texture blob + header table | ~07-07-2026 | tex_blob.S (fixed .incbin) + generated tex_blob_table.c (name/offset/length); adding textures touches zero hand-written files |
| ✅ | Asset pipeline: auto-discover textures | ~08-07-2026 | py_convert_textures.py walks assets/object/*/textures/*.png; filename stem = material name, TEXTURES list removed entirely |
| ✅ | Asset pipeline: auto VRAM packer | ~08-07-2026 | Shelf packer in py_convert_textures.py; reads real PNG dimensions, hard-fails on budget overrun instead of silently overlapping |
| ✅ | Camera | ~08-07-2026 | CAMERA struct (pos/rot) decoupled from model transform; now driven from pad 1's camera schema (hold L2): D-pad translates X/Z, L1/R1 translates Y, SELECT/R2 yaws. View matrix built in update_camera_matrix(), composed per object in update_object_world_and_compose() |
| ✅ | Multi-CLUT texture support (palette swap via stacked CLUT rows) | ~09-07-2026 | One .tim can hold N stacked CLUT rows over one shared image block (PaletteGen/tim_writer.js export); row = each scene object's authored base palette (SCENE_OBJECT.palette) + the live active_palette nudge (SQUARE/CIRCLE, camera schema), clamped per-texture against paletteCount. Required a shared generated/tex_blob_table.h so main.c and the generator's TEX_BLOB_ENTRY struct can't drift out of sync again. CLUT is uploaded row-by-row rather than as one N-row block - a single-block upload hung on DuckStation, root cause unconfirmed, workaround documented in load_textures() |
| ✅ | Single-pad control schemas | ~15-07-2026 | Two-controller setup folded into one pad: hold L2 to switch from the debug transform schema to the camera schema; L2's old per-axis role moved to SELECT |
| ✅ | Scene loading | ~10-07-2026 | scenes/*/scene.json -> generated/scene_*.c (py_convert_scenes.py + SceneGen tool); places named model instances with their own pos/rot/scale/palette, camera block per scene, model names resolved at runtime in load_scene() |
| ✅ | Multiple models | ~10-07-2026 | Every assets/<obj> baked in via generated/model_registry.c, resolved by name per scene object — replaced the single hardcoded #include "generated/house.c" |
| ✅ | Ordering Table | ~15-07-2026 | OT_LEN-bucket GPU OT (draw_object_into_ot() + DrawOTag()): every triangle from every visible object depth-bucketed via gte_avsz3; replaced sort_model()'s CPU insertion sort entirely |
| ✅ | Per-vertex transform caching | ~15-07-2026 | transform_object_vertices(): each unique vertex through the GTE once per object per frame (gte_rtps), looked up per triangle corner — GTE cost scales with vertCount, not 3x triCount |
| ✅ | Frustum culling | ~15-07-2026 | Per-object bounding-sphere test (object_is_culled()): centre + two radius-offset points through the real composed matrix, rejected if behind the near plane or fully off-screen |
| ✅ | SPU sound (ambient) | ~15-07-2026 | sound.c: WIND.VAG streamed off CD into SPU RAM, looping voice 0, START toggles; owns the shared SPU RAM bump allocator + debug-overlay budget |
| ✅ | Music sequencer (VAB+SEQ) | ~17-07-2026 | music.c: PSn00bSDK ships no libsnd, so this module IS the sequencer — parses the OST Studio .vab/.seq pair, 16-voice pool (voices 8-23), NRPN loop markers, real-vblank-anchored tempo |
| ⏳ | Asset pipeline: clean-build verification | — | Stamp-file dependency graph hasn't been build-tested yet |
| ⏳ | CD streaming vs. baked-in assets | — | Everything currently .incbin'd into the ELF; real engine will need on-demand CD reads once multiple levels exist — texture table lookup should stay agnostic to asset source now to ease this later |
| ⏳ | Translation (debug offset) | — | Camera translation is live (camera schema); the global model_pos debug offset is applied in get_object_transform() but nothing in update() drives it from pad input yet |
| ⏳ | Scene graph | — | Flat scene loading landed (see above); no parent/child transform hierarchy yet |
| ⏳ | Clipping | — | Only a near-plane SZ<64 skip (per-vertex cached SZ in draw_object_into_ot()), no real clip |
| ⏳ | Animation | — | |
* Approximate dates inferred from development snapshots.