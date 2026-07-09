# root/py_convert_textures.py

import os
import struct
import subprocess
from pathlib import Path

# Run after py_convert_assets.py!

# img2tim.exe lives under whatever path the PSN00BPS1_TOOLS env var points
# to - set this once on your machine and this script finds it from there
# rather than hardcoding a path that'll break on another machine/CI box.
TOOLS_DIR = os.environ.get("PSN00BPS1_TOOLS")
if not TOOLS_DIR:
    raise SystemExit(
        "PSN00BPS1_TOOLS environment variable is not set. "
        "Point it at the directory containing img2tim.exe."
    )

IMG2TIM_EXE = Path(TOOLS_DIR) / "img2tim.exe"
if not IMG2TIM_EXE.exists():
    raise SystemExit(f"img2tim.exe not found at: {IMG2TIM_EXE}")

ROOT_DIR = Path(__file__).resolve().parent
ASSETS_DIR = ROOT_DIR / "assets"
GENERATED_DIR = ROOT_DIR / "generated"
SCRATCH_TIM_DIR = GENERATED_DIR / "_tim_scratch"

BLOB_BIN_PATH = GENERATED_DIR / "textures.bin"
BLOB_S_PATH = GENERATED_DIR / "tex_blob.S"
BLOB_HEADER_C_PATH = GENERATED_DIR / "tex_blob_table.c"

TEXTURE_BPP = 4

# ------------------------------------------------------------------
# VRAM budget / reserved zones
# ------------------------------------------------------------------
# PS1 VRAM is 1024x512 texels (16-bit units), origin top-left. The two
# 320x240 display buffers (init()'s SetDefDispEnv calls) sit at x=0,
# y=0/240 - reserving the full x:0-639 band anyway (matching the original
# hand-placed entries) leaves generous headroom rather than packing right
# up against the actual display buffers.
#
# Texture packing region: x in [TEX_REGION_X, VRAM_WIDTH), y in
# [TEX_REGION_Y, TEX_REGION_Y + TEX_REGION_HEIGHT).
# CLUT packing region: a separate strip below the texture region - CLUTs
# (16x1 texels each for 4bpp) are tiny and shouldn't fragment the texture
# packer's rows.
VRAM_WIDTH = 1024
VRAM_HEIGHT = 512

TEX_REGION_X = 640
TEX_REGION_Y = 0
TEX_REGION_HEIGHT = 400   # leaves y:400-511 for the CLUT strip below

CLUT_REGION_X = 0
CLUT_REGION_Y = 480
CLUT_REGION_HEIGHT = VRAM_HEIGHT - CLUT_REGION_Y  # 32 rows - plenty for 16x1 CLUTs stacked


def read_png_dimensions(path):
    """
    Reads width/height straight from the PNG IHDR chunk. PNG signature is
    8 bytes; IHDR chunk always immediately follows as: 4-byte length,
    4-byte type ('IHDR'), then 4-byte width + 4-byte height (big-endian),
    per the PNG spec - this ordering is guaranteed, so no need for a full
    PNG parser or an external dependency (Pillow, etc.) just to get
    dimensions.
    """
    with open(path, "rb") as f:
        header = f.read(24)

    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} does not look like a valid PNG (bad signature)")

    chunk_type = header[12:16]
    if chunk_type != b"IHDR":
        raise ValueError(f"{path} - expected IHDR as first chunk, got {chunk_type}")

    width, height = struct.unpack(">II", header[16:24])
    return width, height


def discover_textures():
    """
    Walks assets/*/textures/*.png and treats each file's stem as its
    material name (must match the corresponding usemtl in that object's
    .obj/.mtl exactly - per convention, no exceptions). Replaces the old
    hand-maintained TEXTURES list entirely: dropping a PNG into any
    assets/<object>/textures/ folder is now sufficient, no script edit
    required.

    Returns a list of dicts: material, source (absolute path), width,
    height - VRAM placement is decided later by pack_textures(), not here.
    """
    discovered = []
    seen_materials = {}

    for textures_dir in sorted(ASSETS_DIR.glob("*/textures")):
        for png_path in sorted(textures_dir.glob("*.png")):
            material = png_path.stem

            if material in seen_materials:
                raise SystemExit(
                    f"Duplicate material name '{material}' found at both "
                    f"{seen_materials[material]} and {png_path} - material "
                    f"names must be unique across the whole project since "
                    f"the runtime texture table is looked up by name alone."
                )
            seen_materials[material] = png_path

            width, height = read_png_dimensions(png_path)

            discovered.append({
                "material": material,
                "source": png_path,
                "width": width,
                "height": height,
            })

    return discovered


def pack_textures(discovered):
    """
    Shelf packer: sort tallest-first, pack left-to-right filling a row
    ("shelf") until the next texture wouldn't fit in the remaining width,
    then start a new shelf below the tallest item placed so far in the
    current shelf. This isn't space-optimal (a true bin-packer would do
    better on very mixed sizes) but it's simple, deterministic, and
    correct - reasonable for the dozens-of-textures scale a PS1 game
    realistically has, given VRAM itself caps total texture memory hard.

    4bpp VRAM width note: a texture's on-screen pixel width occupies
    width/4 VRAM texels (16-bit units, 4 pixels/word for 4bpp) - this
    packer works in VRAM-texel units throughout to avoid re-deriving that
    conversion in multiple places.

    Raises SystemExit if textures don't fit in the reserved region - this
    is deliberately a hard failure rather than silently overlapping into
    the frame buffer or another texture (the exact bug that bit you with
    the hand-placed Grass0/House0 entries).
    """
    items = []
    for entry in discovered:
        vram_w = (entry["width"] + 3) // 4   # ceil, in case width isn't a multiple of 4
        vram_h = entry["height"]
        items.append({**entry, "vram_w": vram_w, "vram_h": vram_h})

    # Tallest-first packs more efficiently with a shelf packer (avoids
    # short-then-tall-then-short fragmentation within a shelf).
    items.sort(key=lambda e: e["vram_h"], reverse=True)

    max_tex_x = VRAM_WIDTH
    max_tex_y = TEX_REGION_Y + TEX_REGION_HEIGHT

    cursor_x = TEX_REGION_X
    cursor_y = TEX_REGION_Y
    shelf_height = 0

    clut_cursor_x = CLUT_REGION_X
    clut_cursor_y = CLUT_REGION_Y

    for item in items:
        if item["vram_w"] > (VRAM_WIDTH - TEX_REGION_X):
            raise SystemExit(
                f"Texture '{item['material']}' ({item['width']}x{item['height']}) "
                f"is wider than the entire packing region "
                f"({VRAM_WIDTH - TEX_REGION_X} texels) - cannot place."
            )

        # Start a new shelf if this item doesn't fit in the remaining
        # width of the current row.
        if cursor_x + item["vram_w"] > max_tex_x:
            cursor_x = TEX_REGION_X
            cursor_y += shelf_height
            shelf_height = 0

        if cursor_y + item["vram_h"] > max_tex_y:
            raise SystemExit(
                f"Ran out of VRAM packing space placing texture "
                f"'{item['material']}' ({item['width']}x{item['height']}) - "
                f"reserved texture region is {VRAM_WIDTH - TEX_REGION_X}x"
                f"{TEX_REGION_HEIGHT} texels. Reduce texture sizes/count, or "
                f"widen TEX_REGION_HEIGHT (and shrink CLUT_REGION_HEIGHT / "
                f"move things around) in py_convert_textures.py."
            )

        item["vram_x"] = cursor_x
        item["vram_y"] = cursor_y

        cursor_x += item["vram_w"]
        shelf_height = max(shelf_height, item["vram_h"])

        # CLUT packing: independent strip, 16x1 texels per 4bpp texture
        # (16-color palette = 16 texels wide, 1 tall). Packed left-to-
        # right, wrapping to a new row when the strip's width is used up -
        # CLUT_REGION_HEIGHT rows gives plenty of headroom (32 rows x
        # (1024/16)=64 CLUTs per row = 2048 possible CLUTs, far beyond any
        # realistic texture count).
        CLUT_W = 16
        if clut_cursor_x + CLUT_W > VRAM_WIDTH:
            clut_cursor_x = CLUT_REGION_X
            clut_cursor_y += 1

        if clut_cursor_y >= CLUT_REGION_Y + CLUT_REGION_HEIGHT:
            raise SystemExit(
                f"Ran out of VRAM CLUT packing space placing texture "
                f"'{item['material']}' - CLUT strip exhausted. Widen "
                f"CLUT_REGION_HEIGHT in py_convert_textures.py."
            )

        item["clut_x"] = clut_cursor_x
        item["clut_y"] = clut_cursor_y
        clut_cursor_x += CLUT_W

    return items


def convert_texture(entry):
    """Runs img2tim, producing a standalone .tim in the scratch dir."""
    src_path = entry["source"]
    dst_path = SCRATCH_TIM_DIR / f"{entry['material']}.tim"

    cmd = [
        str(IMG2TIM_EXE),
        "-bpp", str(TEXTURE_BPP),
        "-org", str(entry["vram_x"]), str(entry["vram_y"]),
        "-plt", str(entry["clut_x"]), str(entry["clut_y"]),
        "-o", str(dst_path),
        str(src_path),
    ]

    print(f"\n{entry['material']}: {src_path.relative_to(ASSETS_DIR)} "
          f"({entry['width']}x{entry['height']}) -> {dst_path.name}")
    print(f"  img: VRAM ({entry['vram_x']}, {entry['vram_y']})  "
          f"clut: VRAM ({entry['clut_x']}, {entry['clut_y']})  bpp: {TEXTURE_BPP}")

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.stdout.strip():
        print(f"  {result.stdout.strip()}")
    if result.stderr.strip():
        print(f"  STDERR: {result.stderr.strip()}")

    if result.returncode != 0:
        print(f"  FAILED (exit code {result.returncode})")
        return None

    if not dst_path.exists():
        print(f"  FAILED - img2tim exited cleanly but {dst_path.name} was not created")
        return None

    print(f"  OK - {dst_path}")
    return dst_path


def build_blob(converted):
    """
    Concatenates every successfully-converted .tim into one blob, and
    emits textures.bin / tex_blob.S / tex_blob_table.c - unchanged from
    the previous version of this script.
    """
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)

    offsets = []  # (material_name, offset, length)

    with open(BLOB_BIN_PATH, "wb") as blob_out:
        running_offset = 0
        for entry, tim_path in converted:
            data = tim_path.read_bytes()
            blob_out.write(data)
            offsets.append((entry["material"], running_offset, len(data)))
            running_offset += len(data)

    blob_s_source = (
        "/* Auto-generated. Do not edit manually.\n"
        " * Concatenated TIM blob for all textures - this file's shape\n"
        " * never changes as textures are added/removed; only textures.bin\n"
        " * (rebuilt by py_convert_textures.py) and tex_blob_table.c\n"
        " * (the offset table) change per-build. */\n"
        "\n"
        "    .section .rodata\n"
        "    .align 4\n"
        "\n"
        "    .global tex_blob_start\n"
        "tex_blob_start:\n"
        f'    .incbin "{BLOB_BIN_PATH.as_posix()}"\n'
        "\n"
        "    .global tex_blob_end\n"
        "tex_blob_end:\n"
    )
    BLOB_S_PATH.write_text(blob_s_source, newline="\n")

    lines = []
    lines.append("/* Auto-generated by py_convert_textures.py. Do not edit manually. */\n\n")
    lines.append("extern const unsigned char tex_blob_start[];\n")
    lines.append("extern const unsigned char tex_blob_end[];\n\n")
    lines.append("typedef struct\n{\n")
    lines.append("    const char *material;\n")
    lines.append("    unsigned int offset;\n")
    lines.append("    unsigned int length;\n")
    lines.append("} TEX_BLOB_ENTRY;\n\n")
    lines.append(f"const unsigned int texBlobEntryCount = {len(offsets)};\n")
    lines.append("const TEX_BLOB_ENTRY texBlobMaterialTable[] = {\n")
    for name, offset, length in offsets:
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'    {{ "{escaped}", {offset}, {length} }},\n')
    lines.append("};\n")
    BLOB_HEADER_C_PATH.write_text("".join(lines), newline="\n")

    print(f"\nBlob written: {BLOB_BIN_PATH} ({running_offset} bytes total)")
    print(f"Generated: {BLOB_S_PATH}")
    print(f"Generated: {BLOB_HEADER_C_PATH}")


if __name__ == "__main__":
    SCRATCH_TIM_DIR.mkdir(parents=True, exist_ok=True)

    discovered = discover_textures()
    print(f"Discovered {len(discovered)} texture(s):")
    for entry in discovered:
        print(f"  {entry['material']} <- {entry['source'].relative_to(ASSETS_DIR)} "
              f"({entry['width']}x{entry['height']})")

    packed = pack_textures(discovered)

    converted = []
    failed = 0

    for entry in packed:
        tim_path = convert_texture(entry)
        if tim_path is not None:
            converted.append((entry, tim_path))
        else:
            failed += 1

    if converted:
        build_blob(converted)

    for _, tim_path in converted:
        tim_path.unlink()
    if SCRATCH_TIM_DIR.exists() and not any(SCRATCH_TIM_DIR.iterdir()):
        SCRATCH_TIM_DIR.rmdir()

    print(f"\n{len(converted)} converted, {failed} failed (of {len(discovered)} total)")