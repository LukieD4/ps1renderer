# root/py_convert_stages.py

import json, re
from pathlib import Path

# Run after py_convert_assets.py! (Not a hard runtime requirement - stage
# objects reference model names as plain strings, resolved by main.c at
# stage-load time against modelRegistry[], not by this script - but
# keeping the same ordering convention as py_convert_textures.py avoids
# surprises if that ever changes.)
#
# This script does NOT wipe generated/ (only py_convert_assets.py does
# that, and it must run first for that reason) - it only ever
# creates/overwrites its own fixed set of stage_*.c/.h files, the same
# non-destructive pattern py_convert_textures.py already uses for the
# texture blob.

ROOT_DIR = Path(__file__).resolve().parent
STAGES_DIR = ROOT_DIR / "assets" / "stage"
GENERATED_DIR = ROOT_DIR / "generated"

# ------------------------------------------------------------------
# Fixed-point conventions, matching main.c / py_convert_assets.py:
#   pos/rot in stage.json are authored directly in ENGINE fixed-point
#   units (NOT re-scaled here) - e.g. the house_demo camera pos
#   [0,0,-4096] matches CAMERA_DISTANCE, and rot 1024 matches the
#   12-bit "1024 == 90 degrees" angle format model_rot/camera.rot
#   already use. This mirrors how the demo stage.json was hand-authored.
#   scale, on the other hand, is authored as a human multiplier (1.0 ==
#   normal size) and IS upscaled here to 4096-per-1.0 fixed point - the
#   same fixed point RotMatrix()'s own m[][] output uses - so main.c can
#   apply it as a cheap column-scale on the rotation matrix (see
#   update_object_world_and_compose() in main.c) instead of touching
#   every vertex per object per frame.
# ------------------------------------------------------------------
SCALE_UPSCALE = 4096
ROT_MASK = 4095  # 12-bit angle wraparound, same as "model_rot.vx &= 4095" in main.c

# Sound volume: stage.json authors a human 0-1 float (same "human
# multiplier" convention as object scale); the SPU's per-voice volume
# registers are 0..0x3fff, so it's scaled here - see sfx.c.
SPU_VOLUME_MAX = 0x3FFF

# Sound play modes: stage.json's human-readable string -> the STAGE_SOUND
# mode byte sfx.c switches on. Keep in sync with sfx.h's SFX_MODE_* defines.
# "music" is special: the sample names a VAB+SEQ pair in assets/sound/music/
# (played by music.c), not a .vag - see the mode handling below.
SOUND_MODES = {"loop": 0, "once": 1, "interval": 2, "music": 3}

# Interval bounds are authored in SECONDS but the runtime counts frames
# (sfx_tick() runs once per displayed frame, VSync-cadenced like
# music_tick() - see MUSIC_VSYNC_HZ in music.h).
SOUND_TICK_HZ = 60
SOUND_INTERVAL_FRAMES_MAX = 0xFFFF  # uint16 field - ~18 minutes, plenty


def sanitize_identifier(name):
    ident = re.sub(r"[^0-9A-Za-z_]", "_", name)
    if not ident or ident[0].isdigit():
        ident = "_" + ident
    return ident


def strip_json_comments(text):
    """
    stage.json files use '// comment' line comments (see house_demo's
    stage.json, whose very first line is one) - plain json.loads()
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


def load_stage_json(path):
    raw = path.read_text()
    stripped = strip_json_comments(raw)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path}: invalid stage JSON after comment-stripping: {e}")


def as_vec3(values, label, path):
    if not (isinstance(values, list) and len(values) == 3):
        raise SystemExit(f"{path}: '{label}' must be a 3-element array, got {values!r}")
    return tuple(int(round(float(v))) for v in values)


def as_scale_vec3(values, path):
    if not (isinstance(values, list) and len(values) == 3):
        raise SystemExit(f"{path}: 'scale' must be a 3-element array, got {values!r}")
    return tuple(int(round(float(v) * SCALE_UPSCALE)) for v in values)


def sample_to_cd_path(sample, label, path, ext="VAG"):
    """
    Map a stage-gen sound entity's free-text sample name to the CD path
    the runtime will CdSearchFile(): "wind" -> "\\WIND.VAG;1" (sfx.c),
    or with ext="VAB"/"SEQ" for music-mode entities -> "\\NAME.VAB;1"
    (music.c). Same 8.3-uppercase convention iso.xml uses - the name is
    validated here (fail the CONVERT loudly on a name that could never
    exist on an ISO9660 disc) but whether the file is actually ON the
    disc is resolved at RUNTIME, exactly like stage object model names
    against modelRegistry[]: a missing file degrades to silence and
    shows up on the debug overlay.
    """
    name = sample.strip().upper()
    if not re.fullmatch(r"[A-Z0-9_]{1,8}", name):
        raise SystemExit(
            f"{path}: {label} sample {sample!r} is not a valid 8.3 base name "
            f"(1-8 chars, A-Z 0-9 _ only - it becomes <NAME>.{ext} on the disc)"
        )
    return f"\\{name}.{ext};1"


GENERATED_DIR.mkdir(parents=True, exist_ok=True)

stage_dirs = sorted(p.parent for p in STAGES_DIR.glob("*/stage.json")) if STAGES_DIR.exists() else []

if not stage_dirs:
    print("No assets/stage/*/stage.json found - nothing to do.")

stage_entries = []  # dicts: name, ident, cam_pos, cam_rot (object arrays written to disk immediately below)

for stage_dir in stage_dirs:
    stage_path = stage_dir / "stage.json"
    stage_name = stage_dir.name
    ident = sanitize_identifier(stage_name)

    stage = load_stage_json(stage_path)

    camera = stage.get("camera", {})
    cam_pos = as_vec3(camera.get("pos", [0, 0, 0]), "camera.pos", stage_path)
    cam_rot_raw = as_vec3(camera.get("rot", [0, 0, 0]), "camera.rot", stage_path)
    cam_rot = tuple(v & ROT_MASK for v in cam_rot_raw)

    objects = stage.get("objects", [])

    output = []
    output.append(f"/* Auto-generated from {stage_path.relative_to(ROOT_DIR).as_posix()}.\n")
    output.append(" * Do not edit manually. */\n\n")
    output.append('#include "stage_common.h"\n\n')

    output.append(f"const STAGE_OBJECT {ident}_objects[] = {{\n")

    object_count = 0
    for obj_index, obj in enumerate(objects):
        if "model" not in obj:
            raise SystemExit(f"{stage_path}: objects[{obj_index}] is missing required 'model'")

        model_name = obj["model"]
        palette = int(obj.get("palette", 0))
        pos = as_vec3(obj.get("pos", [0, 0, 0]), f"objects[{obj_index}].pos", stage_path)
        rot_raw = as_vec3(obj.get("rot", [0, 0, 0]), f"objects[{obj_index}].rot", stage_path)
        rot = tuple(v & ROT_MASK for v in rot_raw)
        scale = as_scale_vec3(obj.get("scale", [1, 1, 1]), stage_path)

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

    # ------------------------------------------------------------------
    # Sounds - optional "sounds" array (exported by stage-gen's sound
    # entities, the first entity kind with a runtime loader - see
    # stage_export.js). Absent/empty is fine (older stage.json files
    # predate sounds entirely): the registry entry then carries a NULL
    # pointer and count 0, and no <ident>_sounds[] array is emitted at
    # all (an empty array initializer isn't valid C).
    # ------------------------------------------------------------------
    sounds = stage.get("sounds", [])
    sound_count = 0

    if sounds:
        output.append(f"\nconst STAGE_SOUND {ident}_sounds[] = {{\n")
        for snd_index, snd in enumerate(sounds):
            if "sample" not in snd:
                raise SystemExit(f"{stage_path}: sounds[{snd_index}] is missing required 'sample'")

            pos = as_vec3(snd.get("pos", [0, 0, 0]), f"sounds[{snd_index}].pos", stage_path)

            volume = float(snd.get("volume", 0.5))
            volume = max(0.0, min(1.0, volume))
            volume_spu = int(round(volume * SPU_VOLUME_MAX))

            radius = int(round(float(snd.get("radius", 0))))

            # Play mode: "mode" string is the current format; a bare
            # legacy "loop" bool (the first sounds format) still maps
            # sensibly (true -> loop, false -> once) so early stage.json
            # exports keep converting.
            if "mode" in snd:
                mode_name = snd["mode"]
                if mode_name not in SOUND_MODES:
                    raise SystemExit(
                        f"{stage_path}: sounds[{snd_index}].mode {mode_name!r} "
                        f"must be one of {sorted(SOUND_MODES)}"
                    )
            else:
                mode_name = "loop" if snd.get("loop", True) else "once"
            mode = SOUND_MODES[mode_name]

            # CD paths: music entities name a VAB+SEQ pair (cd_path =
            # VAB, cd_path2 = SEQ, both from the same base name -
            # assets/sound/music/<NAME>.*, shipped by py_convert_sounds
            # .py); every other mode is a single .vag (cd_path2 = NULL).
            if mode_name == "music":
                cd_path = sample_to_cd_path(snd["sample"], f"sounds[{snd_index}]", stage_path, ext="VAB")
                cd_path2 = sample_to_cd_path(snd["sample"], f"sounds[{snd_index}]", stage_path, ext="SEQ")
            else:
                cd_path = sample_to_cd_path(snd["sample"], f"sounds[{snd_index}]", stage_path)
                cd_path2 = None

            fade_on_enter = 1 if snd.get("fadeOnStageEnter", True) else 0

            def seconds_to_frames(value):
                frames = int(round(max(0.0, float(value)) * SOUND_TICK_HZ))
                return min(frames, SOUND_INTERVAL_FRAMES_MAX)

            delay = seconds_to_frames(snd.get("delay", 0))

            interval_min = seconds_to_frames(snd.get("intervalMin", 2))
            interval_max = seconds_to_frames(snd.get("intervalMax", 8))
            if interval_max < interval_min:
                interval_min, interval_max = interval_max, interval_min

            directional = 1 if snd.get("directional", False) else 0
            mute_after = 1 if snd.get("muteAfterPlay", False) else 0
            autoplay = 1 if snd.get("autoplay", True) else 0

            escaped_cd_path = cd_path.replace("\\", "\\\\")
            if cd_path2 is None:
                cd_path2_c = "0"
            else:
                cd_path2_c = '"' + cd_path2.replace("\\", "\\\\") + '"'
            output.append(
                f'    {{ "{escaped_cd_path}", {cd_path2_c}, '
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{volume_spu}, {radius}, "
                f"{mode}, {directional}, {mute_after}, {autoplay}, {fade_on_enter}, "
                f"{delay}, {interval_min}, {interval_max} }},\n"
            )
            sound_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_soundCount = {sound_count};\n")

    stage_c_path = GENERATED_DIR / f"stage_{ident}.c"
    stage_c_path.write_text("".join(output), newline="\n")
    print(f"Generated: {stage_c_path} ({object_count} object(s), {sound_count} sound(s))")

    stage_entries.append({
        "name": stage_name,
        "ident": ident,
        "cam_pos": cam_pos,
        "cam_rot": cam_rot,
        "sound_count": sound_count,
    })

# ------------------------------------------------------------------
# Shared header - STAGE_OBJECT/STAGE_DEF struct definitions, ONE place
# only (same "don't redefine a shared struct N times" reasoning as
# model_common.h / tex_blob_table.h).
# ------------------------------------------------------------------
header_lines = []
header_lines.append("/* Auto-generated by py_convert_stages.py. Do not edit manually.\n")
header_lines.append(" * Included by every generated/stage_*.c file, generated/stage_registry.c,\n")
header_lines.append(" * and main.c - keep this the ONLY place STAGE_OBJECT/STAGE_DEF are defined. */\n\n")
header_lines.append("#ifndef STAGE_COMMON_H\n#define STAGE_COMMON_H\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *model;     // resolved against modelRegistry[] by name at stage-load time\n")
header_lines.append("    unsigned char palette; // base palette row for this placed instance (see active_palette in main.c)\n")
header_lines.append("    VECTOR  pos;           // world position, same fixed-point space as CAMERA.pos\n")
header_lines.append("    SVECTOR rot;           // 12-bit fixed-point XYZ angle, same format as model_rot\n")
header_lines.append("    VECTOR  scale;         // per-axis scale, 4096 == 1.0 (same fixed point RotMatrix() m[][] uses)\n")
header_lines.append("} STAGE_OBJECT;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append('    const char *cdPath;        // full CD path - "\\\\WIND.VAG;1" for sfx modes (sfx.c), the "\\\\NAME.VAB;1" bank for music mode (music.c)\n')
header_lines.append('    const char *cdPath2;       // music mode only: the "\\\\NAME.SEQ;1" score path; NULL for every other mode\n')
header_lines.append("    VECTOR pos;                // emitter world position, same fixed-point space as STAGE_OBJECT.pos\n")
header_lines.append("    unsigned short volume;     // per-voice SPU volume, 0..0x3fff (scaled from stage.json's human 0-1 float at convert time)\n")
header_lines.append("    unsigned int radius;       // directional falloff radius in world units, 0 = no distance falloff (pan still applies)\n")
header_lines.append("    unsigned char mode;        // SFX_MODE_LOOP / _ONCE / _INTERVAL (see sfx.h; baked from stage.json's mode string)\n")
header_lines.append("    unsigned char directional; // 1 = per-frame distance falloff + stereo pan from the camera (sfx_tick)\n")
header_lines.append("    unsigned char muteAfterPlay; // 1 = after one completed playthrough, force silent and never retrigger (ignored by loop mode)\n")
header_lines.append("    unsigned char autoplay;    // 1 = start as soon as the stage loads\n")
header_lines.append("    unsigned char fadeOnStageEnter; // music mode: cross-fade in on a live stage transition (future system; baked now so stages author it ahead of time)\n")
header_lines.append("    unsigned short delayFrames; // frames before the FIRST play, any mode (0 = immediate)\n")
header_lines.append("    unsigned short intervalMinFrames; // interval mode: random re-fire delay bounds, in VSync frames\n")
header_lines.append("    unsigned short intervalMaxFrames;\n")
header_lines.append("} STAGE_SOUND;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *name;\n")
header_lines.append("    VECTOR  cameraPos;\n")
header_lines.append("    SVECTOR cameraRot;\n")
header_lines.append("    const STAGE_OBJECT *objects;\n")
header_lines.append("    unsigned int objectCount;\n")
header_lines.append("    const STAGE_SOUND *sounds; // NULL when the stage authors no sounds\n")
header_lines.append("    unsigned int soundCount;\n")
header_lines.append("} STAGE_DEF;\n\n")
header_lines.append("extern const unsigned int stageRegistryCount;\n")
header_lines.append("extern const STAGE_DEF stageRegistry[];\n\n")
header_lines.append("#endif\n")

(GENERATED_DIR / "stage_common.h").write_text("".join(header_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'stage_common.h'}")

# ------------------------------------------------------------------
# Registry - one entry per discovered assets/stage/*/stage.json.
# ------------------------------------------------------------------
registry_lines = []
registry_lines.append("/* Auto-generated by py_convert_stages.py. Do not edit manually. */\n\n")
registry_lines.append('#include "stage_common.h"\n\n')
registry_lines.append(f"const unsigned int stageRegistryCount = {len(stage_entries)};\n")
registry_lines.append("const STAGE_DEF stageRegistry[] = {\n")
for entry in stage_entries:
    escaped_name = entry["name"].replace("\\", "\\\\").replace('"', '\\"')
    if entry["sound_count"] > 0:
        sounds_ref = f'{entry["ident"]}_sounds, {entry["ident"]}_soundCount'
    else:
        sounds_ref = "0, 0"  # no sounds authored - no <ident>_sounds[] array was emitted
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f'{{ {entry["cam_pos"][0]}, {entry["cam_pos"][1]}, {entry["cam_pos"][2]} }}, '
        f'{{ {entry["cam_rot"][0]}, {entry["cam_rot"][1]}, {entry["cam_rot"][2]} }}, '
        f'{entry["ident"]}_objects, {entry["ident"]}_objectCount, {sounds_ref} }},\n'
    )
registry_lines.append("};\n")

(GENERATED_DIR / "stage_registry.c").write_text("".join(registry_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'stage_registry.c'} ({len(stage_entries)} stage(s))")

# ------------------------------------------------------------------
# Manifest - #include'd ONCE from main.c.
# ------------------------------------------------------------------
manifest_lines = []
manifest_lines.append("/* Auto-generated by py_convert_stages.py. Do not edit manually.\n")
manifest_lines.append(" * #include this ONCE from main.c - lists every discovered stage. */\n\n")
manifest_lines.append('#include "stage_common.h"\n')
for entry in stage_entries:
    manifest_lines.append(f'#include "stage_{entry["ident"]}.c"\n')
manifest_lines.append('#include "stage_registry.c"\n')

(GENERATED_DIR / "stages_all.h").write_text("".join(manifest_lines), newline="\n")
print(f"Generated: {GENERATED_DIR / 'stages_all.h'}")
