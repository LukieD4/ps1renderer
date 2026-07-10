# root/py_convert_scenes.py

import json, re
from pathlib import Path

# Run after py_convert_assets.py! (Not a hard runtime requirement - scene
# objects reference model names as plain strings, resolved by main.c at
# scene-load time against modelRegistry[], not by this script - but
# keeping the same ordering convention as py_convert_textures.py avoids
# surprises if that ever changes.)
#
# This script does NOT wipe generated/ (only py_convert_assets.py does
# that, and it must run first for that reason) - it only ever
# creates/overwrites its own fixed set of scene_*.c/.h files, the same
# non-destructive pattern py_convert_textures.py already uses for the
# texture blob.

ROOT_DIR = Path(__file__).resolve().parent
SCENES_DIR = ROOT_DIR / "scenes"
GENERATED_DIR = ROOT_DIR / "generated"

# ------------------------------------------------------------------
# Fixed-point conventions, matching main.c / py_convert_assets.py:
#   pos/rot in scene.json are authored directly in ENGINE fixed-point
#   units (NOT re-scaled here) - e.g. the house_demo camera pos
#   [0,0,-4096] matches CAMERA_DISTANCE, and rot 1024 matches the
#   12-bit "1024 == 90 degrees" angle format model_rot/camera.rot
#   already use. This mirrors how the demo scene.json was hand-authored.
#   scale, on the other hand, is authored as a human multiplier (1.0 ==
#   normal size) and IS upscaled here to 4096-per-1.0 fixed point - the
#   same fixed point RotMatrix()'s own m[][] output uses - so main.c can
#   apply it as a cheap column-scale on the rotation matrix (see
#   update_object_world_and_compose() in main.c) instead of touching
#   every vertex per object per frame.
# ------------------------------------------------------------------
SCALE_UPSCALE = 4096
ROT_MASK = 4095  # 12-bit angle wraparound, same as "model_rot.vx &= 4095" in main.c


def sanitize_identifier(name):
    ident = re.sub(r"[^0-9A-Za-z_]", "_", name)
    if not ident or ident[0].isdigit():
        ident = "_" + ident
    return ident


def strip_json_comments(text):
    """
    scene.json files use '// comment' line comments (see house_demo's
    scene.json, whose very first line is one) - plain json.loads()
    rejects those outright. This strips '//' to end-of-line, tracking
    double-quote state char-by-char so it doesn't eat a '//' that
    legitimately appears inside a JSON string value.
    """
    out = []
    in_string = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] not in ("\n", "\r"):
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def load_scene_json(path):
    raw = path.read_text()
    stripped = strip_json_comments(raw)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path}: invalid scene JSON after comment-stripping: {e}")


def as_vec3(values, label, path):
    if not (isinstance(values, list) and len(values) == 3):
        raise SystemExit(f"{path}: '{label}' must be a 3-element array, got {values!r}")
    return tuple(int(round(float(v))) for v in values)


def as_scale_vec3(values, path):
    if not (isinstance(values, list) and len(values) == 3):
        raise SystemExit(f"{path}: 'scale' must be a 3-element array, got {values!r}")
    return tuple(int(round(float(v) * SCALE_UPSCALE)) for v in values)


GENERATED_DIR.mkdir(parents=True, exist_ok=True)

scene_dirs = sorted(p.parent for p in SCENES_DIR.glob("*/scene.json")) if SCENES_DIR.exists() else []

if not scene_dirs:
    print("No scenes/*/scene.json found - nothing to do.")

scene_entries = []  # dicts: name, ident, cam_pos, cam_rot (object arrays written to disk immediately below)

for scene_dir in scene_dirs:
    scene_path = scene_dir / "scene.json"
    scene_name = scene_dir.name
    ident = sanitize_identifier(scene_name)

    scene = load_scene_json(scene_path)

    camera = scene.get("camera", {})
    cam_pos = as_vec3(camera.get("pos", [0, 0, 0]), "camera.pos", scene_path)
    cam_rot_raw = as_vec3(camera.get("rot", [0, 0, 0]), "camera.rot", scene_path)
    cam_rot = tuple(v & ROT_MASK for v in cam_rot_raw)

    objects = scene.get("objects", [])

    output = []
    output.append(f"/* Auto-generated from {scene_path.relative_to(ROOT_DIR).as_posix()}.\n")
    output.append(" * Do not edit manually. */\n\n")
    output.append('#include "scene_common.h"\n\n')

    output.append(f"const SCENE_OBJECT {ident}_objects[] = {{\n")

    object_count = 0
    for obj_index, obj in enumerate(objects):
        if "model" not in obj:
            raise SystemExit(f"{scene_path}: objects[{obj_index}] is missing required 'model'")

        model_name = obj["model"]
        palette = int(obj.get("palette", 0))
        pos = as_vec3(obj.get("pos", [0, 0, 0]), f"objects[{obj_index}].pos", scene_path)
        rot_raw = as_vec3(obj.get("rot", [0, 0, 0]), f"objects[{obj_index}].rot", scene_path)
        rot = tuple(v & ROT_MASK for v in rot_raw)
        scale = as_scale_vec3(obj.get("scale", [1, 1, 1]), scene_path)

        escaped_model = model_name.replace("\\", "\\\\").replace('"', '\\"')

        output.append(
            f'    {{ "{escaped_model}", {palette}, '
            f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
            f"{{ {rot[0]}, {rot[1]}, {rot[2]} }}, "
            f"{{ {scale[0]}, {scale[1]}, {scale[2]} }} }},\n"
        )
        object_count += 1

    output.append("};\n\n")
    output.append(f"const unsigned int {ident}_objectCount = {object_count};\n")

    scene_c_path = GENERATED_DIR / f"scene_{ident}.c"
    scene_c_path.write_text("".join(output), newline="\n")
    print(f"Generated: {scene_c_path} ({object_count} object(s))")

    scene_entries.append({
        "name": scene_name,
        "ident": ident,
        "cam_pos": cam_pos,
        "cam_rot": cam_rot,
    })

# ------------------------------------------------------------------
# Shared header - SCENE_OBJECT/SCENE_DEF struct definitions, ONE place
# only (same "don't redefine a shared struct N times" reasoning as
# model_common.h / tex_blob_table.h).
# ------------------------------------------------------------------
header_lines = []
header_lines.append("/* Auto-generated by py_convert_scenes.py. Do not edit manually.\n")
header_lines.append(" * Included by every generated/scene_*.c file, generated/scene_registry.c,\n")
header_lines.append(" * and main.c - keep this the ONLY place SCENE_OBJECT/SCENE_DEF are defined. */\n\n")
header_lines.append("#ifndef SCENE_COMMON_H\n#define SCENE_COMMON_H\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *model;     // resolved against modelRegistry[] by name at scene-load time\n")
header_lines.append("    unsigned char palette; // base palette row for this placed instance (see active_palette in main.c)\n")
header_lines.append("    VECTOR  pos;           // world position, same fixed-point space as CAMERA.pos\n")
header_lines.append("    SVECTOR rot;           // 12-bit fixed-point XYZ angle, same format as model_rot\n")
header_lines.append("    VECTOR  scale;         // per-axis scale, 4096 == 1.0 (same fixed point RotMatrix() m[][] uses)\n")
header_lines.append("} SCENE_OBJECT;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *name;\n")
header_lines.append("    VECTOR  cameraPos;\n")
header_lines.append("    SVECTOR cameraRot;\n")
header_lines.append("    const SCENE_OBJECT *objects;\n")
header_lines.append("    unsigned int objectCount;\n")
header_lines.append("} SCENE_DEF;\n\n")
header_lines.append("extern const unsigned int sceneRegistryCount;\n")
header_lines.append("extern const SCENE_DEF sceneRegistry[];\n\n")
header_lines.append("#endif\n")

(GENERATED_DIR / "scene_common.h").write_text("".join(header_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'scene_common.h'}")

# ------------------------------------------------------------------
# Registry - one entry per discovered scenes/*/scene.json.
# ------------------------------------------------------------------
registry_lines = []
registry_lines.append("/* Auto-generated by py_convert_scenes.py. Do not edit manually. */\n\n")
registry_lines.append('#include "scene_common.h"\n\n')
registry_lines.append(f"const unsigned int sceneRegistryCount = {len(scene_entries)};\n")
registry_lines.append("const SCENE_DEF sceneRegistry[] = {\n")
for entry in scene_entries:
    escaped_name = entry["name"].replace("\\", "\\\\").replace('"', '\\"')
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f'{{ {entry["cam_pos"][0]}, {entry["cam_pos"][1]}, {entry["cam_pos"][2]} }}, '
        f'{{ {entry["cam_rot"][0]}, {entry["cam_rot"][1]}, {entry["cam_rot"][2]} }}, '
        f'{entry["ident"]}_objects, {entry["ident"]}_objectCount }},\n'
    )
registry_lines.append("};\n")

(GENERATED_DIR / "scene_registry.c").write_text("".join(registry_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'scene_registry.c'} ({len(scene_entries)} scene(s))")

# ------------------------------------------------------------------
# Manifest - #include'd ONCE from main.c.
# ------------------------------------------------------------------
manifest_lines = []
manifest_lines.append("/* Auto-generated by py_convert_scenes.py. Do not edit manually.\n")
manifest_lines.append(" * #include this ONCE from main.c - lists every discovered scene. */\n\n")
manifest_lines.append('#include "scene_common.h"\n')
for entry in scene_entries:
    manifest_lines.append(f'#include "scene_{entry["ident"]}.c"\n')
manifest_lines.append('#include "scene_registry.c"\n')

(GENERATED_DIR / "scenes_all.h").write_text("".join(manifest_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'scenes_all.h'}")
