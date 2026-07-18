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

    return {"name": model_name, "ident": ident, "has_camera": has_camera}


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
    face_index_lists = []
    face_material_indices = []
    raw_vertex_count = 0
    missing_vt = False

    def get_split_vertex(pos, nrm, uv):
        key = (pos, nrm, uv)
        if key in split_key_to_index:
            return split_key_to_index[key]
        idx = len(split_positions)
        split_key_to_index[key] = idx
        split_positions.append(pos)
        split_normals.append(nrm)
        split_uvs.append(uv)
        return idx

    # Collect (node, mesh) pairs so mesh vertices get their node's world xform.
    mesh_instances = []
    for ni, node in enumerate(nodes):
        if "mesh" in node and ni in world_of:
            mesh_instances.append((world_of[ni], node["mesh"]))
    # Meshes not referenced by any node (rare) - bake at identity.
    referenced = {mi for _, mi in mesh_instances}
    for mi in range(len(gltf.get("meshes", []))):
        if mi not in referenced:
            mesh_instances.append((_mat_identity(), mi))

    for world, mesh_index in mesh_instances:
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
            if "indices" in prim:
                indices = read_accessor(prim["indices"])
            else:
                indices = list(range(len(positions)))
            raw_vertex_count += len(positions)
            mat_index = get_material_index(material_name(prim))

            corner_slots = []
            for vi in indices:
                wp = _mat_point(world, positions[vi])
                pos = remap_pos(*wp)
                if normals is not None:
                    wn = _mat_dir(world, normals[vi])
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
                corner_slots.append(get_split_vertex(pos, nrm, uv))

            for t in range(0, len(corner_slots) - 2, 3):
                face_index_lists.append((corner_slots[t], corner_slots[t+1], corner_slots[t+2]))
                face_material_indices.append(mat_index)

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

    print(f"\nParsed {file.name} (model '{model_name}', glTF)")
    print(f"materials: {len(material_index_to_name)} distinct -> {material_index_to_name}")

    return {
        "split_positions": split_positions,
        "split_normals": split_normals,
        "split_uvs": split_uvs,
        "faces": face_index_lists,
        "face_materials": face_material_indices,
        "material_names": material_index_to_name,
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
header_lines.append("    int hasCamera;\n")
header_lines.append("    VECTOR *cameraPos;\n")
header_lines.append("    SVECTOR *cameraRot;\n")
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
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f"{ident}_modelVerts, {ident}_modelVertCount, "
        f"{ident}_modelTris, {ident}_modelTriCount, "
        f"{ident}_modelFaceNormals, {ident}_modelVertNormals, {ident}_modelUVs, "
        f"{ident}_modelMaterialNames, {ident}_modelMaterialCount, "
        f"&{ident}_modelBBoxMin, &{ident}_modelBBoxMax, "
        f"&{ident}_modelBSphereCenter, {ident}_modelBSphereRadius, "
        f"{cam} }},\n"
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
