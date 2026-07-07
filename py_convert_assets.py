# root/py_convert_assets.py

import os, shutil
import math
from pathlib import Path

# Run before py_convert_textures.py!

# Source/output dirs: assets (source) .obj/.mtl files go in assets/,
# converted .c files come out in assets_c/.
ORIGIN_OBJECT_DIR = Path(__file__).resolve().parent / "assets"
CONVERT_OBJECT_DIR = Path(__file__).resolve().parent / "assets_c"

FILES_TO_BE_PROCESSED = os.walk(ORIGIN_OBJECT_DIR)

FIXED_POINT_MATH_UPSCALE = 1024  # converts from decimal to int, something which the ps1 can digest.

# PS1 GPU texture coordinates are 0-255 (one byte per axis), regardless of
# the actual texture's pixel dimensions - the TPAGE/CLUT setup elsewhere
# maps that 0-255 range onto the real texture page. OBJ 'vt' data is
# normalized 0.0-1.0 UV, so this is just that scaled into a byte.
UV_BYTE_SCALE = 255  # 256x256 image


# Delete old dir contents so stale .c files don't linger after a model is
# renamed/removed from assets_c/.
if CONVERT_OBJECT_DIR.exists():
    for item in CONVERT_OBJECT_DIR.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
else:
    CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)


#
# Phase 1: parse each .obj into a dict of raw line data
#
for root, dirs, filenames in FILES_TO_BE_PROCESSED:
    for filename in filenames:
        if filename.endswith(".py"): continue  # skips
        if not filename.endswith(".obj"): continue  # skips materials and anything else

        file = Path(root) / filename

        data = {}

        # Tracked separately because they're context markers, not float/index data
        object_names = []      # 'o' lines
        group_names = []       # 'g' lines
        smoothing_groups = []  # 's' lines
        material_uses = []     # 'usemtl' lines

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
                    material_uses.append(content_value)
                    continue

                # Store multiple entries of the same type
                if content_suffix not in data:
                    data[content_suffix] = []

                data[content_suffix].append(content_value)

        #
        # Debug output
        #
        print(f"\nParsed {filename}\n")
        for key, values in data.items():
            print(f"{key}: {len(values)} entries")
        if object_names: print(f"o: {len(object_names)} entries")
        if group_names: print(f"g: {len(group_names)} entries")
        if smoothing_groups: print(f"s: {len(smoothing_groups)} entries")
        if material_uses: print(f"usemtl: {len(material_uses)} entries")

        #
        # Phase 2: emit a .c file from the parsed data
        #

        CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)

        file_output = CONVERT_OBJECT_DIR / f"{file.stem}.c"

        # Do not redefine SVECTOR, <psxgte.h> already has it.
        #
        # uv0/uv1/uv2 are now consumed by main.c's draw_model() textured
        # path (POLY_FT3 + setUV3()), reading the same split-vertex index
        # space as v0/v1/v2 - no longer placeholder zeros.
        VERTEX_INDICES = """
typedef struct
{
    unsigned short v0;
    unsigned short v1;
    unsigned short v2;

    unsigned short n0;
    unsigned short n1;
    unsigned short n2;

    unsigned short uv0;
    unsigned short uv1;
    unsigned short uv2;

    unsigned char material;

} MODEL_TRI;
"""

        output = []

        output.append("/* Auto-generated from OBJ.\n* Do not edit manually.*/\n")
        output.append("\n")
        output.append(VERTEX_INDICES)
        output.append("\n")

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
            # Verified empirically: cross-referenced raw OBJ vertex data
            # against Blender's own viewport readout, then confirmed with a
            # two-tipped arrow test object (primary tip = Blender world +Y,
            # secondary tip = Blender world +Z) that both tips render in the
            # correct direction on screen.
            #
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
            # Confirmed on-screen: primary arrow (Blender +Y) renders
            # pointing AWAY from the camera; secondary arrow (Blender +Z)
            # renders pointing UP on screen. A model's Blender-up is
            # screen-up, and a model's Blender-forward (+Y) points away
            # from the camera by default with model_rot = {0,0,0} - no
            # per-model rotation offset needed.
            #
            # DO NOT re-derive or re-flip this from camera-rotation
            # reasoning or exporter-convention theory again - if a future
            # model looks mirrored or backwards, the bug is almost
            # certainly elsewhere (winding/cull sign, a bad per-model
            # rotation default, or a genuinely different OBJ export
            # setting on that specific asset) - re-verify with the
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

        face_index_lists = []  # list of (v0,v1,v2) post-triangulation, indices into split_vert_positions
        triangle_count = 0
        missing_vn_used = False
        missing_vt_used = False

        if "f" in data:

            output.append("MODEL_TRI modelTris[] = {\n")

            for face in data["f"]:

                verts = face.split()

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
                        f"0 }},\n"
                    )

                    face_index_lists.append(
                        (corner_split_indices[0], corner_split_indices[1], corner_split_indices[2])
                    )

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
                            f"0 }},\n"
                        )

                        face_index_lists.append(
                            (corner_split_indices[0], corner_split_indices[n], corner_split_indices[n + 1])
                        )

                        triangle_count += 1

            output.append("};\n\n")

        if missing_vn_used:
            print(f"  WARNING: {filename} has face corners with no vn data; "
                  f"those corners were NOT deduplicated against matching-vn corners.")

        if missing_vt_used:
            print(f"  WARNING: {filename} has face corners with no vt data; "
                  f"modelUVs for those corners will be emitted as {{0, 0}} placeholders.")

        #
        # Vertices (modelVerts) - emitted from the SPLIT array, not the raw
        # OBJ 'v' list. modelVerts may contain more entries than the OBJ
        # had 'v' lines, since seam positions (and UV-island boundaries)
        # get duplicated into multiple slots above.
        #
        # NOTE: split_vert_positions has already had the full coordinate
        # remap applied (see get_split_vertex above, all three axes) -
        # this block just writes already-remapped values, so face
        # normals/bbox/bsphere computed below stay consistent with the
        # same convention.
        #
        if split_vert_positions:

            output.append("SVECTOR modelVerts[] = {\n" + "// be sure to #include <psxgte.h> in main.c\n")

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

            output.append("SVECTOR modelFaceNormals[] = {\n")

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
                    # Degenerate triangle (zero-area face in source data),
                    # fall back to a zero normal rather than dividing by 0.
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
        # directly from the OBJ's own vn data (no averaging needed, since
        # every split slot already corresponds to exactly one vn). Index-
        # matches modelVerts 1:1, in the split-vertex index space.
        # Already remapped into renderer space (see get_split_vertex
        # above) - all three axes, not just Y.
        #
        if split_vert_positions:

            # Backfill any None entries (corners with no vn data) using
            # that vertex's first associated triangle's flat face normal,
            # found by scanning face_index_lists. Rare path - only hit on
            # OBJs missing vn data on some corners.
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

            output.append("SVECTOR modelVertNormals[] = {\n")

            for normal in split_vert_normals:

                if normal is None:
                    # Still none - vertex genuinely unreferenced by any face.
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
        # GPU texture coordinates. Consumed by main.c's draw_model()
        # textured path via setUV3(). Index-matches modelVerts/
        # modelVertNormals 1:1, same split-vertex index space.
        #
        # NOTE: no UV_INFO/UV-pair struct exists in PSn00bSDK v0.23's
        # psxgpu.h - POLY_FT3/POLY_GT3 just take raw `uint8_t u0,v0` etc.
        # fields directly (see setUV3() in psxgpu.h). So this is emitted as
        # a flat unsigned char[][2] instead of a struct array - each row is
        # already in exactly the {u, v} pair shape setUV3() wants, just
        # without inventing a type the SDK doesn't have.
        #
        if split_vert_positions:

            output.append("unsigned char modelUVs[][2] = {\n")

            missing_uv_count = 0

            for uv in split_vert_uvs:

                if uv is None:
                    # No vt for this corner - emit a placeholder rather
                    # than guessing (no sensible default UV exists, unlike
                    # the vn fallback above).
                    output.append("    { 0, 0 }, // missing vt data\n")
                    missing_uv_count += 1
                    continue

                u, v = uv

                # Clamp before scaling - some exporters produce slightly
                # out-of-0..1 UVs (e.g. from tiling/wrap setups); clamping
                # keeps the byte cast in 0-255 range instead of wrapping.
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
        # Uses split_vert_positions for consistency with modelVerts - bbox/
        # bsphere values are identical either way since splitting only
        # duplicates positions, it never changes the position set's extent.
        #
        if split_vert_positions:

            min_x = min(v[0] for v in split_vert_positions)
            min_y = min(v[1] for v in split_vert_positions)
            min_z = min(v[2] for v in split_vert_positions)

            max_x = max(v[0] for v in split_vert_positions)
            max_y = max(v[1] for v in split_vert_positions)
            max_z = max(v[2] for v in split_vert_positions)

            output.append("SVECTOR modelBBoxMin = {\n")
            output.append(
                f"    {int(min_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(min_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(min_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            output.append("SVECTOR modelBBoxMax = {\n")
            output.append(
                f"    {int(max_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(max_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(max_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            #
            # Bounding sphere
            #
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

            output.append("SVECTOR modelBSphereCenter = {\n")
            output.append(
                f"    {int(center_x * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(center_y * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(center_z * FIXED_POINT_MATH_UPSCALE)}\n"
            )
            output.append("};\n\n")

            output.append(
                f"const int modelBSphereRadius = {int(radius * FIXED_POINT_MATH_UPSCALE)};\n\n"
            )

        #
        # Useful counts for rendering.
        # NOTE: modelVertCount reflects the SPLIT vertex count, which will
        # be >= the OBJ's raw 'v' count (equal only if no seams or UV
        # island boundaries exist). MAX_MODEL_VERTS in main.c must be sized
        # for this larger number - check the "Split vertex count" line
        # printed below against it whenever a model is swapped in.
        #
        vertex_count = len(split_vert_positions)

        output.append(
            f"const unsigned int modelVertCount = {vertex_count};\n"
        )

        output.append(
            f"const unsigned int modelTriCount = {triangle_count};\n"
        )

        #
        # Write generated file
        #
        with open(file_output, "w", newline="\n") as generated:
            generated.writelines(output)

        print(f"Generated: {file_output}")
        print(f"  Split vertex count: {vertex_count} (vs raw OBJ 'v' count: {len(verts_float)})")