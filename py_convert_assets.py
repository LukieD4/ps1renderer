# root/py_convert_assets.py
# (resync marker)

import os, re, shutil
import math
from pathlib import Path

# Run before py_convert_textures.py!

# Source/output dirs: assets (source) .obj/.mtl files go in assets/,
# converted .c files come out in generated/.
ORIGIN_OBJECT_DIR = Path(__file__).resolve().parent / "assets"
CONVERT_OBJECT_DIR = Path(__file__).resolve().parent / "generated"

FIXED_POINT_MATH_UPSCALE = 1024  # converts from decimal to int, something which the ps1 can digest.

# PS1 GPU texture coordinates are 0-255 (one byte per axis), regardless of
# the actual texture's pixel dimensions - the TPAGE/CLUT setup elsewhere
# maps that 0-255 range onto the real texture page. OBJ 'vt' data is
# normalized 0.0-1.0 UV, so this is just that scaled into a byte.
UV_BYTE_SCALE = 255  # 256x256 image

# Per-model triangle count is currently capped at 256 (MAX_MODEL_TRIS in
# main.c) and material indices are stored as unsigned char (0-255), so
# 256 distinct materials per model is the hard ceiling either way.
MAX_MATERIALS_PER_MODEL = 256

# Multiple simultaneous models (scenes) means every generated .c file now
# gets #include'd together into ONE main.c translation unit (via
# generated/models_all.h), instead of one at a time by hand-editing a
# single "#include generated/house.c" line. That means every model's
# top-level symbols (modelTris, modelVerts, etc.) MUST be unique per
# model - this prefix is what makes that safe. Sanitized so a folder
# name that isn't already a valid C identifier fragment (starts with a
# digit, has spaces/dashes, etc.) still produces something legal.
def sanitize_identifier(name):
    ident = re.sub(r"[^0-9A-Za-z_]", "_", name)
    if not ident or ident[0].isdigit():
        ident = "_" + ident
    return ident


# Delete old dir contents so stale .c files don't linger after a model is
# renamed/removed from generated/. Runs first, before py_convert_textures.py
# or py_convert_scenes.py add their own (differently-named) outputs to the
# same directory - both of those scripts are careful not to wipe generated/
# themselves, only this one does, since this one always runs first.
if CONVERT_OBJECT_DIR.exists():
    for item in CONVERT_OBJECT_DIR.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
else:
    CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)

CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------------
# Discovery: ONE .obj per model folder, following the established
# per-object convention (assets/<name>/<name>.obj[/.mtl][/textures]) -
# see the README's "Asset pipeline restructure" entry. This is a
# deliberately NARROWER walk than the old os.walk(ORIGIN_OBJECT_DIR)
# (which recursed into every subfolder, including dev/ working-file
# dirs - that's how assets/house/dev/_house.obj used to leak out as a
# phantom "generated/_house.c" model). Baking every discovered model
# into the ELF unconditionally (the "bake all models always" choice for
# the scene system) makes an accurate discovery list matter now more
# than it used to - a stray dev/ .obj would become a real, wasted
# runtime model registry entry, not just an unused generated file.
# ------------------------------------------------------------------
discovered_models = []  # list of (folder_name, obj_path)

for folder in sorted(ORIGIN_OBJECT_DIR.iterdir()):
    if not folder.is_dir():
        continue

    obj_path = folder / f"{folder.name}.obj"
    if not obj_path.exists():
        print(f"NOTE: {folder.name}/ has no {folder.name}.obj (per-object naming "
              f"convention) - skipped. Anything else in this folder (dev/ files, "
              f"stray .obj with a different name, etc.) is intentionally ignored.")
        continue

    discovered_models.append((folder.name, obj_path))


# Collected across the loop below, used to emit model_registry.c /
# models_all.h once every model has been converted.
model_registry_entries = []  # list of dicts: name, ident, has_data


#
# Phase 1: parse each .obj into a dict of raw line data
#
for model_name, file in discovered_models:
        filename = file.name
        ident = sanitize_identifier(model_name)

        data = {}

        # Tracked separately because they're context markers, not float/index data
        object_names = []      # 'o' lines
        group_names = []       # 'g' lines
        smoothing_groups = []  # 's' lines

        # material_uses is now built as a list of (line_index_in_f_order, name)
        # is NOT quite right either - usemtl can appear anywhere between 'f'
        # lines, so what we actually need is "which material applies to each
        # 'f' line in file order". We build that directly below by walking
        # the file a second way: instead of only bucketing 'f' lines into
        # data["f"], we also record, in the SAME order, which material name
        # was active (the most recent 'usemtl' seen) for that specific face.
        # This list is index-matched 1:1 with data["f"] once that's built.
        face_material_names = []   # index-matched with data["f"], one name per face line
        current_material_name = None

        with open(file, "r", newline="") as content:
            for line in content:
                line = line.rstrip("\r\n")  # remove newlines
                if not line: continue

                stripped = line.lstrip()
                if stripped.startswith("#"): continue  # skip comments

                content_data = stripped.split(" ", 1)  # split into type + remaining data
                if len(content_data) < 2: continue

                content_suffix, content_value = content_data

                # Route named/context lines into their own lists rather than
                # the generic numeric-data dict, since they don't get a C
                # array of their own (yet) - we just keep them so the parser
                # doesn't silently drop info from the source .obj.
                if content_suffix == "o":
                    object_names.append(content_value)
                    continue
                if content_suffix == "g":
                    group_names.append(content_value)
                    continue
                if content_suffix == "s":
                    smoothing_groups.append(content_value)
                    continue
                if content_suffix == "usemtl":
                    # Track the currently-active material by name. This
                    # stays active for every subsequent 'f' line until the
                    # next 'usemtl' (or EOF) - standard OBJ semantics.
                    current_material_name = content_value.strip()
                    continue

                # 'f' lines get their active material recorded alongside them,
                # in the same order they're appended to data["f"] below, so
                # face_material_names[i] always corresponds to data["f"][i].
                if content_suffix == "f":
                    face_material_names.append(current_material_name)

                # Store multiple entries of the same type
                if content_suffix not in data:
                    data[content_suffix] = []

                data[content_suffix].append(content_value)

        #
        # Build the material name -> index map, in first-seen order.
        # A face with no 'usemtl' at all (current_material_name is None)
        # gets bucketed into a synthetic "(none)" material at whatever
        # index it first appears - this keeps every triangle's material
        # field well-defined instead of leaving a gap or crashing on None.
        #
        material_name_to_index = {}
        material_index_to_name = []

        def get_material_index(name):
            key = name if name is not None else "(none)"
            if key in material_name_to_index:
                return material_name_to_index[key]
            new_index = len(material_index_to_name)
            if new_index >= MAX_MATERIALS_PER_MODEL:
                raise SystemExit(
                    f"{filename}: exceeded MAX_MATERIALS_PER_MODEL "
                    f"({MAX_MATERIALS_PER_MODEL}) distinct materials - "
                    f"material index no longer fits in unsigned char / "
                    f"MAX_MODEL_TRIS assumptions."
                )
            material_name_to_index[key] = new_index
            material_index_to_name.append(key)
            return new_index

        # Pre-populate the map now (in first-seen order across the whole
        # file) so indices are stable and match the order usemtl lines
        # actually appeared in the source .obj, regardless of which face
        # we assign indices to first below.
        for name in face_material_names:
            get_material_index(name)

        #
        # Debug output
        #
        print(f"\nParsed {filename} (model '{model_name}' -> prefix '{ident}_')\n")
        for key, values in data.items():
            print(f"{key}: {len(values)} entries")
        if object_names: print(f"o: {len(object_names)} entries")
        if group_names: print(f"g: {len(group_names)} entries")
        if smoothing_groups: print(f"s: {len(smoothing_groups)} entries")
        if material_index_to_name:
            print(f"materials: {len(material_index_to_name)} distinct -> {material_index_to_name}")

        #
        # Phase 2: emit a .c file from the parsed data
        #
        file_output = CONVERT_OBJECT_DIR / f"{model_name}.c"

        # MODEL_TRI is now defined ONCE in generated/model_common.h (emitted
        # below, after this loop) instead of being re-emitted verbatim into
        # every single generated/<model>.c file. That inline re-definition
        # was harmless back when only one generated .c was ever #include'd
        # into main.c at a time, but multiple models now share one
        # translation unit (see generated/models_all.h) - redefining the
        # same typedef N times in one TU is exactly the kind of drift this
        # project has already been bitten by once (see tex_blob_table.h's
        # own comment about the same lesson on the texture side).
        #
        # uv0/uv1/uv2 are consumed by main.c's draw_object() textured path
        # (POLY_FT3 + setUV3()), reading the same split-vertex index space
        # as v0/v1/v2.
        #
        # material is populated per-triangle (see get_material_index above)
        # instead of always being 0 - it indexes into THIS model's own
        # <ident>_modelMaterialNames[] table below, which main.c's texture
        # table lookup resolves against the texture blob's own name table at
        # load time (see py_convert_textures.py / tex_blob.c). This
        # indirection is what lets material index 0 mean different textures
        # in different models safely.

        output = []

        output.append(f"/* Auto-generated from {file.relative_to(Path(__file__).resolve().parent).as_posix()}.\n")
        output.append("* Do not edit manually.*/\n\n")
        output.append('#include "model_common.h"\n\n')

        #
        # Raw OBJ data, parsed but NOT yet split. verts_float/vert_normals_float
        # are indexed exactly as the OBJ file indexes 'v'/'vn' - independently
        # of each other. Faces below are what actually pair a v with a vn (and
        # a vt) per face-corner; that pairing is what Option B splits on.
        #
        verts_float = []         # OBJ 'v' index -> (x, y, z) float tuple
        vert_normals_float = []  # OBJ 'vn' index -> (nx, ny, nz) float tuple
        vert_uvs_float = []      # OBJ 'vt' index -> (u, v) float tuple

        if "v" in data:
            for vertex in data["v"]:
                x, y, z = vertex.split()
                verts_float.append((float(x), float(y), float(z)))

        if "vn" in data:
            for normal in data["vn"]:
                nx, ny, nz = normal.split()
                vert_normals_float.append((float(nx), float(ny), float(nz)))

        if "vt" in data:
            for uv in data["vt"]:
                # OBJ 'vt' lines are "u v" or "u v w" (w is rare, for 3D
                # textures - ignore it, PS1 only does 2D UV).
                parts = uv.split()
                u, v = parts[0], parts[1]
                vert_uvs_float.append((float(u), float(v)))

        #
        # Faces - Option B: split vertices at seams.
        #
        # Build a dedup map keyed by (v_index, vn_index, vt_index). Every
        # face corner looks up/creates a slot in this map; modelTris ends up
        # indexing into the resulting split-vertex arrays below, NOT the raw
        # OBJ 'v' index. A position shared by faces that all use the same vn
        # AND vt collapses to one slot (smooth, unseamed UV regions); a
        # position used with a different vn or vt per face (normal seams,
        # OR a UV island boundary - e.g. where a texture wraps and the UV
        # has to jump) gets a separate slot per distinct (vn, vt) pair, so
        # each side of either kind of seam keeps its own sharp normal/UV
        # instead of being blended into a soft average.
        #
        split_vert_key_to_index = {}   # (v_index, vn_index_or_None, vt_index_or_None) -> output index
        split_vert_positions = []      # output index -> (x, y, z) float tuple
        split_vert_normals = []        # output index -> (nx, ny, nz) float tuple, or None if no vn was given
        split_vert_uvs = []            # output index -> (u, v) float tuple, or None if no vt was given

        def get_split_vertex(v_index, vn_index, vt_index):
            key = (v_index, vn_index, vt_index)
            if key in split_vert_key_to_index:
                return split_vert_key_to_index[key]

            new_index = len(split_vert_positions)
            split_vert_key_to_index[key] = new_index

            # ============================================================
            # COORDINATE SYSTEM - FINALIZED (v4, verified via arrow.obj dual-tip test)
            # ============================================================
            # This project's OBJ export (Forward=-Z, Up=Y) emits:
            #   OBJ_X =  Blender_X
            #   OBJ_Y =  Blender_Z
            #   OBJ_Z = -Blender_Y
            #
            # Renderer requires (confirmed correct on-screen):
            #   renderer_X =  Blender_X  =  OBJ_X
            #   renderer_Y = -Blender_Z  = -OBJ_Y
            #   renderer_Z = -Blender_Y  = -OBJ_Z
            #
            # DO NOT re-derive or re-flip this again - re-verify with the
            # arrow.obj test object before touching this block.
            bx, by, bz = verts_float[v_index]
            split_vert_positions.append((bx, -by, -bz))

            if vn_index is not None and vn_index < len(vert_normals_float):
                bnx, bny, bnz = vert_normals_float[vn_index]
                split_vert_normals.append((bnx, -bny, -bnz))
            else:
                split_vert_normals.append(None)

            if vt_index is not None and vt_index < len(vert_uvs_float):
                u, v = vert_uvs_float[vt_index]
                # OBJ UV convention has v=0 at the BOTTOM of the texture; the PS1
                # GPU (and most raster image formats) have v=0 at the TOP. Flip
                # here at the source for the same "one correction point" reason
                # as the position remap above.
                split_vert_uvs.append((u, 1.0 - v))
            else:
                # No vt for this corner. Left as None (no sensible default UV to
                # fall back to, unlike normals which can borrow the face normal)
                # - emitted as a {0,0} placeholder below, with a warning printed
                # if this happens.
                split_vert_uvs.append(None)

            return new_index

        face_index_lists = []    # list of (v0,v1,v2) post-triangulation, indices into split_vert_positions
        face_material_indices = []  # index-matched with face_index_lists, one material index per triangle
        triangle_count = 0
        missing_vn_used = False
        missing_vt_used = False

        if "f" in data:

            output.append(f"MODEL_TRI {ident}_modelTris[] = {{\n")

            for face_line_index, face in enumerate(data["f"]):

                verts = face.split()

                # Resolve this face's material index once per face line
                # (every triangle produced by triangulating this face -
                # relevant for quads/ngons below - shares the same material,
                # since OBJ 'usemtl' applies at the face level, not per-corner).
                face_material_name = face_material_names[face_line_index]
                material_index = get_material_index(face_material_name)

                corner_split_indices = []

                for vert in verts:

                    parts = vert.split("/")

                    v_index = int(parts[0]) - 1

                    # parts: v, vt (may be empty string in "1//1"), vn
                    vt_index = None
                    if len(parts) >= 2 and parts[1] != "":
                        vt_index = int(parts[1]) - 1
                    else:
                        missing_vt_used = True

                    vn_index = None
                    if len(parts) >= 3 and parts[2] != "":
                        vn_index = int(parts[2]) - 1
                    else:
                        missing_vn_used = True

                    corner_split_indices.append(get_split_vertex(v_index, vn_index, vt_index))

                #
                # Triangle
                #
                if len(corner_split_indices) == 3:

                    output.append(
                        f"    {{ {corner_split_indices[0]}, {corner_split_indices[1]}, {corner_split_indices[2]}, "
                        f"0, 0, 0, "
                        f"{corner_split_indices[0]}, {corner_split_indices[1]}, {corner_split_indices[2]}, "
                        f"{material_index} }},\n"
                    )

                    face_index_lists.append(
                        (corner_split_indices[0], corner_split_indices[1], corner_split_indices[2])
                    )
                    face_material_indices.append(material_index)

                    triangle_count += 1

                #
                # Quad / ngon fan triangulation
                #
                elif len(corner_split_indices) > 3:

                    for n in range(1, len(corner_split_indices) - 1):

                        output.append(
                            f"    {{ {corner_split_indices[0]}, {corner_split_indices[n]}, {corner_split_indices[n + 1]}, "
                            f"0, 0, 0, "
                            f"{corner_split_indices[0]}, {corner_split_indices[n]}, {corner_split_indices[n + 1]}, "
                            f"{material_index} }},\n"
                        )

                        face_index_lists.append(
                            (corner_split_indices[0], corner_split_indices[n], corner_split_indices[n + 1])
                        )
                        face_material_indices.append(material_index)

                        triangle_count += 1

            output.append("};\n\n")

        if missing_vn_used:
            print(f"  WARNING: {filename} has face corners with no vn data; "
                  f"those corners were NOT deduplicated against matching-vn corners.")

        if missing_vt_used:
            print(f"  WARNING: {filename} has face corners with no vt data; "
                  f"modelUVs for those corners will be emitted as {{0, 0}} placeholders.")

        #
        # Material name table - <ident>_modelMaterialNames[] - one C string
        # per distinct material index, in the same order as
        # get_material_index assigned them (first-seen order in the .obj).
        # main.c's texture table lookup matches these names against the
        # texture blob's own name table (see py_convert_textures.py) to
        # resolve tri->material to an actual TPAGE/CLUT at runtime.
        #
        output.append(f"const unsigned int {ident}_modelMaterialCount = {len(material_index_to_name)};\n")
        output.append(f"const char *{ident}_modelMaterialNames[] = {{\n")
        for name in material_index_to_name:
            escaped = name.replace("\\", "\\\\").replace('"', '\\"')
            output.append(f'    "{escaped}",\n')
        output.append("};\n\n")

        #
        # Vertices (modelVerts) - emitted from the SPLIT array, not the raw
        # OBJ 'v' list. modelVerts may contain more entries than the OBJ
        # had 'v' lines, since seam positions (and UV-island boundaries)
        # get duplicated into multiple slots above.
        #
        if split_vert_positions:

            output.append(f"SVECTOR {ident}_modelVerts[] = {{\n" + "// be sure to #include <psxgte.h> in main.c\n")

            for (xf, yf, zf) in split_vert_positions:

                xi = int(xf * FIXED_POINT_MATH_UPSCALE)
                yi = int(yf * FIXED_POINT_MATH_UPSCALE)
                zi = int(zf * FIXED_POINT_MATH_UPSCALE)

                output.append(
                    f"    {{ {xi}, {yi}, {zi} }},\n"
                )

            output.append("};\n\n")

        #
        # Face normals (modelFaceNormals) - one per triangle, flat shading.
        # Reads from split_vert_positions (via face_index_lists) since
        # face_index_lists already points into the split array.
        #
        if face_index_lists and split_vert_positions:

            output.append(f"SVECTOR {ident}_modelFaceNormals[] = {{\n")

            for (i0, i1, i2) in face_index_lists:

                v0 = split_vert_positions[i0]
                v1 = split_vert_positions[i1]
                v2 = split_vert_positions[i2]

                ax, ay, az = (v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2])
                bx, by, bz = (v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2])

                nx = (ay * bz) - (az * by)
                ny = (az * bx) - (ax * bz)
                nz = (ax * by) - (ay * bx)

                length = math.sqrt(nx * nx + ny * ny + nz * nz)

                if length == 0.0:
                    unx, uny, unz = 0.0, 0.0, 0.0
                else:
                    unx, uny, unz = nx / length, ny / length, nz / length

                fnx = int(unx * FIXED_POINT_MATH_UPSCALE)
                fny = int(uny * FIXED_POINT_MATH_UPSCALE)
                fnz = int(unz * FIXED_POINT_MATH_UPSCALE)

                output.append(
                    f"    {{ {fnx}, {fny}, {fnz} }},\n"
                )

            output.append("};\n\n")

        #
        # Vertex normals (modelVertNormals) - one per SPLIT vertex, taken
        # directly from the OBJ's own vn data.
        #
        if split_vert_positions:

            if None in split_vert_normals:
                fallback_by_index = {}
                for tri_idx, (i0, i1, i2) in enumerate(face_index_lists):
                    for idx in (i0, i1, i2):
                        if split_vert_normals[idx] is None and idx not in fallback_by_index:
                            v0 = split_vert_positions[i0]
                            v1 = split_vert_positions[i1]
                            v2 = split_vert_positions[i2]
                            ax, ay, az = (v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2])
                            bx, by, bz = (v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2])
                            nx = (ay*bz) - (az*by)
                            ny = (az*bx) - (ax*bz)
                            nz = (ax*by) - (ay*bx)
                            fallback_by_index[idx] = (nx, ny, nz)

                for idx, normal in fallback_by_index.items():
                    split_vert_normals[idx] = normal

                print(f"  WARNING: {filename} - filled {len(fallback_by_index)} "
                      f"vertex normal(s) missing vn data with flat-normal fallback.")

            output.append(f"SVECTOR {ident}_modelVertNormals[] = {{\n")

            for normal in split_vert_normals:

                if normal is None:
                    output.append("    { 0, 0, 0 }, // unreferenced vertex\n")
                    continue

                nx, ny, nz = normal
                length = math.sqrt(nx * nx + ny * ny + nz * nz)

                if length == 0.0:
                    unx, uny, unz = 0.0, 0.0, 0.0
                else:
                    unx, uny, unz = nx / length, ny / length, nz / length

                fnx = int(unx * FIXED_POINT_MATH_UPSCALE)
                fny = int(uny * FIXED_POINT_MATH_UPSCALE)
                fnz = int(unz * FIXED_POINT_MATH_UPSCALE)

                output.append(
                    f"    {{ {fnx}, {fny}, {fnz} }},\n"
                )

            output.append("};\n\n")

        #
        # UVs (modelUVs) - one per SPLIT vertex, byte-scaled (0-255) PS1
        # GPU texture coordinates.
        #
        if split_vert_positions:

            output.append(f"unsigned char {ident}_modelUVs[][2] = {{\n")

            missing_uv_count = 0

            for uv in split_vert_uvs:

                if uv is None:
                    output.append("    { 0, 0 }, // missing vt data\n")
                    missing_uv_count += 1
                    continue

                u, v = uv

                u = 0.0 if u < 0.0 else (1.0 if u > 1.0 else u)
                v = 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)

                ub = int(u * UV_BYTE_SCALE)
                vb = int(v * UV_BYTE_SCALE)

                output.append(
                    f"    {{ {ub}, {vb} }},\n"
                )

            output.append("};\n\n")

            if missing_uv_count:
                print(f"  NOTE: {filename} - {missing_uv_count} split vertex(es) "
                      f"have no UV data (placeholder {{0,0}} emitted).")

        #
        # Bounding box (min/max corners, fixed-point, same space as modelVerts)
        #
        if split_vert_positions:

            min_x = min(v[0] for v in split_vert_positions)
            min_y = min(v[1] for v in split_vert_positions)
            min_z = min(v[2] for v in split_vert_positions)

            max_x = max(v[0] for v in split_vert_positions)
            max_y = max(v[1] for v in split_vert_positions)
            max_z = max(v[2] for v in split_vert_positions)

            output.append(f"SVECTOR {ident}_modelBBoxMin = {{\n")
            output.append(
                f"    {int(min_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(min_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(min_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            output.append(f"SVECTOR {ident}_modelBBoxMax = {{\n")
            output.append(
                f"    {int(max_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(max_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(max_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            center_x = (min_x + max_x) / 2.0
            center_y = (min_y + max_y) / 2.0
            center_z = (min_z + max_z) / 2.0

            radius = 0.0
            for (vx, vy, vz) in split_vert_positions:
                dx = vx - center_x
                dy = vy - center_y
                dz = vz - center_z
                dist = math.sqrt(dx * dx + dy * dy + dz * dz)
                if dist > radius:
                    radius = dist

            output.append(f"SVECTOR {ident}_modelBSphereCenter = {{\n")
            output.append(
                f"    {int(center_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(center_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(center_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            output.append(
                f"const int {ident}_modelBSphereRadius = {int(radius * FIXED_POINT_MATH_UPSCALE)};\n\n"
            )

        #
        # Useful counts for rendering.
        #
        vertex_count = len(split_vert_positions)

        output.append(
            f"const unsigned int {ident}_modelVertCount = {vertex_count};\n"
        )

        output.append(
            f"const unsigned int {ident}_modelTriCount = {triangle_count};\n"
        )

        #
        # Write generated file
        #
        with open(file_output, "w", newline="\n") as generated:
            generated.writelines(output)

        print(f"Generated: {file_output}")
        print(f"  Split vertex count: {vertex_count} (vs raw OBJ 'v' count: {len(verts_float)})")
        print(f"  Materials: {len(material_index_to_name)}")

        # A model with zero triangles (empty/degenerate .obj) has no
        # modelVerts/modelTris/etc. arrays emitted above (all guarded by
        # `if split_vert_positions:` / `if "f" in data:`) - registering it
        # anyway would reference symbols that don't exist and fail the
        # build. Skip it from the registry (with a loud warning) instead.
        if triangle_count == 0 or not split_vert_positions:
            print(f"  WARNING: '{model_name}' produced 0 triangles - excluded "
                  f"from model_registry.c (scene objects referencing it will "
                  f"be treated as an unresolved model at runtime).")
            continue

        model_registry_entries.append({"name": model_name, "ident": ident})


# ------------------------------------------------------------------
# Shared header - MODEL_TRI + MODEL_DEF struct definitions, ONE place
# only. #include'd by every generated/<model>.c file (added above),
# generated/model_registry.c, and main.c. Field types intentionally
# match each per-model array's actual declared type exactly (no const
# added at the pointer level) so assigning them into a MODEL_DEF literal
# below never trips a qualifier-mismatch warning on the MIPS toolchain.
# ------------------------------------------------------------------
header_lines = []
header_lines.append("/* Auto-generated by py_convert_assets.py. Do not edit manually.\n")
header_lines.append(" * Included by every generated/<model>.c file, generated/model_registry.c,\n")
header_lines.append(" * and main.c - keep this the ONLY place MODEL_TRI/MODEL_DEF are defined,\n")
header_lines.append(" * the same lesson tex_blob_table.h already applied on the texture side. */\n\n")
header_lines.append("#ifndef MODEL_COMMON_H\n#define MODEL_COMMON_H\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned short v0;\n")
header_lines.append("    unsigned short v1;\n")
header_lines.append("    unsigned short v2;\n\n")
header_lines.append("    unsigned short n0;\n")
header_lines.append("    unsigned short n1;\n")
header_lines.append("    unsigned short n2;\n\n")
header_lines.append("    unsigned short uv0;\n")
header_lines.append("    unsigned short uv1;\n")
header_lines.append("    unsigned short uv2;\n\n")
header_lines.append("    unsigned char material;\n\n")
header_lines.append("} MODEL_TRI;\n\n")
header_lines.append("// One entry per discovered assets/<name>/<name>.obj. Every pointer field\n")
header_lines.append("// points at that SPECIFIC model's own prefixed arrays (<name>_modelVerts,\n")
header_lines.append("// <name>_modelTris, etc.) - main.c resolves a scene object's \"model\" name\n")
header_lines.append("// string against modelRegistry[] once at scene load (see load_scene() /\n")
header_lines.append("// find_model_index_by_name()), then only ever touches these pointers/\n")
header_lines.append("// counts from there on - never the bare per-model globals directly. This\n")
header_lines.append("// is what makes main.c's render path model-agnostic instead of hardcoding\n")
header_lines.append("// one #include'd model.\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *name;\n\n")
header_lines.append("    SVECTOR *verts;\n")
header_lines.append("    unsigned int vertCount;\n\n")
header_lines.append("    MODEL_TRI *tris;\n")
header_lines.append("    unsigned int triCount;\n\n")
header_lines.append("    SVECTOR *faceNormals;\n")
header_lines.append("    SVECTOR *vertNormals;\n")
header_lines.append("    unsigned char (*uvs)[2];\n\n")
header_lines.append("    const char **materialNames;\n")
header_lines.append("    unsigned int materialCount;\n\n")
header_lines.append("    SVECTOR *bboxMin;\n")
header_lines.append("    SVECTOR *bboxMax;\n")
header_lines.append("    SVECTOR *bsphereCenter;\n")
header_lines.append("    int bsphereRadius;\n")
header_lines.append("} MODEL_DEF;\n\n")
header_lines.append("extern const unsigned int modelRegistryCount;\n")
header_lines.append("extern const MODEL_DEF modelRegistry[];\n\n")
header_lines.append("#endif\n")

(CONVERT_OBJECT_DIR / "model_common.h").write_text("".join(header_lines), newline="\n")
print(f"\nGenerated: {CONVERT_OBJECT_DIR / 'model_common.h'}")


# ------------------------------------------------------------------
# Registry - one entry per successfully-converted model.
# ------------------------------------------------------------------
registry_lines = []
registry_lines.append("/* Auto-generated by py_convert_assets.py. Do not edit manually. */\n\n")
registry_lines.append('#include "model_common.h"\n\n')
registry_lines.append(f"const unsigned int modelRegistryCount = {len(model_registry_entries)};\n")
registry_lines.append("const MODEL_DEF modelRegistry[] = {\n")
for entry in model_registry_entries:
    ident = entry["ident"]
    escaped_name = entry["name"].replace("\\", "\\\\").replace('"', '\\"')
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f"{ident}_modelVerts, {ident}_modelVertCount, "
        f"{ident}_modelTris, {ident}_modelTriCount, "
        f"{ident}_modelFaceNormals, {ident}_modelVertNormals, {ident}_modelUVs, "
        f"{ident}_modelMaterialNames, {ident}_modelMaterialCount, "
        f"&{ident}_modelBBoxMin, &{ident}_modelBBoxMax, "
        f"&{ident}_modelBSphereCenter, {ident}_modelBSphereRadius }},\n"
    )
registry_lines.append("};\n")

(CONVERT_OBJECT_DIR / "model_registry.c").write_text("".join(registry_lines), newline="\n")
print(f"Generated: {CONVERT_OBJECT_DIR / 'model_registry.c'} ({len(model_registry_entries)} model(s))")


# ------------------------------------------------------------------
# Manifest - #include'd ONCE from main.c. Replaces the old hand-edited
# "#include generated/house.c" + commented-out alternates - add/remove a
# model under assets/ and this regenerates automatically, no main.c edit
# needed.
# ------------------------------------------------------------------
manifest_lines = []
manifest_lines.append("/* Auto-generated by py_convert_assets.py. Do not edit manually.\n")
manifest_lines.append(" * #include this ONCE from main.c - lists every discovered model. */\n\n")
manifest_lines.append('#include "model_common.h"\n')
for entry in model_registry_entries:
    manifest_lines.append(f'#include "{entry["name"]}.c"\n')
manifest_lines.append('#include "model_registry.c"\n')

(CONVERT_OBJECT_DIR / "models_all.h").write_text("".join(manifest_lines), newline="\n")
print(f"Generated: {CONVERT_OBJECT_DIR / 'models_all.h'}")
