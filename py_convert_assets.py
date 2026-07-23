# root/py_convert_assets.py
# (resync marker)

import os, re, shutil
import math
import json, struct, base64
from pathlib import Path

# Run before py_convert_textures.py!

# Source/output dirs: assets (source) model files go in assets/object/,
# converted .c files come out in generated/.
ORIGIN_OBJECT_DIR = Path(__file__).resolve().parent / "assets" / "object"
CONVERT_OBJECT_DIR = Path(__file__).resolve().parent / "generated"
PROJECT_ROOT = Path(__file__).resolve().parent

FIXED_POINT_MATH_UPSCALE = 1024  # converts from decimal to int, something which the ps1 can digest.

# PS1 GPU texture coordinates are 0-255 (one byte per axis), regardless of
# the actual texture's pixel dimensions - the TPAGE/CLUT setup elsewhere
# maps that 0-255 range onto the real texture page. Source UV data is
# normalized 0.0-1.0 UV, so this is just that scaled into a byte.
UV_BYTE_SCALE = 255  # 256x256 image

# Per-model triangle count is currently capped at 512 (MAX_MODEL_TRIS in
# main.c), but material indices are stored as unsigned char (0-255), so
# 256 distinct materials per model is still the hard ceiling here.
MAX_MATERIALS_PER_MODEL = 256

# ------------------------------------------------------------------
# SOURCE FORMAT: glTF (.glb / .gltf)
# ------------------------------------------------------------------
# The renderer consumes the baked C arrays in generated/*.c, NOT the source
# mesh format - so the source format is purely a build-time concern. The
# front-end reader (read_gltf) emits an intermediate representation (an "IR"
# dict) and the back-end (emit_model_c) writes the .c from that IR. Adding a
# new format later is a matter of writing another front-end to the SAME IR;
# the C emitter and the renderer never move.
#
# The project migrated fully off OBJ/MTL: glTF carries geometry, UVs, material
# names AND cameras in one file, which OBJ could not. Discovery takes
# <name>.glb (then <name>.gltf) per model folder - nothing else.
#
# glTF coordinate/UV handling is documented inline in read_gltf().
# ------------------------------------------------------------------


def sanitize_identifier(name):
    ident = re.sub(r"[^0-9A-Za-z_]", "_", name)
    if not ident or ident[0].isdigit():
        ident = "_" + ident
    return ident


# Delete old dir contents so stale .c files don't linger after a model is
# renamed/removed from generated/. Runs first, before py_convert_textures.py
# or py_convert_stages.py add their own (differently-named) outputs.
if CONVERT_OBJECT_DIR.exists():
    for item in CONVERT_OBJECT_DIR.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
else:
    CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)

CONVERT_OBJECT_DIR.mkdir(parents=True, exist_ok=True)


# ==================================================================
# Coordinate remap - the SINGLE correction point, shared by both readers.
# ==================================================================
# Blender's exporters (OBJ with Forward=-Z/Up=Y, and glTF with its default
# +Y-up) BOTH emit vertex data in the same Y-up space:
#     export_X =  Blender_X
#     export_Y =  Blender_Z
#     export_Z = -Blender_Y
# The renderer wants (verified on-screen via the arrow asset's dual-tip test):
#     renderer_X =  export_X
#     renderer_Y = -export_Y
#     renderer_Z = -export_Z
# i.e. a 180-degree rotation about X (determinant +1, so winding/handedness
# is preserved - no triangle re-order needed). DO NOT re-derive this without
# re-checking the arrow test asset.
def remap_pos(x, y, z):
    return (x, -y, -z)

def remap_dir(x, y, z):
    return (x, -y, -z)


# ==================================================================
# Back-end: emit ONE model's .c file from the shared IR.
# ==================================================================
# IR dict keys:
#   split_positions : [(x,y,z) float]      renderer space, pre-fixed-point
#   split_normals   : [(nx,ny,nz)|None]    renderer space
#   split_uvs       : [(u,v)|None]         PS1 convention (v=0 at TOP)
#   faces           : [(i0,i1,i2)]         indices into split_* arrays
#   face_materials  : [int]                per-triangle material index
#   material_names  : [str]                index -> material name
#   camera          : {pos:(x,y,z), rot:(rx,ry,rz)} | None
#   src_rel         : str                  source path for the file header
#   raw_v_count     : int                  for the debug print
#   missing_vt      : bool
# Returns a registry entry dict (with has_camera) or None if the model has 0
# triangles and must be excluded.
def emit_model_c(model_name, ident, ir):
    split_vert_positions = ir["split_positions"]
    split_vert_normals   = ir["split_normals"]
    split_vert_uvs       = ir["split_uvs"]
    face_index_lists     = ir["faces"]
    face_material_indices= ir["face_materials"]
    material_index_to_name = ir["material_names"]
    triangle_count       = len(face_index_lists)
    camera               = ir.get("camera")

    output = []
    output.append(f"/* Auto-generated from {ir['src_rel']}.\n")
    output.append("* Do not edit manually.*/\n\n")
    output.append('#include "model_common.h"\n\n')

    # modelTris - built from the IR face list (emitted only when there ARE
    # triangles; a 0-tri model is excluded from the registry below anyway).
    if triangle_count > 0:
        output.append(f"MODEL_TRI {ident}_modelTris[] = {{\n")
        for (i0, i1, i2), material_index in zip(face_index_lists, face_material_indices):
            output.append(
                f"    {{ {i0}, {i1}, {i2}, "
                f"0, 0, 0, "
                f"{i0}, {i1}, {i2}, "
                f"{material_index} }},\n"
            )
        output.append("};\n\n")

    # Material name table.
    output.append(f"const unsigned int {ident}_modelMaterialCount = {len(material_index_to_name)};\n")
    output.append(f"const char *{ident}_modelMaterialNames[] = {{\n")
    for name in material_index_to_name:
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        output.append(f'    "{escaped}",\n')
    output.append("};\n\n")

    # Vertices (from the SPLIT array).
    if split_vert_positions:
        output.append(f"SVECTOR {ident}_modelVerts[] = {{\n" + "// be sure to #include <psxgte.h> in main.c\n")
        for (xf, yf, zf) in split_vert_positions:
            xi = int(xf * FIXED_POINT_MATH_UPSCALE)
            yi = int(yf * FIXED_POINT_MATH_UPSCALE)
            zi = int(zf * FIXED_POINT_MATH_UPSCALE)
            output.append(f"    {{ {xi}, {yi}, {zi} }},\n")
        output.append("};\n\n")

    # Face normals - one per triangle, flat shading.
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
            output.append(
                f"    {{ {int(unx * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(uny * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(unz * FIXED_POINT_MATH_UPSCALE)} }},\n"
            )
        output.append("};\n\n")

    # Vertex normals - one per SPLIT vertex.
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
            print(f"  WARNING: {model_name} - filled {len(fallback_by_index)} "
                  f"vertex normal(s) missing normal data with flat-normal fallback.")

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
            output.append(
                f"    {{ {int(unx * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(uny * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(unz * FIXED_POINT_MATH_UPSCALE)} }},\n"
            )
        output.append("};\n\n")

    # UVs - one per SPLIT vertex, byte-scaled (0-255).
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
            output.append(f"    {{ {int(u * UV_BYTE_SCALE)}, {int(v * UV_BYTE_SCALE)} }},\n")
        output.append("};\n\n")
        if missing_uv_count:
            print(f"  NOTE: {model_name} - {missing_uv_count} split vertex(es) "
                  f"have no UV data (placeholder {{0,0}} emitted).")

    # Bounding box + sphere.
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

    # Per-primitive collision bounds. SEPARATE FROM the whole-model bbox above,
    # which stays exactly as it was: that one feeds render culling (a question
    # about the mesh as a drawn thing), while these feed collision (a question
    # about the mesh as a solid thing). Merging them would mean a change to one
    # silently retunes the other.
    #
    # main.c's build_stage_colliders() emits one COLLIDER_BOX per entry here,
    # so a model with a building and a grass plane produces two colliders
    # instead of one box around both.
    prim_bounds = ir.get("prim_bounds") or []
    if prim_bounds:
        output.append(f"SVECTOR {ident}_modelCollMin[] = {{\n")
        for (bmin, _bmax) in prim_bounds:
            output.append(
                f"    {{ {int(bmin[0] * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(bmin[1] * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(bmin[2] * FIXED_POINT_MATH_UPSCALE)} }},\n"
            )
        output.append("};\n\n")

        output.append(f"SVECTOR {ident}_modelCollMax[] = {{\n")
        for (_bmin, bmax) in prim_bounds:
            output.append(
                f"    {{ {int(bmax[0] * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(bmax[1] * FIXED_POINT_MATH_UPSCALE)}, "
                f"{int(bmax[2] * FIXED_POINT_MATH_UPSCALE)} }},\n"
            )
        output.append("};\n\n")

        output.append(
            f"const unsigned int {ident}_modelCollCount = {len(prim_bounds)};\n\n"
        )

    # Camera (glTF only) - baked as data; main.c's follow-cam does not yet
    # consume it (that wiring waits on the rest-pose-vs-fixed-rig decision).
    # cameraRot uses the engine's 12-bit angle format but its exact euler
    # convention is PROVISIONAL until the follow-cam is wired - re-verify
    # against the on-screen result then.
    has_camera = camera is not None
    if has_camera:
        cx, cy, cz = camera["pos"]
        rx, ry, rz = camera["rot"]
        output.append(
            f"VECTOR {ident}_modelCameraPos = {{ "
            f"{int(cx * FIXED_POINT_MATH_UPSCALE)}, "
            f"{int(cy * FIXED_POINT_MATH_UPSCALE)}, "
            f"{int(cz * FIXED_POINT_MATH_UPSCALE)} }};\n"
        )
        output.append(f"SVECTOR {ident}_modelCameraRot = {{ {rx}, {ry}, {rz} }};\n")
        output.append(f"const int {ident}_modelHasCamera = 1;\n\n")

    # ---- Rig: per-vertex skin, skeleton, animation clips (skinned models). ----
    # NULL/absent on every static model, so MODEL_DEF's rig fields stay 0 there.
    rig = ir.get("rig")
    vert_skin = ir.get("vert_skin")
    has_rig = bool(rig and rig["bones"] and vert_skin)
    if has_rig:
        bones = rig["bones"]

        # One VERT_SKIN per SPLIT vertex, parallel to _modelVerts.
        output.append(f"VERT_SKIN {ident}_modelVertSkin[] = {{\n")
        for (b0, b1, w0) in vert_skin:
            output.append(f"    {{ {b0}, {b1}, {w0} }},\n")
        output.append("};\n\n")

        # Skeleton: parent index + engine-space inverse-bind MATRIX (rotation
        # 3x3 at ONE==4096, translation at the 1024 vertex scale).
        output.append(f"BONE_DEF {ident}_modelBones[] = {{\n")
        for b in bones:
            ib = b["invBind"]
            m3 = [[int(round(ib[r][c] * MATRIX_ONE)) for c in range(3)] for r in range(3)]
            t3 = [int(round(ib[r][3] * FIXED_POINT_MATH_UPSCALE)) for r in range(3)]
            rows = ",".join("{" + ",".join(str(v) for v in row) + "}" for row in m3)
            tvec = ",".join(str(v) for v in t3)
            output.append(f"    {{ {b['parent']}, {{ {{{rows}}}, {{{tvec}}} }} }},\n")
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_modelBoneCount = {len(bones)};\n\n")

        # Animation clips. Each BONE_KEY array is a [bone][frame] grid, so the
        # runtime indexes key (bone*frameCount + frame). Quaternion at 4096,
        # translation at the 1024 vertex scale.
        for ci, clip in enumerate(rig["clips"]):
            output.append(f"BONE_KEY {ident}_modelClip{ci}Keys[] = {{\n")
            frame_count = clip["frameCount"]
            for j in range(len(bones)):
                for f in range(frame_count):
                    (qx, qy, qz, qw), (tx, ty, tz) = clip["keys"][j][f]
                    vals = [int(round(qx * MATRIX_ONE)), int(round(qy * MATRIX_ONE)),
                            int(round(qz * MATRIX_ONE)), int(round(qw * MATRIX_ONE)),
                            int(round(tx * FIXED_POINT_MATH_UPSCALE)),
                            int(round(ty * FIXED_POINT_MATH_UPSCALE)),
                            int(round(tz * FIXED_POINT_MATH_UPSCALE))]
                    output.append("    { " + ",".join(str(v) for v in vals) + " },\n")
            output.append("};\n\n")

        output.append(f"ANIM_CLIP {ident}_modelClips[] = {{\n")
        for ci, clip in enumerate(rig["clips"]):
            nm = clip["name"].replace("\\", "\\\\").replace('"', '\\"')
            output.append(
                f'    {{ "{nm}", {clip["frameCount"]}, {clip["fps"]}, '
                f'{clip["loop"]}, {ident}_modelClip{ci}Keys }},\n')
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_modelClipCount = {len(rig['clips'])};\n\n")

    # Counts.
    vertex_count = len(split_vert_positions)
    output.append(f"const unsigned int {ident}_modelVertCount = {vertex_count};\n")
    output.append(f"const unsigned int {ident}_modelTriCount = {triangle_count};\n")

    file_output = CONVERT_OBJECT_DIR / f"{model_name}.c"
    with open(file_output, "w", newline="\n") as generated:
        generated.writelines(output)

    print(f"Generated: {file_output}")
    print(f"  Split vertex count: {vertex_count} (vs raw source vertex count: {ir['raw_v_count']})")
    print(f"  Materials: {len(material_index_to_name)}")
    if has_camera:
        print(f"  Camera baked: pos={camera['pos']} rot(12-bit,provisional)={camera['rot']}")

    if triangle_count == 0 or not split_vert_positions:
        print(f"  WARNING: '{model_name}' produced 0 triangles - excluded "
              f"from model_registry.c (stage objects referencing it will "
              f"be treated as an unresolved model at runtime).")
        return None

    return {"name": model_name, "ident": ident, "has_camera": has_camera,
            "has_coll": bool(ir.get("prim_bounds")), "has_rig": has_rig}


# ==================================================================
# Front-end: glTF (.glb / .gltf) reader -> IR   (no external deps)
# ==================================================================
_GLTF_COMP = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
_GLTF_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def _gltf_load(path):
    """Return (gltf_dict, glb_bin_chunk_or_None, base_dir)."""
    raw = path.read_bytes()
    if raw[:4] == b"glTF":  # binary .glb container
        magic, version, total = struct.unpack_from("<III", raw, 0)
        off = 12
        json_chunk = bin_chunk = None
        while off < total:
            clen, ctype = struct.unpack_from("<II", raw, off)
            off += 8
            chunk = raw[off:off + clen]
            off += clen
            if ctype == 0x4E4F534A:      # "JSON"
                json_chunk = chunk
            elif ctype == 0x004E4942:    # "BIN\0"
                bin_chunk = chunk
        return json.loads(json_chunk.decode("utf-8")), bin_chunk, path.parent
    return json.loads(raw.decode("utf-8")), None, path.parent


def _mat_identity():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def _mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _mat_from_colmajor(m):
    # glTF node.matrix is 16 floats, column-major.
    return [[m[c * 4 + r] for c in range(4)] for r in range(4)]


def _quat_to_mat(qx, qy, qz, qw):
    n = math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) or 1.0
    qx, qy, qz, qw = qx/n, qy/n, qz/n, qw/n
    return [
        [1-2*(qy*qy+qz*qz), 2*(qx*qy-qz*qw),   2*(qx*qz+qy*qw),   0.0],
        [2*(qx*qy+qz*qw),   1-2*(qx*qx+qz*qz), 2*(qy*qz-qx*qw),   0.0],
        [2*(qx*qz-qy*qw),   2*(qy*qz+qx*qw),   1-2*(qx*qx+qy*qy), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def _node_local_matrix(node):
    if "matrix" in node:
        return _mat_from_colmajor(node["matrix"])
    t = node.get("translation", [0.0, 0.0, 0.0])
    r = node.get("rotation", [0.0, 0.0, 0.0, 1.0])  # quaternion x,y,z,w
    s = node.get("scale", [1.0, 1.0, 1.0])
    m = _quat_to_mat(*r)
    for i in range(3):          # apply scale (columns) then translation
        for j in range(3):
            m[i][j] *= s[j]
    m[0][3], m[1][3], m[2][3] = t[0], t[1], t[2]
    return m


def _mat_point(m, p):
    return (
        m[0][0]*p[0] + m[0][1]*p[1] + m[0][2]*p[2] + m[0][3],
        m[1][0]*p[0] + m[1][1]*p[1] + m[1][2]*p[2] + m[1][3],
        m[2][0]*p[0] + m[2][1]*p[1] + m[2][2]*p[2] + m[2][3],
    )


def _mat_dir(m, d):
    return (
        m[0][0]*d[0] + m[0][1]*d[1] + m[0][2]*d[2],
        m[1][0]*d[0] + m[1][1]*d[1] + m[1][2]*d[2],
        m[2][0]*d[0] + m[2][1]*d[1] + m[2][2]*d[2],
    )


def _rad_to_12bit(a):
    return int(round(a / (2.0 * math.pi) * 4096.0)) & 4095


# ==================================================================
# Rig / skeletal-animation helpers (Phase 1). Pure Python, no deps.
# ==================================================================
# Fixed-point scales for baked rig data:
#   MATRIX_ONE (4096): inverse-bind rotation 3x3 and bone quaternions - the
#       same ONE the GTE / RotMatrix() use, so runtime matrix math is native.
#   FIXED_POINT_MATH_UPSCALE (1024): ALL translations (bone keyframe positions,
#       inverse-bind .t). This matches the vertex coordinate scale, so a skin
#       matrix applied to an SVECTOR vertex lands in the same integer space.
MATRIX_ONE = 4096
# How densely clips are resampled onto a UNIFORM frame grid. Source clips are
# ~30fps but their channels have wildly different key counts (some 2, some
# 215); a common uniform grid lets the runtime find a frame with a
# multiply+shift instead of a per-channel key-time search. 15fps halves the
# baked size versus the source and is plenty for a stylised NPC. Tunable.
ANIM_SAMPLE_FPS = 15
SKIN_MAX_INFLUENCES = 2   # top-N bones kept per vertex (2-bone LBS; runtime
                          # can ignore bone1 for the cheaper 1-bone path)

# Engine coordinate remap as a similarity transform. remap_pos/remap_dir apply
# R = diag(1,-1,-1) (180 degrees about X) to POINTS; a whole TRANSFORM M in
# glTF space becomes R*M*R in engine space. R is its own inverse, so the
# conjugation is a pure per-element sign flip with s = (1,-1,-1,1):
#   M'[i][j] = s[i]*s[j]*M[i][j]
# (rotation block gets the sign pattern; the translation column j==3 becomes
# exactly remap_pos of the translation). Applying this to the skeleton, the
# inverse-bind matrices AND every keyframe keeps them in the SAME space as the
# baked vertices - the single most important correctness invariant of the rig.
_REMAP_S = (1.0, -1.0, -1.0, 1.0)
def _conj_remap(m):
    return [[_REMAP_S[i] * _REMAP_S[j] * m[i][j] for j in range(4)] for i in range(4)]


def _mat_to_quat(m):
    # Upper-left 3x3 of a row-major 4x4 rotation -> unit (x,y,z,w).
    trace = m[0][0] + m[1][1] + m[2][2]
    if trace > 0.0:
        s = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2][1] - m[1][2]) / s
        y = (m[0][2] - m[2][0]) / s
        z = (m[1][0] - m[0][1]) / s
    elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0
        w = (m[2][1] - m[1][2]) / s
        x = 0.25 * s
        y = (m[0][1] + m[1][0]) / s
        z = (m[0][2] + m[2][0]) / s
    elif m[1][1] > m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0
        w = (m[0][2] - m[2][0]) / s
        x = (m[0][1] + m[1][0]) / s
        y = 0.25 * s
        z = (m[1][2] + m[2][1]) / s
    else:
        s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0
        w = (m[1][0] - m[0][1]) / s
        x = (m[0][2] + m[2][0]) / s
        y = (m[1][2] + m[2][1]) / s
        z = 0.25 * s
    n = math.sqrt(x*x + y*y + z*z + w*w) or 1.0
    return (x/n, y/n, z/n, w/n)


def _top_influences(joint_ids, weights, max_n):
    # Keep the max_n heaviest bones, renormalize to 0..255 summing to exactly
    # 255 (remainder folded into bone0 so w1 = 255 - w0 holds at runtime).
    pairs = sorted(zip(weights, joint_ids), reverse=True)[:max_n]
    ws = [p[0] for p in pairs] + [0.0] * (max_n - len(pairs))
    js = [int(p[1]) for p in pairs] + [0] * (max_n - len(pairs))
    total = sum(ws)
    if total <= 0.0:
        return js, [255] + [0] * (max_n - 1)
    q = [int(round(255 * w / total)) for w in ws]
    q[0] = 255 - sum(q[1:])
    if q[0] < 0:
        q[0] = 0
    return js, q


def _sample_channel(channels, node_idx, path, t, nodes, read_accessor, _cache):
    # Interpolate one node/path track at time t. Honours LINEAR and STEP
    # sampler modes; falls back to the node's bind TRS when the clip has no
    # channel for it (the common case: only the root translates, everyone
    # rotates). Cached accessor reads keep resampling cheap.
    key = (node_idx, path)
    ch = channels.get(key)
    node = nodes[node_idx]
    default = {
        "translation": node.get("translation", [0.0, 0.0, 0.0]),
        "rotation":    node.get("rotation",    [0.0, 0.0, 0.0, 1.0]),
        "scale":       node.get("scale",       [1.0, 1.0, 1.0]),
    }[path]
    if ch is None:
        return list(default)
    if key not in _cache:
        # SCALAR accessor (times) comes back as bare floats; VEC as tuples.
        times = list(read_accessor(ch["input"]))
        vals  = [list(v) for v in read_accessor(ch["output"])]
        _cache[key] = (times, vals, ch.get("interpolation", "LINEAR"))
    times, vals, interp = _cache[key]
    if t <= times[0]:
        return list(vals[0])
    if t >= times[-1]:
        return list(vals[-1])
    lo, hi = 0, len(times) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if times[mid] <= t: lo = mid
        else: hi = mid
    if interp == "STEP":
        return list(vals[lo])
    span = times[hi] - times[lo]
    a = 0.0 if span == 0.0 else (t - times[lo]) / span
    v0, v1 = vals[lo], vals[hi]
    if path == "rotation":
        # shortest-arc nlerp (cheap, visually identical to slerp at these fps)
        d = sum(v0[k] * v1[k] for k in range(4))
        s = -1.0 if d < 0.0 else 1.0
        q = [v0[k] * (1.0 - a) + s * v1[k] * a for k in range(4)]
        n = math.sqrt(sum(c*c for c in q)) or 1.0
        return [c / n for c in q]
    return [v0[k] * (1.0 - a) + v1[k] * a for k in range(len(v0))]


def _extract_rig(gltf, read_accessor, nodes, skin_index, model_name):
    # Build the engine-space skeleton + resampled clips for ONE skin. Returns
    # None if the model has no usable rig. Everything here is conjugated into
    # engine space by _conj_remap so it agrees with the baked vertices.
    skin = gltf["skins"][skin_index]
    joints = skin["joints"]
    node2joint = {nj: j for j, nj in enumerate(joints)}
    parent_node = {}
    for ni, n in enumerate(nodes):
        for c in n.get("children", []):
            parent_node[c] = ni
    parent_joint = [node2joint.get(parent_node.get(nj), -1) for nj in joints]

    # Runtime composes bone world matrices in a SINGLE parents-first pass, which
    # requires every parent to precede its child in joints[]. Enforce it.
    for j, pj in enumerate(parent_joint):
        if pj >= j:
            raise SystemExit(
                f"{model_name}: skin joints are not parents-first (joint {j} has "
                f"parent {pj}); re-export or add joint reordering before baking.")

    # Inverse-bind matrices: glTF stores 16 floats COLUMN-major per joint.
    ibm_accessor = skin.get("inverseBindMatrices")
    if ibm_accessor is None:
        # No IBM => identity (mesh authored in bind == joint space).
        inv_bind = [_mat_identity() for _ in joints]
    else:
        raw_ibm = read_accessor(ibm_accessor)
        inv_bind = []
        for flat in raw_ibm:
            m = [[flat[c * 4 + r] for c in range(4)] for r in range(4)]  # col->row
            inv_bind.append(_conj_remap(m))

    bones = [{"parent": parent_joint[j], "invBind": inv_bind[j]} for j in range(len(joints))]

    # Clips: resample every joint onto a uniform grid, conjugate each local
    # transform into engine space, store as (quat, translation); scale dropped
    # (measured <=1.6% and unused by the runtime skinner).
    clips = []
    for anim in gltf.get("animations", []):
        channels = {}
        for c in anim["channels"]:
            tgt = c["target"]
            if "node" in tgt:
                channels[(tgt["node"], tgt["path"])] = anim["samplers"][c["sampler"]]
        # Duration = latest key time across this clip's sampled channels.
        duration = 0.0
        acc_cache = {}
        for s in channels.values():
            times = list(read_accessor(s["input"]))
            if times:
                duration = max(duration, times[-1])
        frame_count = max(1, int(round(duration * ANIM_SAMPLE_FPS)) + 1)
        keys = []  # keys[joint][frame] = ((qx,qy,qz,qw),(tx,ty,tz))
        for j, nj in enumerate(joints):
            track = []
            for f in range(frame_count):
                t = f / float(ANIM_SAMPLE_FPS)
                tr = _sample_channel(channels, nj, "translation", t, nodes, read_accessor, acc_cache)
                ro = _sample_channel(channels, nj, "rotation",    t, nodes, read_accessor, acc_cache)
                local = _quat_to_mat(*ro)          # rotation 4x4 (row-major)
                local[0][3], local[1][3], local[2][3] = tr[0], tr[1], tr[2]
                elocal = _conj_remap(local)         # -> engine space
                q = _mat_to_quat(elocal)
                track.append((q, (elocal[0][3], elocal[1][3], elocal[2][3])))
            keys.append(track)
        clips.append({
            "name": anim.get("name", f"clip{len(clips)}"),
            "fps": ANIM_SAMPLE_FPS,
            "loop": 1,
            "frameCount": frame_count,
            "keys": keys,
        })

    return {"bones": bones, "clips": clips}


def read_gltf(model_name, file):
    gltf, glb_bin, base_dir = _gltf_load(file)

    _buf_cache = {}
    def buffer_bytes(bi):
        if bi in _buf_cache:
            return _buf_cache[bi]
        buf = gltf["buffers"][bi]
        uri = buf.get("uri")
        if uri is None:
            b = glb_bin
        elif uri.startswith("data:"):
            b = base64.b64decode(uri.split(",", 1)[1])
        else:
            b = (base_dir / uri).read_bytes()
        _buf_cache[bi] = b
        return b

    def read_accessor(acc_index):
        acc = gltf["accessors"][acc_index]
        bv = gltf["bufferViews"][acc["bufferView"]]
        fmt, comp_size = _GLTF_COMP[acc["componentType"]]
        ncomp = _GLTF_NCOMP[acc["type"]]
        count = acc["count"]
        buf = buffer_bytes(bv["buffer"])
        base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = bv.get("byteStride") or (comp_size * ncomp)
        normalized = acc.get("normalized", False)
        norm_div = 1.0
        if normalized:
            norm_div = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}.get(
                acc["componentType"], 1.0)
        out = []
        for i in range(count):
            vals = struct.unpack_from("<" + fmt * ncomp, buf, base + i * stride)
            if normalized:
                vals = tuple(v / norm_div for v in vals)
            out.append(vals[0] if ncomp == 1 else vals)
        return out

    # Walk the scene graph to get each node's world matrix (only meshes and
    # cameras matter). glTF may omit "scenes"; fall back to all nodes as roots.
    nodes = gltf.get("nodes", [])
    world_of = {}

    def visit(ni, parent):
        m = _mat_mul(parent, _node_local_matrix(nodes[ni]))
        world_of[ni] = m
        for c in nodes[ni].get("children", []):
            visit(c, m)

    if "scenes" in gltf and gltf.get("scene") is not None:
        roots = gltf["scenes"][gltf["scene"]].get("nodes", list(range(len(nodes))))
    elif "scenes" in gltf and gltf["scenes"]:
        roots = gltf["scenes"][0].get("nodes", list(range(len(nodes))))
    else:
        roots = list(range(len(nodes)))
    # Only visit nodes that are not children of another node (true roots).
    child_set = set()
    for n in nodes:
        for c in n.get("children", []):
            child_set.add(c)
    for ni in range(len(nodes)):
        if ni not in child_set and ni not in world_of:
            visit(ni, _mat_identity())
    # Ensure declared roots are visited too (covers explicit scene lists).
    for ni in roots:
        if ni not in world_of:
            visit(ni, _mat_identity())

    materials = gltf.get("materials", [])

    def material_name(prim):
        mi = prim.get("material")
        if mi is None:
            return "(none)"
        return materials[mi].get("name") or f"material_{mi}"

    material_name_to_index = {}
    material_index_to_name = []

    def get_material_index(name):
        if name in material_name_to_index:
            return material_name_to_index[name]
        idx = len(material_index_to_name)
        if idx >= MAX_MATERIALS_PER_MODEL:
            raise SystemExit(f"{file.name}: exceeded MAX_MATERIALS_PER_MODEL.")
        material_name_to_index[name] = idx
        material_index_to_name.append(name)
        return idx

    split_key_to_index = {}
    split_positions = []
    split_normals = []
    split_uvs = []
    split_skin = []    # per split vertex: (bone0, bone1, w0) or None (unskinned)
    face_index_lists = []
    face_material_indices = []
    raw_vertex_count = 0
    prim_bounds = []   # one (min_xyz, max_xyz) per triangle-bearing primitive
    missing_vt = False
    skin_used = None   # skin index of the (single) skinned mesh, if any

    def get_split_vertex(pos, nrm, uv, skin=None):
        key = (pos, nrm, uv)
        if key in split_key_to_index:
            return split_key_to_index[key]
        idx = len(split_positions)
        split_key_to_index[key] = idx
        split_positions.append(pos)
        split_normals.append(nrm)
        split_uvs.append(uv)
        split_skin.append(skin)
        return idx

    # Collect (world, mesh, skin) triples so mesh vertices get their node's
    # world xform, and skinned meshes carry which skin their JOINTS_0 index.
    mesh_instances = []
    for ni, node in enumerate(nodes):
        if "mesh" in node and ni in world_of:
            mesh_instances.append((world_of[ni], node["mesh"], node.get("skin")))
    # Meshes not referenced by any node (rare) - bake at identity, no skin.
    referenced = {mi for _, mi, _ in mesh_instances}
    for mi in range(len(gltf.get("meshes", []))):
        if mi not in referenced:
            mesh_instances.append((_mat_identity(), mi, None))

    for world, mesh_index, skin_index in mesh_instances:
        mesh = gltf["meshes"][mesh_index]
        for prim in mesh.get("primitives", []):
            if prim.get("mode", 4) != 4:
                print(f"  WARNING: {file.name} mesh {mesh_index} primitive mode "
                      f"{prim.get('mode')} is not TRIANGLES - skipped.")
                continue
            attrs = prim["attributes"]
            positions = read_accessor(attrs["POSITION"])
            normals = read_accessor(attrs["NORMAL"]) if "NORMAL" in attrs else None
            uvs = read_accessor(attrs["TEXCOORD_0"]) if "TEXCOORD_0" in attrs else None
            joints0  = read_accessor(attrs["JOINTS_0"])  if "JOINTS_0"  in attrs else None
            weights0 = read_accessor(attrs["WEIGHTS_0"]) if "WEIGHTS_0" in attrs else None
            if "indices" in prim:
                indices = read_accessor(prim["indices"])
            else:
                indices = list(range(len(positions)))
            raw_vertex_count += len(positions)
            mat_index = get_material_index(material_name(prim))

            # Skinned primitive: JOINTS_0 indices are relative to this mesh
            # node's skin. Its vertices are authored in mesh-local (bind) space
            # and are placed by the skeleton at runtime, NOT by the node's world
            # transform - so bake them mesh-local (eff_world = identity).
            prim_skinned = joints0 is not None and skin_index is not None
            eff_world = world
            if prim_skinned:
                if skin_used is None:
                    skin_used = skin_index
                elif skin_used != skin_index:
                    print(f"  WARNING: {file.name} references multiple skins; only "
                          f"skin {skin_used} is baked (others ignored).")
                if any(abs(world[r][c] - (1.0 if r == c else 0.0)) > 1e-4
                       for r in range(3) for c in range(4)):
                    print(f"  WARNING: {file.name} skinned mesh node has a non-identity "
                          f"world transform; baking mesh-local (skin is authoritative).")
                eff_world = _mat_identity()

            # Per-primitive collision bounds. Accumulated from the SAME
            # remapped world positions the geometry is baked from, so a
            # primitive's collider is exactly its own geometry - not the
            # whole model's.
            #
            # WHY PER PRIMITIVE AND NOT PER MODEL. A .glb routinely holds
            # several unrelated pieces: assets/object/house/house.glb has a
            # `Garage` mesh (4.91 x 3.50 x 2.95, the actual building) and a
            # flat `Plane` mesh (6.19 x 6.19 x 0, the grass around it). One
            # merged bbox is their UNION, so the house's collider became the
            # grass slab's footprint extruded to the building's height - a
            # player couldn't get within a lawn's width of the front door,
            # and the flat grass (which should be walkable floor) inherited
            # the building's height and turned into a wall.
            # Splitting per primitive gives the grass its own zero-thickness
            # box, which main.c's step tolerance then treats as floor.
            pmin = [None, None, None]
            pmax = [None, None, None]

            corner_slots = []
            for vi in indices:
                wp = _mat_point(eff_world, positions[vi])
                pos = remap_pos(*wp)
                for ax in range(3):
                    if pmin[ax] is None or pos[ax] < pmin[ax]: pmin[ax] = pos[ax]
                    if pmax[ax] is None or pos[ax] > pmax[ax]: pmax[ax] = pos[ax]
                if normals is not None:
                    wn = _mat_dir(eff_world, normals[vi])
                    nrm = remap_dir(*wn)
                else:
                    nrm = None
                if uvs is not None:
                    u, v = uvs[vi][0], uvs[vi][1]
                    # glTF UV origin is already TOP-left (PS1 convention) - no flip.
                    uv = (u, v)
                else:
                    uv = None
                    missing_vt = True
                if prim_skinned:
                    js, qs = _top_influences(joints0[vi], weights0[vi], SKIN_MAX_INFLUENCES)
                    vskin = (js[0], js[1], qs[0])   # (bone0, bone1, w0); w1 = 255 - w0
                else:
                    vskin = None
                corner_slots.append(get_split_vertex(pos, nrm, uv, vskin))

            tri_before = len(face_index_lists)
            for t in range(0, len(corner_slots) - 2, 3):
                face_index_lists.append((corner_slots[t], corner_slots[t+1], corner_slots[t+2]))
                face_material_indices.append(mat_index)

            # Only record a collider for a primitive that actually contributed
            # triangles - an empty one has no surface to collide with, and a
            # bounds entry for it would be a phantom box.
            if len(face_index_lists) > tri_before and pmin[0] is not None:
                prim_bounds.append((tuple(pmin), tuple(pmax)))

    # Camera: first node that references a camera. Its world position + the
    # -Z look axis (glTF camera convention) -> engine space.
    camera = None
    for ni, node in enumerate(nodes):
        if "camera" in node and ni in world_of:
            m = world_of[ni]
            pos = remap_pos(m[0][3], m[1][3], m[2][3])
            fwd_gltf = _mat_dir(m, (0.0, 0.0, -1.0))
            fx, fy, fz = remap_dir(*fwd_gltf)
            yaw = _rad_to_12bit(math.atan2(fx, fz))
            horiz = math.sqrt(fx*fx + fz*fz)
            pitch = _rad_to_12bit(math.atan2(fy, horiz))
            camera = {"pos": pos, "rot": (pitch, yaw, 0)}
            print(f"  glTF camera node {ni} ('{node.get('name','')}') "
                  f"-> pos {pos}, look ({fx:.3f},{fy:.3f},{fz:.3f})")
            break

    if missing_vt:
        print(f"  WARNING: {file.name} has vertices with no TEXCOORD_0 ({{0,0}} placeholders).")

    # ---- Skeleton + animation clips (only when a skinned mesh was found) ----
    rig = None
    vert_skin = None
    if skin_used is not None:
        rig = _extract_rig(gltf, read_accessor, nodes, skin_used, model_name)
        # Parallel to split vertices; unskinned splits (mixed models) bind fully
        # to bone 0 so the array is always safe to index at runtime.
        vert_skin = [s if s is not None else (0, 0, 255) for s in split_skin]
        total_frames = sum(c["frameCount"] for c in rig["clips"])
        print(f"  Rig: {len(rig['bones'])} bones, {len(rig['clips'])} clip(s), "
              f"{total_frames} total frames @ {ANIM_SAMPLE_FPS}fps")
        for c in rig["clips"]:
            print(f"    clip '{c['name']}': {c['frameCount']} frames")

    print(f"\nParsed {file.name} (model '{model_name}', glTF)")
    print(f"materials: {len(material_index_to_name)} distinct -> {material_index_to_name}")

    return {
        "rig": rig,
        "vert_skin": vert_skin,
        "split_positions": split_positions,
        "split_normals": split_normals,
        "split_uvs": split_uvs,
        "faces": face_index_lists,
        "face_materials": face_material_indices,
        "material_names": material_index_to_name,
        "prim_bounds": prim_bounds,
        "camera": camera,
        "src_rel": file.relative_to(PROJECT_ROOT).as_posix(),
        "raw_v_count": raw_vertex_count,
    }


# ==================================================================
# Discovery: per assets/object/<name>/, take <name>.glb (then <name>.gltf).
# ==================================================================
discovered_models = []  # (folder_name, path, reader)

for folder in sorted(ORIGIN_OBJECT_DIR.iterdir()):
    if not folder.is_dir():
        continue
    name = folder.name
    glb = folder / f"{name}.glb"
    gltf = folder / f"{name}.gltf"
    if glb.exists():
        discovered_models.append((name, glb, read_gltf))
    elif gltf.exists():
        discovered_models.append((name, gltf, read_gltf))
    else:
        print(f"NOTE: {name}/ has no {name}.glb/.gltf (per-object naming "
              f"convention) - skipped.")


model_registry_entries = []

for model_name, file, reader in discovered_models:
    ident = sanitize_identifier(model_name)
    ir = reader(model_name, file)
    entry = emit_model_c(model_name, ident, ir)
    if entry is not None:
        model_registry_entries.append(entry)


# ------------------------------------------------------------------
# Shared header - MODEL_TRI + MODEL_DEF struct definitions.
# ------------------------------------------------------------------
header_lines = []
header_lines.append("/* Auto-generated by py_convert_assets.py. Do not edit manually.\n")
header_lines.append(" * Included by every generated/<model>.c file, generated/model_registry.c,\n")
header_lines.append(" * and main.c - keep this the ONLY place MODEL_TRI/MODEL_DEF are defined. */\n\n")
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
header_lines.append("// ---- Skeletal animation (Phase 1) ---------------------------------\n")
header_lines.append("// Emitted ONLY for skinned models; MODEL_DEF's rig pointers stay 0 on\n")
header_lines.append("// static models. Fixed point: rotations/quaternions use ONE==4096 for\n")
header_lines.append("// 1.0 (matching the GTE / RotMatrix()); ALL translations use the 1024\n")
header_lines.append("// vertex-coordinate scale so skin math shares the SVECTOR integer space.\n")
header_lines.append("// Everything is baked in ENGINE space (already remap-conjugated) so the\n")
header_lines.append("// runtime composes bones with plain matrix multiplies - no remap on-console.\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    short parent;    // index into bones[]; -1 for the root. bones[] are\n")
header_lines.append("                     // ordered parents-first, so one forward pass composes.\n")
header_lines.append("    MATRIX invBind;  // engine-space inverse bind (model->bone), rot@4096 t@1024\n")
header_lines.append("} BONE_DEF;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned char bone0;  // dominant bone (the only one the 1-bone path uses)\n")
header_lines.append("    unsigned char bone1;  // second-heaviest bone\n")
header_lines.append("    unsigned char w0;     // weight of bone0, 0..255; w1 = 255 - w0\n")
header_lines.append("} VERT_SKIN;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    short qx, qy, qz, qw;  // local rotation quaternion, 4096 == 1.0\n")
header_lines.append("    int   tx, ty, tz;      // local translation, 1024 == 1 model unit\n")
header_lines.append("} BONE_KEY;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *name;\n")
header_lines.append("    unsigned short frameCount;  // keyframes per bone track (uniform grid)\n")
header_lines.append("    unsigned short fps;         // sample rate of that grid\n")
header_lines.append("    unsigned char  loop;        // 1 = wrap, 0 = clamp at the ends\n")
header_lines.append("    const BONE_KEY *keys;       // [bone*frameCount + frame]\n")
header_lines.append("} ANIM_CLIP;\n\n")
header_lines.append("// One entry per discovered model. Pointer fields point at that model's own\n")
header_lines.append("// prefixed arrays (<name>_modelVerts, <name>_modelTris, etc.); main.c resolves\n")
header_lines.append("// a stage object's \"model\" name against modelRegistry[] once at stage load.\n")
header_lines.append("//\n")
header_lines.append("// hasCamera/cameraPos/cameraRot carry an OPTIONAL authored camera (glTF only;\n")
header_lines.append("// OBJ never has one). Baked as data now; the follow-cam does not consume it\n")
header_lines.append("// yet. cameraRot is in the 12-bit angle format but its euler convention is\n")
header_lines.append("// PROVISIONAL until the follow-cam is wired to it.\n")
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
header_lines.append("    int bsphereRadius;\n\n")
header_lines.append("    // PER-PRIMITIVE collision bounds - one entry per glTF primitive that\n")
header_lines.append("    // carries triangles. Separate from bboxMin/bboxMax above, which is the\n")
header_lines.append("    // whole-model box used for RENDER CULLING; these describe the model as a\n")
header_lines.append("    // SOLID and are what main.c's build_stage_colliders() turns into\n")
header_lines.append("    // COLLIDER_BOXes.\n")
header_lines.append("    //\n")
header_lines.append("    // The split matters because a .glb routinely holds unrelated pieces:\n")
header_lines.append("    // house.glb is a building mesh plus a flat grass plane, and one merged\n")
header_lines.append("    // box around both made the building's collider the size of its lawn.\n")
header_lines.append("    // NULL/0 on a model that baked no bounds (no drawable geometry).\n")
header_lines.append("    SVECTOR *collMin;\n")
header_lines.append("    SVECTOR *collMax;\n")
header_lines.append("    unsigned int collCount;\n\n")
header_lines.append("    int hasCamera;\n")
header_lines.append("    VECTOR *cameraPos;\n")
header_lines.append("    SVECTOR *cameraRot;\n\n")
header_lines.append("    // Skeletal rig - all NULL/0 on static models. bones[] and clips[] are\n")
header_lines.append("    // this model's own prefixed arrays; vertSkin[] is parallel to verts[].\n")
header_lines.append("    const BONE_DEF  *bones;\n")
header_lines.append("    unsigned int    boneCount;\n")
header_lines.append("    const VERT_SKIN *vertSkin;\n")
header_lines.append("    const ANIM_CLIP *clips;\n")
header_lines.append("    unsigned int    clipCount;\n")
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
    if entry["has_camera"]:
        cam = f"1, &{ident}_modelCameraPos, &{ident}_modelCameraRot"
    else:
        cam = "0, 0, 0"
    # A model with no drawable geometry bakes no collision bounds; NULL/0 here
    # makes build_stage_colliders() count it in SKIP rather than dereference.
    if entry["has_coll"]:
        coll = f"{ident}_modelCollMin, {ident}_modelCollMax, {ident}_modelCollCount"
    else:
        coll = "0, 0, 0"
    # Rig: skeleton, per-vertex skin and clips - NULL/0 on every static model.
    if entry.get("has_rig"):
        rig = (f"{ident}_modelBones, {ident}_modelBoneCount, "
               f"{ident}_modelVertSkin, {ident}_modelClips, {ident}_modelClipCount")
    else:
        rig = "0, 0, 0, 0, 0"
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f"{ident}_modelVerts, {ident}_modelVertCount, "
        f"{ident}_modelTris, {ident}_modelTriCount, "
        f"{ident}_modelFaceNormals, {ident}_modelVertNormals, {ident}_modelUVs, "
        f"{ident}_modelMaterialNames, {ident}_modelMaterialCount, "
        f"&{ident}_modelBBoxMin, &{ident}_modelBBoxMax, "
        f"&{ident}_modelBSphereCenter, {ident}_modelBSphereRadius, "
        f"{coll}, "
        f"{cam}, "
        f"{rig} }},\n"
    )
registry_lines.append("};\n")

(CONVERT_OBJECT_DIR / "model_registry.c").write_text("".join(registry_lines), newline="\n")
print(f"Generated: {CONVERT_OBJECT_DIR / 'model_registry.c'} ({len(model_registry_entries)} model(s))")


# ------------------------------------------------------------------
# Manifest - #include'd ONCE from main.c.
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
