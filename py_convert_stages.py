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
# Fixed-point conventions, matching main.c / py_convert_assets.py. The
# three quantities are authored in THREE DIFFERENT units - this is the
# thing to get right:
#
#   pos   - ENGINE fixed-point units already (NOT re-scaled here).
#           stage-gen applied its *1024 viewport->engine upscale at export
#           (stage_export.js), so e.g. house_demo's camera pos
#           [0,0,-4096] is 4 viewport units and matches CAMERA_DISTANCE.
#
#   rot   - DEGREES, converted HERE to the runtime's 12-bit angle format
#           (4096 == 360 degrees, so 1024 == 90 degrees) - the format
#           RotMatrix() consumes and model_rot/camera.rot use.
#           stage_export.js remaps the viewport Euler angles per axis but
#           deliberately leaves them in degrees, with an explicit note that
#           "a separate downstream script converts degrees to the PS1
#           runtime's fixed-point angle format" - that script is this one.
#
#           THIS WAS THE BUG. An earlier version of this file assumed rot
#           was already in engine units (like pos) and merely masked it
#           with ROT_MASK. A camera authored at -90 degrees therefore baked
#           as (-90 & 4095) == 4006, which the runtime reads as
#           4006/4096*360 ~= 352 degrees, i.e. about -8 degrees. So stage
#           cameras loaded at the right POSITION but very nearly no
#           rotation - the symptom being "the camera ignores its rotation".
#           Every authored rotation was affected (objects too), it was just
#           least visible on the demo stages, whose objects are all at
#           rot 0. Note the coneAngle conversion further down always did
#           the degrees->12-bit scale correctly, which is the convention
#           this now matches.
#
#   scale - a human multiplier (1.0 == normal size), upscaled here to
#           4096-per-1.0 fixed point - the same fixed point RotMatrix()'s
#           own m[][] output uses - so main.c can apply it as a cheap
#           column-scale on the rotation matrix (see
#           update_object_world_and_compose() in main.c) instead of
#           touching every vertex per object per frame.
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

# Light types: stage.json's lightType string -> the STAGE_LIGHT type byte
# main.c switches on. Keep in sync with the LIGHT_* defines this script
# writes into stage_common.h (and which main.c uses).
LIGHT_TYPES = {"directional": 0, "spherical": 1, "spot": 2, "ambient": 3, "debug": 4}

# Light intensity is authored as a human 0-1+ multiplier; the runtime scales
# a base colour by a fixed-point intensity where 256 == 1.0 (the scale
# main.c's g_light_dir_int[] / g_light_intensity_offset use), so it is baked
# to that fixed point here.
LIGHT_INTENSITY_SCALE = 256

ANGLE_FULL = 4096  # 12-bit angle: 4096 == 360 degrees (cone angle conversion)

# Trigger actions: stage.json's action string -> the STAGE_TRIGGER action
# byte main.c switches on. Keep in sync with the TRIGGER_ACTION_* defines
# this script writes into stage_common.h.
#
# 'none' is listed but never actually reaches here - stage-gen filters
# inert triggers out at export, since a volume that does nothing is an
# authoring marker, not runtime data. It is accepted anyway so a
# hand-written stage.json carrying one converts rather than failing, and so
# the byte values stay stable if a future action is inserted.
TRIGGER_ACTIONS = {"none": 0, "switchScene": 1}

# Post-process tint blend mode -> the GPU's semi-transparency (ABR) bits.
# These ARE the hardware values, not an arbitrary enum: the PS1 GPU has
# exactly four blend modes and this is their encoding, so main.c can pass the
# byte to getTPage()/setSemiTrans() rather than translating it again.
#   0: B/2 + F/2   1: B + F   2: B - F   3: B + F/4
POSTFX_TINT_MODES = {"blend50": 0, "additive": 1, "subtractive": 2, "quarter": 3}

# ------------------------------------------------------------------
# Fog - a stage-LEVEL block (like camera), not an array of entities.
# stage-gen exports a single "fog" object (see stage_export.js); this
# bakes it into STAGE_DEF.fog, which main.c's load_stage_fog() reads at
# stage load. Every field here is an authored DEFAULT the runtime loads;
# the DEBUG-mode L1+L2 pad editor still overrides it live.
#
# Defaults are main.c's compiled-in fog globals VERBATIM (fog_enabled=0,
# fog_near=800, fog_far=6000, FOG_COL_*=128, fog_layers=3, cull/drift off),
# so a stage.json with no "fog" block converts to fog that is byte-identical
# to the hardcoded defaults - which is exactly the fog those older stages
# ran with. near/far are in ENGINE units already (stage-gen applied its
# *1024 at export), so they are baked raw here, same as camera.pos.
#
# near/far are NOT clamped here: main.c's load_stage_fog() calls
# fog_clamp_range() - the same function the pad editor uses - at load time,
# so the runtime is the single authority on what range its projection can
# render. Baking raw keeps this converter dumb and keeps the clamp in one
# place. FOG_MAX_LAYERS is enforced (a small integer ceiling, not a
# projection-dependent one) so the baked layer count can index main.c's
# fixed g_fog_layer_bucket[FOG_MAX_LAYERS] safely.
FOG_MAX_LAYERS = 6  # keep in sync with main.c's FOG_MAX_LAYERS
FOG_DEFAULTS = {
    "enabled": False,
    "near": 800,
    "far": 6000,
    "color": [128, 128, 128],
    "layers": 3,
    "cull": False,
    "drift": False,
}


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


def as_angle_vec3(values, label, path):
    """
    Parse an authored rotation (DEGREES, per stage_export.js) into the
    runtime's 12-bit angle format: 4096 == 360 degrees, wrapped to 0..4095.

    Deliberately converts from float BEFORE rounding, rather than reusing
    as_vec3()'s integer result - a fractional degree is meaningful once
    scaled by 4096/360 (0.5 degrees is ~6 angle units), and stage-gen may
    author non-integer angles even though it currently rounds them.

    Wrapping with ROT_MASK rather than clamping is correct here: angles are
    cyclic, so -90 degrees must become 3072 (== 270 degrees), the same
    representation main.c's own "model_rot.vx &= 4095" produces.
    """
    if not (isinstance(values, list) and len(values) == 3):
        raise SystemExit(f"{path}: '{label}' must be a 3-element array, got {values!r}")
    return tuple(int(round(float(v) * ANGLE_FULL / 360.0)) & ROT_MASK for v in values)


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
    # Authored in DEGREES -> the runtime's 12-bit angle format. See the
    # fixed-point conventions block up top for why this conversion has to
    # happen here (and what breaks when it doesn't).
    cam_rot = as_angle_vec3(camera.get("rot", [0, 0, 0]), "camera.rot", stage_path)

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
        # Solid to the player at runtime. DEFAULTS TRUE on a missing key, which
        # matters for stage.json files exported before the field existed: that
        # geometry was authored as if it were solid (there was nothing else it
        # could be), so reading its absence as "passable" would silently ship
        # walls the player falls through. The tool always emits the key
        # explicitly, so a False here is only ever a deliberate authored one.
        collide = 1 if obj.get("collide", True) else 0
        pos = as_vec3(obj.get("pos", [0, 0, 0]), f"objects[{obj_index}].pos", stage_path)
        rot = as_angle_vec3(obj.get("rot", [0, 0, 0]), f"objects[{obj_index}].rot", stage_path)
        scale = as_scale_vec3(obj.get("scale", [1, 1, 1]), stage_path)

        escaped_model = model_name.replace("\\", "\\\\").replace('"', '\\"')

        # Optional skeletal-animation authoring. TWO input shapes are accepted:
        #
        #   NESTED (what the stage-gen tool exports, and the preferred form):
        #     "anim": { "clip": "Run", "loop": true, "speed": 1.0,
        #               "autoplay": true }
        #
        #   FLAT (older / hand-authored stages): a string "anim" clip name plus
        #     sibling keys "animSpeed", "animStart", "animLoop", "animPlaying".
        #
        # Read whichever is present; absent keys give sane defaults - no named
        # clip (runtime plays clip 0), 1.0x speed, no start offset, looping,
        # autoplay on. The nested schema carries no start offset today, so a
        # per-object desync offset can still be supplied via a flat "animStart"
        # (or a nested "start") alongside it. animStart is authored in SECONDS
        # and converted to the runtime's DT_ONE tick unit (256 == 1/60s, so
        # 1s == 15360 ticks).
        anim_raw = obj.get("anim")
        if isinstance(anim_raw, dict):
            clip_name      = anim_raw.get("clip")
            anim_speed_val = anim_raw.get("speed", 1.0)
            anim_loop_val  = anim_raw.get("loop", True)
            anim_play_val  = anim_raw.get("autoplay", True)
            anim_start_val = anim_raw.get("start", obj.get("animStart", 0.0))
        else:
            clip_name      = anim_raw  # string clip name, or None
            anim_speed_val = obj.get("animSpeed", 1.0)
            anim_loop_val  = obj.get("animLoop", True)
            anim_play_val  = obj.get("animPlaying", obj.get("autoplay", True))
            anim_start_val = obj.get("animStart", 0.0)

        if clip_name:
            esc_anim = str(clip_name).replace("\\", "\\\\").replace('"', '\\"')
            anim_field = f'"{esc_anim}"'
        else:
            anim_field = "0"
        anim_speed   = int(round(float(anim_speed_val) * 4096))
        anim_start   = int(round(float(anim_start_val) * 15360))
        anim_loop    = 1 if anim_loop_val else 0
        anim_playing = 1 if anim_play_val else 0

        output.append(
            f'    {{ "{escaped_model}", {palette}, {collide}, '
            f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
            f"{{ {rot[0]}, {rot[1]}, {rot[2]} }}, "
            f"{{ {scale[0]}, {scale[1]}, {scale[2]} }}, "
            f"{anim_field}, {anim_speed}, {anim_start}, {anim_loop}, {anim_playing} }},\n"
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
        seen_sound_ids = set()
        output.append(f"\nconst STAGE_SOUND {ident}_sounds[] = {{\n")
        for snd_index, snd in enumerate(sounds):
            if "sample" not in snd:
                raise SystemExit(f"{stage_path}: sounds[{snd_index}] is missing required 'sample'")

            # Stable per-emitter handle that triggers reference. Defaults to
            # the array INDEX rather than 0 when absent, so a stage.json
            # predating sound IDs still gets distinct ids instead of every
            # emitter answering to 0 - a trigger referencing "sound 0" would
            # otherwise fire whichever happened to be first.
            sound_id = int(round(float(snd.get("soundId", snd_index))))
            if sound_id < 0:
                sound_id = snd_index

            # The runtime resolves an id to the FIRST matching slot
            # (sfx_play_by_id), so a duplicate silently shadows every later
            # emitter sharing it - enforce the uniqueness the C headers
            # promise, at export, where it's fixable.
            if sound_id in seen_sound_ids:
                raise SystemExit(
                    f"{stage_path}: sounds[{snd_index}].soundId {sound_id} is not "
                    f"unique within this stage"
                )
            seen_sound_ids.add(sound_id)

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
                f'    {{ {sound_id}, "{escaped_cd_path}", {cd_path2_c}, '
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{volume_spu}, {radius}, "
                f"{mode}, {directional}, {mute_after}, {autoplay}, {fade_on_enter}, "
                f"{delay}, {interval_min}, {interval_max} }},\n"
            )
            sound_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_soundCount = {sound_count};\n")

    # ------------------------------------------------------------------
    # Lights - optional "lights" array (exported by stage-gen's light
    # entities). Same optional/NULL handling as sounds: absent/empty stages
    # carry a NULL pointer + count 0 and emit no <ident>_lights[] array.
    #
    # SCOPE: the runtime (main.c setup_frame_lighting) consumes DIRECTIONAL
    # and AMBIENT lights into the GTE light/colour/back registers. Spherical
    # and spot are validated and carried through in the data now, ready for a
    # future offline vertex-baking pass, but are not yet consumed at runtime.
    # ------------------------------------------------------------------
    lights = stage.get("lights", [])
    light_count = 0

    if lights:
        output.append(f"\nconst STAGE_LIGHT {ident}_lights[] = {{\n")
        for light_index, lt in enumerate(lights):
            type_name = lt.get("type", "spherical")
            if type_name not in LIGHT_TYPES:
                raise SystemExit(
                    f"{stage_path}: lights[{light_index}].type {type_name!r} "
                    f"must be one of {sorted(LIGHT_TYPES)}"
                )
            ltype = LIGHT_TYPES[type_name]

            # dir is the precomputed unit direction TOWARD the light (ONE ==
            # 4096), emitted by stage_export.js. Default points down -Z.
            dir_v = as_vec3(lt.get("dir", [0, 0, -4096]), f"lights[{light_index}].dir", stage_path)
            pos = as_vec3(lt.get("pos", [0, 0, 0]), f"lights[{light_index}].pos", stage_path)

            color = lt.get("color", [255, 255, 255])
            if not (isinstance(color, list) and len(color) == 3):
                raise SystemExit(f"{stage_path}: lights[{light_index}].color must be a 3-element [r,g,b] array")
            r, g, b = (max(0, min(255, int(round(float(c))))) for c in color)

            intensity = int(round(float(lt.get("intensity", 1.0)) * LIGHT_INTENSITY_SCALE))
            intensity = max(0, min(0xFFFF, intensity))

            rng = max(0, int(round(float(lt.get("range", 0)))))

            # coneAngle authored in degrees -> 12-bit angle; penumbra 0-1 ->
            # 0..4096 fixed point (same scale as object scale's 4096==1.0).
            cone = int(round(float(lt.get("coneAngle", 30)) * ANGLE_FULL / 360.0)) & ROT_MASK
            penumbra = int(round(max(0.0, min(1.0, float(lt.get("penumbra", 0.2)))) * SCALE_UPSCALE))

            # mobility (spherical/spot): 1 = static (destined for the offline
            # vertex bake), 0 = dynamic (lit live per object). Stages exported
            # before the field existed default to static, matching stage-gen's
            # own default. NOTE: until the bake exists, main.c lights BOTH via
            # the live per-object path - the flag is carried so already-
            # authored stages survive the bake landing unchanged.
            mobility = lt.get("mobility", "static")
            if mobility not in ("static", "dynamic"):
                raise SystemExit(
                    f"{stage_path}: lights[{light_index}].mobility {mobility!r} "
                    f"must be 'static' or 'dynamic'"
                )
            is_static = 1 if mobility == "static" else 0

            # Per-light Disabled tickbox. Disabled lights are STILL baked
            # into STAGE_LIGHT[] (never dropped - they stay authoritative
            # authored data); main.c's load_stage_lights() just skips
            # applying them. Missing field (older exports) == enabled.
            is_disabled = 1 if lt.get("disabled") else 0

            output.append(
                f"    {{ {ltype}, "
                f"{{ {dir_v[0]}, {dir_v[1]}, {dir_v[2]} }}, "
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{r}, {g}, {b}, {intensity}, {rng}, {cone}, {penumbra}, {is_static}, {is_disabled} }},\n"
            )
            light_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_lightCount = {light_count};\n")

    # ------------------------------------------------------------------
    # Spawns - optional "spawns" array (exported by stage-gen's spawn
    # entities, the third kind to graduate after sound and light). Same
    # optional/NULL handling as sounds and lights: a stage with none carries
    # a NULL pointer + count 0 and emits no <ident>_spawns[] array.
    #
    # main.c's load_stage_spawn() places the PLAY-mode player at the spawn
    # with the LOWEST spawnId (stage-gen already sorts them, but the runtime
    # does not depend on that - it scans for the minimum). Everything else
    # is addressable data for later systems (checkpoints, stage-transition
    # arrival points).
    #
    # Summon entities are NOT included here - they share the spawnId
    # namespace but are NPC placements, not player starts.
    # ------------------------------------------------------------------
    spawns = stage.get("spawns", [])
    spawn_count = 0

    if spawns:
        seen_spawn_ids = set()
        output.append(f"\nconst STAGE_SPAWN {ident}_spawns[] = {{\n")
        for spawn_index, sp in enumerate(spawns):
            spawn_id = int(round(float(sp.get("spawnId", 0))))
            if spawn_id < 0:
                raise SystemExit(
                    f"{stage_path}: spawns[{spawn_index}].spawnId must be >= 0, got {spawn_id}"
                )
            # A door arriving at a duplicated spawnId lands on whichever the
            # runtime's scan finds first - enforce the uniqueness the C
            # headers promise, at export.
            if spawn_id in seen_spawn_ids:
                raise SystemExit(
                    f"{stage_path}: spawns[{spawn_index}].spawnId {spawn_id} is not "
                    f"unique within this stage"
                )
            seen_spawn_ids.add(spawn_id)
            pos = as_vec3(sp.get("pos", [0, 0, 0]), f"spawns[{spawn_index}].pos", stage_path)
            rot = as_angle_vec3(sp.get("rot", [0, 0, 0]), f"spawns[{spawn_index}].rot", stage_path)

            output.append(
                f"    {{ {spawn_id}, "
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{{ {rot[0]}, {rot[1]}, {rot[2]} }} }},\n"
            )
            spawn_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_spawnCount = {spawn_count};\n")

    # ------------------------------------------------------------------
    # Triggers - optional "triggers" array (exported by stage-gen's trigger
    # entities, the fourth kind to graduate). Same optional/NULL handling as
    # sounds/lights/spawns.
    #
    # stage-gen only exports triggers with a real action (action:none is an
    # authoring marker with nothing for the runtime to do), so anything
    # arriving here is expected to act. The volume is a centre + half-extent
    # AABB in engine units; the exporter did the scale -> half-extent
    # conversion, since scale IS the extent for a unit-cube helper.
    #
    # targetStage is baked as a plain string and resolved at RUNTIME against
    # stageRegistry[] by name - the same resolve-late treatment model names
    # and sound samples get, so a door doesn't depend on stage ordering and a
    # typo degrades to "never fires" plus an overlay count rather than a
    # failed convert. Validating it here would mean this script needed to
    # know the full stage list before emitting any single stage, which is a
    # much tighter coupling than the payoff justifies.
    # ------------------------------------------------------------------
    triggers = stage.get("triggers", [])
    trigger_count = 0

    if triggers:
        output.append(f"\nconst STAGE_TRIGGER {ident}_triggers[] = {{\n")
        for tr_index, tr in enumerate(triggers):
            action_name = tr.get("action", "none")
            if action_name not in TRIGGER_ACTIONS:
                raise SystemExit(
                    f"{stage_path}: triggers[{tr_index}].action {action_name!r} "
                    f"must be one of {sorted(TRIGGER_ACTIONS)}"
                )
            action = TRIGGER_ACTIONS[action_name]

            pos = as_vec3(tr.get("pos", [0, 0, 0]), f"triggers[{tr_index}].pos", stage_path)
            half = as_vec3(
                tr.get("halfExtent", [512, 512, 512]),
                f"triggers[{tr_index}].halfExtent",
                stage_path,
            )
            # A zero/negative half-extent can never contain a point, so the
            # trigger would be silently dead. Clamp to 1 and let it be tiny
            # rather than impossible - a too-small volume is debuggable in a
            # way that "the box has no interior" is not.
            half = tuple(max(1, abs(v)) for v in half)

            target_stage = (tr.get("targetStage") or "").strip()
            escaped_target = target_stage.replace("\\", "\\\\").replace('"', '\\"')
            target_c = f'"{escaped_target}"' if target_stage else "0"

            target_spawn = max(0, int(round(float(tr.get("targetSpawnId", 0)))))
            once = 1 if tr.get("once", True) else 0

            # Sound fired in THIS stage as the door opens; -1 = none. Not
            # cross-checked against this stage's sounds here - stage-gen
            # already collapses a dangling reference to -1 at export, and the
            # runtime treats an unmatched id as silence, so a hand-written
            # stage.json degrades the same way a typo'd model name does.
            on_enter_sound = int(round(float(tr.get("onEnterSoundId", -1))))
            if on_enter_sound < 0:
                on_enter_sound = -1

            # Require a CROSS press while inside rather than firing on entry.
            # Defaults TRUE when absent, matching stage-gen's schema default:
            # a stage.json predating the field converts to press-to-activate,
            # the same as a freshly authored trigger would.
            user_interact = 1 if tr.get("userInteract", True) else 0

            output.append(
                f"    {{ {action}, "
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{{ {half[0]}, {half[1]}, {half[2]} }}, "
                f"{target_c}, {target_spawn}, {on_enter_sound}, "
                f"{user_interact}, {once} }},\n"
            )
            trigger_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_triggerCount = {trigger_count};\n")

    # ------------------------------------------------------------------
    # Post-process volumes. Same centre + half-extent volume shape as
    # triggers; the payload is what differs. stage-gen already dropped any
    # volume with every effect disabled, clamped the layer count, and
    # upscaled falloff - this transcribes and maps the blend-mode string to
    # its hardware ABR value.
    #
    # Float amounts (blur/ghost) are authored 0-1 and baked to 0-4096 fixed
    # point, the same 12-bit scale main.c uses for every other fractional
    # quantity, so the runtime never sees a float.
    # ------------------------------------------------------------------
    postfx = stage.get("postfx", [])
    if not isinstance(postfx, list):
        raise SystemExit(f"{stage_path}: 'postfx' must be an array, got {postfx!r}")

    postfx_count = 0
    if postfx:
        output.append(f"\nconst STAGE_POSTFX {ident}_postfx[] = {{\n")
        for pi, fx in enumerate(postfx):
            if not isinstance(fx, dict):
                raise SystemExit(f"{stage_path}: postfx[{pi}] must be an object, got {fx!r}")

            pos = as_vec3(fx.get("pos", [0, 0, 0]), f"postfx[{pi}].pos", stage_path)
            half = as_vec3(fx.get("halfExtent", [1, 1, 1]), f"postfx[{pi}].halfExtent", stage_path)
            half = [h if h >= 1 else 1 for h in half]
            falloff = max(0, int(fx.get("falloff", 0)))
            # Master intensity: authored as a percentage, baked to the same
            # 12-bit fixed point (4096 == 1.0 == 100%) every other fractional
            # quantity in main.c uses. Capped at 4x rather than 1x - the
            # editor deliberately allows over-driving a volume, and the
            # runtime clamps the RESULT, not the input.
            intensity = max(0, min(16384, int(int(fx.get("intensity", 100)) * 4096 / 100)))

            mode_name = fx.get("tintMode", "blend50")
            if mode_name not in POSTFX_TINT_MODES:
                raise SystemExit(
                    f"{stage_path}: postfx[{pi}].tintMode {mode_name!r} is not one of "
                    f"{sorted(POSTFX_TINT_MODES)}"
                )
            tint_mode = POSTFX_TINT_MODES[mode_name]

            col = fx.get("tintColor", [128, 64, 96])
            if not isinstance(col, list) or len(col) != 3:
                raise SystemExit(f"{stage_path}: postfx[{pi}].tintColor must be [r,g,b], got {col!r}")
            r, g, b = (max(0, min(255, int(c))) for c in col)

            tint = 1 if fx.get("tint") else 0
            strength = max(1, min(8, int(fx.get("tintStrength", 1))))
            blur = 1 if fx.get("blur") else 0
            blur_amt = max(0, min(4096, int(float(fx.get("blurAmount", 0.5)) * 4096)))
            ghost = 1 if fx.get("ghost") else 0
            ghost_amt = max(0, min(4096, int(float(fx.get("ghostAmount", 0.5)) * 4096)))
            palette = 1 if fx.get("palette") else 0
            palette_row = max(0, int(fx.get("paletteRow", 0)))

            output.append(
                f"    {{ {{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{{ {half[0]}, {half[1]}, {half[2]} }}, {falloff}, {intensity}, "
                f"{tint}, {r}, {g}, {b}, {tint_mode}, {strength}, "
                f"{blur}, {blur_amt}, {ghost}, {ghost_amt}, "
                f"{palette}, {palette_row} }},\n"
            )
            postfx_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_postfxCount = {postfx_count};\n")

    # ------------------------------------------------------------------
    # Authored collision boxes. Already world-space, already halved, already
    # in engine units - stage-gen did all of that (see stage_export.js's
    # collider block for why the bake happens there rather than here). This is
    # a near-verbatim transcription; the only work is validating shapes and
    # forcing a minimum extent so a box can never be silently inert.
    # ------------------------------------------------------------------
    colliders = stage.get("colliders", [])
    if not isinstance(colliders, list):
        raise SystemExit(f"{stage_path}: 'colliders' must be an array, got {colliders!r}")

    collider_count = 0
    if colliders:
        output.append(f"\nconst STAGE_COLLIDER {ident}_colliders[] = {{\n")
        for ci, col in enumerate(colliders):
            if not isinstance(col, dict):
                raise SystemExit(f"{stage_path}: colliders[{ci}] must be an object, got {col!r}")
            cid = int(col.get("colliderId", -1))
            pos = as_vec3(col.get("pos", [0, 0, 0]), f"colliders[{ci}].pos", stage_path)
            half = as_vec3(col.get("halfExtent", [1, 1, 1]), f"colliders[{ci}].halfExtent", stage_path)
            # A zero or negative half-extent makes a box that can never contain
            # anything - it would ship looking authored while being inert.
            half = [h if h >= 1 else 1 for h in half]
            enabled = 1 if col.get("enabled", True) else 0
            output.append(
                f"    {{ {cid}, "
                f"{{ {pos[0]}, {pos[1]}, {pos[2]} }}, "
                f"{{ {half[0]}, {half[1]}, {half[2]} }}, "
                f"{enabled} }},\n"
            )
            collider_count += 1
        output.append("};\n\n")
        output.append(f"const unsigned int {ident}_colliderCount = {collider_count};\n")

    # ------------------------------------------------------------------
    # Fog - a single stage-level block, baked into STAGE_DEF.fog (in the
    # registry line below), NOT a per-stage array. Unlike sounds/lights it
    # is emitted for EVERY stage: main.c has no fallback fog, so an omitted
    # block would let the previously-loaded stage's fog leak across a runtime
    # stage switch (same reasoning that makes authored lights authoritative
    # with no recovery sun). Absent fields fall back to main.c's own
    # compiled-in defaults (FOG_DEFAULTS), so a stage.json without a "fog"
    # block bakes fog identical to the hardcoded runtime values.
    # ------------------------------------------------------------------
    fog = stage.get("fog", {})
    if not isinstance(fog, dict):
        raise SystemExit(f"{stage_path}: 'fog' must be an object, got {fog!r}")

    fog_enabled = 1 if fog.get("enabled", FOG_DEFAULTS["enabled"]) else 0
    fog_cull = 1 if fog.get("cull", FOG_DEFAULTS["cull"]) else 0
    fog_drift = 1 if fog.get("drift", FOG_DEFAULTS["drift"]) else 0

    fog_near = int(round(float(fog.get("near", FOG_DEFAULTS["near"]))))
    fog_far = int(round(float(fog.get("far", FOG_DEFAULTS["far"]))))

    fog_layers = int(fog.get("layers", FOG_DEFAULTS["layers"]))
    fog_layers = max(0, min(FOG_MAX_LAYERS, fog_layers))

    fog_color = fog.get("color", FOG_DEFAULTS["color"])
    if not (isinstance(fog_color, list) and len(fog_color) == 3):
        raise SystemExit(f"{stage_path}: 'fog.color' must be a 3-element [r,g,b] array, got {fog_color!r}")
    fog_r, fog_g, fog_b = (max(0, min(255, int(round(float(c))))) for c in fog_color)

    stage_c_path = GENERATED_DIR / f"stage_{ident}.c"
    stage_c_path.write_text("".join(output), newline="\n")
    print(
        f"Generated: {stage_c_path} ({object_count} object(s), {sound_count} sound(s), "
        f"{light_count} light(s), {spawn_count} spawn(s), {trigger_count} trigger(s), "
        f"{collider_count} collider(s), {postfx_count} postfx, "
        f"fog {'on' if fog_enabled else 'off'})"
    )

    stage_entries.append({
        "name": stage_name,
        "ident": ident,
        "cam_pos": cam_pos,
        "cam_rot": cam_rot,
        "sound_count": sound_count,
        "light_count": light_count,
        "spawn_count": spawn_count,
        "trigger_count": trigger_count,
        "has_colliders": collider_count > 0,
        "has_postfx": postfx_count > 0,
        "collider_count": collider_count,
        "fog": (fog_enabled, fog_cull, fog_drift, fog_layers,
                fog_near, fog_far, fog_r, fog_g, fog_b),
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
header_lines.append("    unsigned char collide; // 1 = solid to the player; main.c composes a world AABB from the model's bboxMin/bboxMax. Packs with palette - keep the two adjacent, ahead of the VECTORs.\n")
header_lines.append("    VECTOR  pos;           // world position, same fixed-point space as CAMERA.pos\n")
header_lines.append("    SVECTOR rot;           // 12-bit fixed-point XYZ angle, same format as model_rot\n")
header_lines.append("    VECTOR  scale;         // per-axis scale, 4096 == 1.0 (same fixed point RotMatrix() m[][] uses)\n")
header_lines.append("\n")
header_lines.append("    // Skeletal-animation authoring (all optional in stage.json; ignored on\n")
header_lines.append("    // models with no rig). See main.c load_stage() / animation.c.\n")
header_lines.append("    const char   *anim;      // clip NAME to play (resolved via anim_find_clip at load); NULL = clip 0\n")
header_lines.append("    int           animSpeed; // playback rate, 4096 == 1.0x\n")
header_lines.append("    int           animStart; // initial play-time offset in ticks (256 == 1/60s) - desyncs identical NPCs\n")
header_lines.append("    unsigned char animLoop;  // 1 = loop, 0 = play once then hold the final frame\n")
header_lines.append("    unsigned char animPlaying;// 1 = start playing on spawn (autoplay), 0 = sit paused on the first frame\n")
header_lines.append("} STAGE_OBJECT;\n\n")
header_lines.append("/* Post-process tint blend mode = the GPU's semi-transparency (ABR) bits.\n")
header_lines.append(" * These are the HARDWARE values, not an arbitrary enum. */\n")
header_lines.append("#define POSTFX_TINT_BLEND50     0  /* B/2 + F/2 - glass, haze, general wash */\n")
header_lines.append("#define POSTFX_TINT_ADDITIVE    1  /* B + F     - fire, light, heat */\n")
header_lines.append("#define POSTFX_TINT_SUBTRACTIVE 2  /* B - F     - shadow, grime, dread */\n")
header_lines.append("#define POSTFX_TINT_QUARTER     3  /* B + F/4   - subtle bloom */\n\n")
header_lines.append("/* Region that changes HOW THE FRAME IS RENDERED while the player is inside.\n")
header_lines.append(" *\n")
header_lines.append(" * The PS1 has no programmable shaders, so every effect here is assembled\n")
header_lines.append(" * from fixed-function parts: full-screen semi-transparent quads (the same\n")
header_lines.append(" * mechanism the fog layers use), CLUT row swaps, and quads TEXTURED FROM\n")
header_lines.append(" * the displayed framebuffer (VRAM is unified, so the previous frame is\n")
header_lines.append(" * directly addressable - no copy).\n")
header_lines.append(" *\n")
header_lines.append(" * Volume is an AXIS-ALIGNED box, centre +/- halfExtent, exactly like\n")
header_lines.append(" * STAGE_TRIGGER - rotation is not carried, so a rotated volume behaves as\n")
header_lines.append(" * its axis-aligned equivalent.\n")
header_lines.append(" *\n")
header_lines.append(" * falloff is the distance OUTSIDE the box over which the effect ramps in\n")
header_lines.append(" * (0 = hard edge). It is what stops a volume reading as a light switch.\n")
header_lines.append(" *\n")
header_lines.append(" * OVERLAPPING VOLUMES BLEND. Continuous amounts are weighted by each\n")
header_lines.append(" * volume's falloff weight and summed; paletteRow CANNOT be averaged\n")
header_lines.append(" * (row 2 and row 5 do not make row 3.5), so it takes the value of the\n")
header_lines.append(" * highest-weighted volume instead.\n")
header_lines.append(" *\n")
header_lines.append(" * blurAmount/ghostAmount are 12-bit fixed point (4096 == 1.0), matching\n")
header_lines.append(" * every other fractional quantity in main.c - the runtime never sees a\n")
header_lines.append(" * float. tintStrength is a LAYER COUNT, because the GPU's blend modes are\n")
header_lines.append(" * fixed ratios: 'stronger' means drawing the quad again, and each layer is\n")
header_lines.append(" * a full-screen fill. That is the real cost of this whole feature. */\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    VECTOR pos;                // volume CENTRE, same fixed-point space as STAGE_OBJECT.pos\n")
header_lines.append("    VECTOR halfExtent;         // half-size per axis; always >= 1\n")
header_lines.append("    int falloff;               // ramp-in distance outside the box, world units; 0 = hard edge\n")
header_lines.append("    int intensity;             // master scale on this volume's whole contribution, 4096 == 100%\n")
header_lines.append("    unsigned char tint;        // 1 = draw the full-screen tint quad(s)\n")
header_lines.append("    unsigned char tintR, tintG, tintB;\n")
header_lines.append("    unsigned char tintMode;    // POSTFX_TINT_* above (the GPU's ABR bits)\n")
header_lines.append("    unsigned char tintStrength;// number of full-screen quads, 1..8\n")
header_lines.append("    unsigned char blur;        // 1 = spatial blur (offset feedback quads sampling the displayed buffer)\n")
header_lines.append("    unsigned short blurAmount; // 0..4096\n")
header_lines.append("    unsigned char ghost;       // 1 = temporal trails (zero-offset feedback, same mechanism as blur)\n")
header_lines.append("    unsigned short ghostAmount;// 0..4096\n")
header_lines.append("    unsigned char palette;     // 1 = push a global CLUT row offset (free at runtime)\n")
header_lines.append("    unsigned char paletteRow;\n")
header_lines.append("} STAGE_POSTFX;\n\n")
header_lines.append("/* Authored collision box, baked to WORLD space by stage-gen.\n")
header_lines.append(" *\n")
header_lines.append(" * The editor treats these as children of a model instance (so a box\n")
header_lines.append(" * follows its building around while authoring), but that relationship has\n")
header_lines.append(" * done its job by export time - what ships is a flat, world-space,\n")
header_lines.append(" * axis-aligned centre + half-extent list. main.c copies them straight into\n")
header_lines.append(" * its collider table with no composition and no model lookup.\n")
header_lines.append(" *\n")
header_lines.append(" * An instance with NO authored boxes falls back to one automatic box per\n")
header_lines.append(" * model primitive, composed at load from MODEL_DEF.collMin/collMax. So a\n")
header_lines.append(" * simple prop needs no authoring, and complex geometry (a building with a\n")
header_lines.append(" * doorway) gets hand-placed boxes instead.\n")
header_lines.append(" *\n")
header_lines.append(" * colliderId is a stable, stage-unique handle. It exists so collision can be\n")
header_lines.append(" * TOGGLED at runtime - `enabled` here is only the INITIAL state, and main.c\n")
header_lines.append(" * keeps a live copy a future trigger action can flip to open a barrier or\n")
header_lines.append(" * seal a door. Automatic fallback boxes are not addressable and carry -1. */\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    int colliderId;            // stage-unique handle for runtime toggling; -1 = automatic fallback box\n")
header_lines.append("    VECTOR pos;                // box CENTRE, world space, same fixed point as STAGE_OBJECT.pos\n")
header_lines.append("    VECTOR halfExtent;         // half-size per axis; always >= 1 so the box has an interior\n")
header_lines.append("    unsigned char enabled;     // INITIAL solid state (main.c keeps a live, toggleable copy)\n")
header_lines.append("} STAGE_COLLIDER;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned int soundId;      // stable per-emitter handle other entities reference (e.g. a trigger's onEnterSoundId); unique within the stage\n")
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
header_lines.append("/* Light type byte (matches LIGHT_TYPES in py_convert_stages.py). */\n")
header_lines.append("#define LIGHT_DIRECTIONAL 0\n")
header_lines.append("#define LIGHT_SPHERICAL   1\n")
header_lines.append("#define LIGHT_SPOT        2\n")
header_lines.append("#define LIGHT_AMBIENT     3\n")
header_lines.append("#define LIGHT_DEBUG       4\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned char type;        // LIGHT_* above\n")
header_lines.append("    SVECTOR dir;               // unit direction TOWARD the light, ONE == 4096 (directional/spot)\n")
header_lines.append("    VECTOR  pos;               // world position, same fixed-point space as STAGE_OBJECT.pos (spherical/spot)\n")
header_lines.append("    unsigned char r, g, b;     // light colour, 0-255\n")
header_lines.append("    unsigned short intensity;  // fixed-point multiplier, 256 == 1.0 (main.c applies it live per frame)\n")
header_lines.append("    unsigned int range;        // falloff radius in world units, 0 = infinite (spherical/spot)\n")
header_lines.append("    unsigned short coneAngle;  // spot cone half-angle, 12-bit angle (1024 == 90 deg)\n")
header_lines.append("    unsigned short penumbra;   // spot edge softness, 0..4096 (0..1)\n")
header_lines.append("    unsigned char isStatic;    // 1 = bake-destined (static), 0 = dynamic; both lit live until the bake exists\n")
header_lines.append("    unsigned char disabled;    // 1 = authored off: still present in the data, skipped by load_stage_lights (immune to the DEBUG L2 editor, unlike intensity 0)\n")
header_lines.append("} STAGE_LIGHT;\n\n")
header_lines.append("/* Player/actor spawn point. main.c's load_stage_spawn() places the\n")
header_lines.append(" * PLAY-mode player at the entry with the LOWEST spawnId on stage load;\n")
header_lines.append(" * the rest are addressable markers for later systems (checkpoints,\n")
header_lines.append(" * stage-transition arrival points). Summon entities share stage-gen's\n")
header_lines.append(" * spawnId namespace but are NPC placements and are NOT baked here. */\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned int spawnId;  // unique within the stage; lowest one is the player start\n")
header_lines.append("    VECTOR  pos;           // world position, same fixed-point space as STAGE_OBJECT.pos\n")
header_lines.append("    SVECTOR rot;           // 12-bit facing; .vy is the yaw the player spawns looking along\n")
header_lines.append("} STAGE_SPAWN;\n\n")
header_lines.append("/* Trigger action byte (matches TRIGGER_ACTIONS in py_convert_stages.py). */\n")
header_lines.append("#define TRIGGER_ACTION_NONE         0\n")
header_lines.append("#define TRIGGER_ACTION_SWITCH_SCENE 1\n\n")
header_lines.append("/* Volume that performs an action when the player enters it. The volume is\n")
header_lines.append(" * an AXIS-ALIGNED box: centre `pos` +/- `halfExtent` per axis. stage-gen's\n")
header_lines.append(" * helper is a unit cube scaled by the entity's scale, so scale IS the\n")
header_lines.append(" * extent; the exporter halves it because a centre+half-extent test is one\n")
header_lines.append(" * subtract and one compare per axis. Entity ROTATION is not carried - a\n")
header_lines.append(" * rotated trigger behaves as its axis-aligned equivalent (an OBB test is\n")
header_lines.append(" * real work nothing has needed yet).\n")
header_lines.append(" *\n")
header_lines.append(" * targetStage is a stage NAME resolved against stageRegistry[] at runtime\n")
header_lines.append(" * (resolve-late, like model names), or NULL when unset. */\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned char action;      // TRIGGER_ACTION_* above\n")
header_lines.append("    VECTOR pos;                // volume CENTRE, same fixed-point space as STAGE_OBJECT.pos\n")
header_lines.append("    VECTOR halfExtent;         // half-size per axis; always >= 1 so the box has an interior\n")
header_lines.append("    const char *targetStage;   // switchScene: destination stage name, else NULL\n")
header_lines.append("    unsigned int targetSpawnId;// switchScene: which spawn to arrive at in that stage\n")
header_lines.append("    int onEnterSoundId;        // STAGE_SOUND.soundId to fire in THIS stage as the door opens, or -1 for none\n")
header_lines.append("    unsigned char userInteract;// 1 = player must press CROSS while inside; 0 = fires the moment they walk in\n")
header_lines.append("    unsigned char once;        // 1 = fire a single time, 0 = re-fire on every entry\n")
header_lines.append("} STAGE_TRIGGER;\n\n")
header_lines.append("/* Stage-level distance fog. A single block per stage (like the camera),\n")
header_lines.append(" * NOT an array - fog has no position and there is exactly one per stage.\n")
header_lines.append(" * main.c's load_stage_fog() copies these into its fog_* globals and calls\n")
header_lines.append(" * fog_clamp_range() (so nearZ/farZ are baked raw here - the runtime clamps\n")
header_lines.append(" * them into its projection's renderable range). The DEBUG-mode L1+L2 pad\n")
header_lines.append(" * editor still overrides all of this live; these are the authored defaults\n")
header_lines.append(" * the stage loads with. r/g/b also drive the SCREEN CLEAR colour, so the\n")
header_lines.append(" * void behind geometry matches the shade geometry depth-cues toward. */\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    unsigned char enabled;  // master fog toggle (fog_enabled)\n")
header_lines.append("    unsigned char cull;     // skip geometry entirely past farZ (fog_cull_enabled)\n")
header_lines.append("    unsigned char drift;    // slow one-sided breathing on the far edge (fog_drift_enabled)\n")
header_lines.append("    unsigned char layers;   // full-screen OT fog quads, 0..FOG_MAX_LAYERS (fog_layers)\n")
header_lines.append("    int nearZ;              // SZ at which fog begins, engine units (fog_near; clamped at load)\n")
header_lines.append("    int farZ;               // SZ at which fog is full, engine units (fog_far; clamped at load)\n")
header_lines.append("    unsigned char r, g, b;  // fog colour 0-255 (FOG_COL_*), also the screen clear colour\n")
header_lines.append("} STAGE_FOG;\n\n")
header_lines.append("typedef struct\n{\n")
header_lines.append("    const char *name;\n")
header_lines.append("    VECTOR  cameraPos;\n")
header_lines.append("    SVECTOR cameraRot;\n")
header_lines.append("    const STAGE_OBJECT *objects;\n")
header_lines.append("    unsigned int objectCount;\n")
header_lines.append("    const STAGE_SOUND *sounds; // NULL when the stage authors no sounds\n")
header_lines.append("    unsigned int soundCount;\n")
header_lines.append("    const STAGE_LIGHT *lights; // NULL when the stage authors no lights\n")
header_lines.append("    unsigned int lightCount;\n")
header_lines.append("    const STAGE_SPAWN *spawns; // NULL when the stage authors no spawn points\n")
header_lines.append("    unsigned int spawnCount;\n")
header_lines.append("    const STAGE_TRIGGER *triggers; // NULL when the stage authors no active triggers\n")
header_lines.append("    unsigned int triggerCount;\n")
header_lines.append("    const STAGE_COLLIDER *colliders; // NULL when the stage authors no boxes (objects fall back to automatic per-primitive AABBs)\n")
header_lines.append("    unsigned int colliderCount;\n")
header_lines.append("    const STAGE_POSTFX *postfx; // NULL when the stage authors no post-process volumes\n")
header_lines.append("    unsigned int postfxCount;\n")
header_lines.append("    STAGE_FOG fog;             // stage-level fog block (always present, even when disabled)\n")
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
    if entry["light_count"] > 0:
        lights_ref = f'{entry["ident"]}_lights, {entry["ident"]}_lightCount'
    else:
        lights_ref = "0, 0"  # no lights authored - no <ident>_lights[] array was emitted
    if entry["spawn_count"] > 0:
        spawns_ref = f'{entry["ident"]}_spawns, {entry["ident"]}_spawnCount'
    else:
        spawns_ref = "0, 0"  # no spawns authored - no <ident>_spawns[] array was emitted
    if entry["trigger_count"] > 0:
        triggers_ref = f'{entry["ident"]}_triggers, {entry["ident"]}_triggerCount'
    else:
        triggers_ref = "0, 0"  # no active triggers - no <ident>_triggers[] array was emitted

    if entry.get("has_postfx"):
        postfx_ref = f'{entry["ident"]}_postfx, {entry["ident"]}_postfxCount'
    else:
        postfx_ref = "0, 0"  # no post-process volumes authored

    if entry.get("has_colliders"):
        colliders_ref = f'{entry["ident"]}_colliders, {entry["ident"]}_colliderCount'
    else:
        # No authored boxes: main.c falls back to the automatic per-primitive
        # AABB for every collidable object in this stage.
        colliders_ref = "0, 0"
    fog = entry["fog"]  # (enabled, cull, drift, layers, nearZ, farZ, r, g, b)
    fog_ref = (
        f"{{ {fog[0]}, {fog[1]}, {fog[2]}, {fog[3]}, "
        f"{fog[4]}, {fog[5]}, {fog[6]}, {fog[7]}, {fog[8]} }}"
    )
    registry_lines.append(
        f'    {{ "{escaped_name}", '
        f'{{ {entry["cam_pos"][0]}, {entry["cam_pos"][1]}, {entry["cam_pos"][2]} }}, '
        f'{{ {entry["cam_rot"][0]}, {entry["cam_rot"][1]}, {entry["cam_rot"][2]} }}, '
        f'{entry["ident"]}_objects, {entry["ident"]}_objectCount, {sounds_ref}, {lights_ref}, '
        f'{spawns_ref}, {triggers_ref}, {colliders_ref}, {postfx_ref}, {fog_ref} }},\n'
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
