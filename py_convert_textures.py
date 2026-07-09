# root/py_convert_textures.py

import struct
from pathlib import Path

# Run after py_convert_assets.py!

# ------------------------------------------------------------------
# Every texture is now a single hand-authored .tim, built externally by
# the PaletteGen web tool (tim_writer.js). A texture with palette
# variants is STILL ONE FILE - "House0.tim" - containing multiple
# stacked CLUT rows (clut_height > 1) all pointing at ONE shared image
# block. There is no more "House0.pal1.tim" sibling-file convention;
# that was superseded once tim_writer.js could stack palettes inside a
# single TIM instead of duplicating pixel data across separate files.
#
# Row order in the file is exactly PaletteGen's sidebar order (row 0 =
# first palette in the list, etc.) - this script does not reorder rows,
# it only reads however many rows the file already has.
#
# Row SELECTION is not this script's job and is not encoded in the
# material name - one blob entry covers every row a file has
# (clut_height is carried through as paletteCount for range-checking).
# main.c currently picks a row via a single runtime global
# (active_palette, cycled with pad 2 SQUARE/CIRCLE) applied to every
# textured triangle; a future scene loader is expected to make this
# per-object instead - see active_palette's comment in main.c.
#
# This script's job:
#   1. discover .tim files in assets/*/textures/
#   2. read clut_height from each to know how many palette rows it has
#   3. auto-assign non-overlapping VRAM placement: ONE image rect per
#      file (shared by all its rows) + a CLUT strip tall enough to hold
#      all of that file's rows, stacked consecutively
#   4. patch the four placement fields in-place (image_x/y, clut_x/y -
#      clut_y is the Y of ROW 0; row k lives at clut_y+k, unchanged by
#      this script, just read and relied upon)
#   5. concatenate everything into one blob + generated offset/length
#      table, with one blob entry PER FILE (not per row)
# ------------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent
ASSETS_DIR = ROOT_DIR / "assets"
GENERATED_DIR = ROOT_DIR / "generated"

BLOB_BIN_PATH = GENERATED_DIR / "textures.bin"
BLOB_S_PATH = GENERATED_DIR / "tex_blob.S"
BLOB_HEADER_C_PATH = GENERATED_DIR / "tex_blob_table.c"
# TEX_BLOB_ENTRY's definition lives ONLY here now - both tex_blob_table.c
# (the data) and main.c (the consumer) #include this instead of each
# carrying their own copy of the struct. That's what let paletteCount
# silently drift out of main.c before: two independent typedefs of the
# same name, same struct tag, different field count, no compiler error
# across translation units to catch it.
BLOB_HEADER_H_PATH = GENERATED_DIR / "tex_blob_table.h"

# ------------------------------------------------------------------
# VRAM budget / reserved zones (unchanged reasoning from earlier
# versions - hand-maintained constants).
# ------------------------------------------------------------------
VRAM_WIDTH = 1024
VRAM_HEIGHT = 512

TEX_REGION_X = 640
TEX_REGION_Y = 0
TEX_REGION_HEIGHT = 400   # leaves y:400-511 for the CLUT strip below

CLUT_REGION_X = 0
CLUT_REGION_Y = 480
CLUT_REGION_HEIGHT = VRAM_HEIGHT - CLUT_REGION_Y  # 32 rows


# ------------------------------------------------------------------
# TIM header parsing/patching
# ------------------------------------------------------------------
# Byte layout per the PaletteGen NEW export format doc (matches the
# earlier independently-sourced spec exactly, and matches tim_writer.js's
# own verified output byte-for-byte):
#
#   offset 0:  u32 magic (0x10)
#   offset 4:  u32 flags
#   offset 8:  u32 clut_block_length
#   offset 12: u16 clut_x            <- PATCH
#   offset 14: u16 clut_y            <- PATCH (Y of ROW 0; row k = clut_y+k)
#   offset 16: u16 clut_width (units, always 16 for one 4bpp palette row)
#   offset 18: u16 clut_height       (READ ONLY - number of palette rows;
#                                     this script does not change how many
#                                     rows exist, only where they land)
#   offset 20: clut pixel data (clut_width * clut_height * 2 bytes)
#   offset 20+clutdata: u32 image_block_length
#   +4:  u16 image_x                 <- PATCH
#   +6:  u16 image_y                 <- PATCH
#   +8:  u16 image_width (units)
#   +10: u16 image_height (pixels)
#   +12: image pixel data
#
# All fields little-endian.

TIM_MAGIC = 0x00000010


def read_tim_header(data):
    """
    Parses just enough of a .tim's header to know its CLUT/image
    dimensions and row count - needed for VRAM packing - without
    touching pixel data. Raises ValueError on anything that doesn't
    look like a real TIM.
    """
    if len(data) < 8:
        raise ValueError("File too short to be a valid TIM")

    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != TIM_MAGIC:
        raise ValueError(f"Bad TIM magic: 0x{magic:08x} (expected 0x{TIM_MAGIC:08x})")

    flags = struct.unpack_from("<I", data, 4)[0]
    has_clut = bool(flags & 0x8)

    if not has_clut:
        raise ValueError(
            "TIM has no CLUT block (flags indicate CLUT-less image) - "
            "this pipeline only supports 4bpp indexed TIMs with an "
            "embedded CLUT, matching tim_writer.js's own output."
        )

    clut_block_length = struct.unpack_from("<I", data, 8)[0]
    clut_width_units, clut_height = struct.unpack_from("<HH", data, 16)

    if clut_width_units != 16:
        raise ValueError(
            f"Unexpected clut_width_units={clut_width_units} (expected "
            f"16 for a single 4bpp palette row) - this pipeline assumes "
            f"one palette row is always exactly 16 colors wide."
        )

    if clut_height < 1 or clut_height > 16:
        raise ValueError(
            f"clut_height={clut_height} is out of the expected 1-16 "
            f"range for a 4bpp TIM (max 16 palettes before running past "
            f"VRAM height limits at pack time)."
        )

    image_block_offset = 8 + clut_block_length
    if image_block_offset + 12 > len(data):
        raise ValueError("TIM file truncated - image block header out of range")

    image_width_units, image_height = struct.unpack_from("<HH", data, image_block_offset + 8)

    return {
        "clut_block_length": clut_block_length,
        "clut_width_units": clut_width_units,
        "clut_height": clut_height,
        "image_block_offset": image_block_offset,
        "image_width_units": image_width_units,
        "image_height": image_height,
    }


def patch_tim_placement(data, image_x, image_y, clut_x, clut_y):
    """
    Overwrites the four VRAM placement fields in a .tim's header IN
    PLACE (returns new bytes - caller writes this into the blob, never
    mutating the original file on disk).

    clut_x must be a multiple of 16 (PS1 hardware requirement) and
    clut_y + clut_height (read from the file itself) must not exceed
    VRAM height - both re-validated here since the coordinates being
    written now come from THIS script's packer, not whatever tim_writer.js
    originally baked in as a placeholder.
    """
    if clut_x % 16 != 0:
        raise ValueError(f"clut_x ({clut_x}) must be a multiple of 16")

    header = read_tim_header(data)

    if clut_y + header["clut_height"] > VRAM_HEIGHT:
        raise ValueError(
            f"clut_y ({clut_y}) + clut_height ({header['clut_height']}) "
            f"exceeds VRAM height ({VRAM_HEIGHT})"
        )

    patched = bytearray(data)

    # CLUT x/y at fixed offsets 12/14 - this is the Y of ROW 0 only;
    # rows 1..N-1 are implicitly at clut_y+1, clut_y+2, etc. inside the
    # file's own existing CLUT data, which this patch does not touch.
    struct.pack_into("<HH", patched, 12, clut_x, clut_y)

    # Image x/y at image_block_offset + 4 / +6
    img_off = header["image_block_offset"]
    struct.pack_into("<HH", patched, img_off + 4, image_x, image_y)

    return bytes(patched), header


# ------------------------------------------------------------------
# Discovery: one .tim per base texture, possibly containing multiple
# palette rows internally. No more sibling-file (.pal1.tim) convention.
# ------------------------------------------------------------------
def discover_tims():
    discovered = []
    seen_names = {}

    for textures_dir in sorted(ASSETS_DIR.glob("*/textures")):
        for tim_path in sorted(textures_dir.glob("*.tim")):
            base_name = tim_path.stem  # e.g. "House0" - the whole file is one texture

            if base_name in seen_names:
                raise SystemExit(
                    f"Duplicate texture name '{base_name}' found at both "
                    f"{seen_names[base_name]} and {tim_path} - texture "
                    f"names must be unique across the whole project."
                )
            seen_names[base_name] = tim_path

            data = tim_path.read_bytes()
            try:
                header = read_tim_header(data)
            except ValueError as e:
                raise SystemExit(f"{tim_path}: {e}")

            discovered.append({
                "base_name": base_name,
                "source": tim_path,
                "data": data,
                "clut_height": header["clut_height"],
                "image_width_units": header["image_width_units"],
                "image_height": header["image_height"],
            })

    return discovered


# ------------------------------------------------------------------
# VRAM packing
# ------------------------------------------------------------------
# Simpler than the sibling-file era: ONE image rect per file (shared by
# every palette row inside it), and a CLUT reservation of exactly
# clut_height consecutive rows - no more packing one image rect PER
# PALETTE, since palettes no longer duplicate pixel data.
def pack_tims(discovered):
    items = sorted(discovered, key=lambda e: e["image_height"], reverse=True)

    max_tex_x = VRAM_WIDTH
    max_tex_y = TEX_REGION_Y + TEX_REGION_HEIGHT

    cursor_x = TEX_REGION_X
    cursor_y = TEX_REGION_Y
    shelf_height = 0

    # CLUT strip packed as consecutive ROWS (not columns) per file, since
    # a multi-palette file needs clut_height contiguous Y rows all at
    # the same clut_x - packing left-to-right in X the way single-row
    # CLUTs did before doesn't apply once a file can be several rows
    # tall. Instead: stack each file's row-block underneath the previous
    # one, always at CLUT_REGION_X (column 0 of the strip) - simpler,
    # and CLUT data is tiny (16 texels wide) so wasting the rest of the
    # strip's width per file is not a real budget concern.
    clut_cursor_y = CLUT_REGION_Y

    for item in items:
        img_w = item["image_width_units"]
        img_h = item["image_height"]

        if img_w > (VRAM_WIDTH - TEX_REGION_X):
            raise SystemExit(
                f"'{item['base_name']}' image is wider ({img_w} units) "
                f"than the entire packing region "
                f"({VRAM_WIDTH - TEX_REGION_X} units) - cannot place."
            )

        if cursor_x + img_w > max_tex_x:
            cursor_x = TEX_REGION_X
            cursor_y += shelf_height
            shelf_height = 0

        if cursor_y + img_h > max_tex_y:
            raise SystemExit(
                f"Ran out of VRAM packing space placing '{item['base_name']}' "
                f"({img_w}x{img_h} units) - reserved region is "
                f"{VRAM_WIDTH - TEX_REGION_X}x{TEX_REGION_HEIGHT}. Reduce "
                f"texture sizes/count, or adjust TEX_REGION_HEIGHT."
            )

        item["vram_x"] = cursor_x
        item["vram_y"] = cursor_y

        cursor_x += img_w
        shelf_height = max(shelf_height, img_h)

        # CLUT placement: reserve clut_height consecutive rows starting
        # at clut_cursor_y, always at CLUT_REGION_X.
        rows_needed = item["clut_height"]
        if clut_cursor_y + rows_needed > CLUT_REGION_Y + CLUT_REGION_HEIGHT:
            raise SystemExit(
                f"Ran out of VRAM CLUT packing space placing "
                f"'{item['base_name']}' (needs {rows_needed} palette "
                f"row(s)) - CLUT strip exhausted. Widen CLUT_REGION_HEIGHT "
                f"in py_convert_textures.py."
            )

        item["clut_x"] = CLUT_REGION_X
        item["clut_y"] = clut_cursor_y
        clut_cursor_y += rows_needed

    return items


# ------------------------------------------------------------------
# Patch + concatenate into the blob
# ------------------------------------------------------------------
def build_blob(packed):
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)

    offsets = []  # (base_name, offset, length, clut_height) - one entry PER FILE

    with open(BLOB_BIN_PATH, "wb") as blob_out:
        running_offset = 0
        for item in packed:
            patched_data, _header = patch_tim_placement(
                item["data"],
                image_x=item["vram_x"], image_y=item["vram_y"],
                clut_x=item["clut_x"], clut_y=item["clut_y"],
            )
            blob_out.write(patched_data)
            offsets.append((
                item["base_name"], running_offset, len(patched_data), item["clut_height"]
            ))
            running_offset += len(patched_data)

            palette_note = (
                f"{item['clut_height']} palette row(s)"
                if item["clut_height"] > 1 else "1 palette (no variants)"
            )
            print(f"{item['base_name']}: {item['source'].relative_to(ASSETS_DIR)} "
                  f"-> img@({item['vram_x']},{item['vram_y']}) "
                  f"clut@({item['clut_x']},{item['clut_y']}) [{palette_note}]")

    blob_s_source = (
        "/* Auto-generated. Do not edit manually.\n"
        " * Concatenated TIM blob for all textures - this file's shape\n"
        " * never changes as textures are added/removed; only textures.bin\n"
        " * and tex_blob_table.c change per-build. */\n"
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

    # Shared header: struct definition + extern declarations, #include'd by
    # BOTH tex_blob_table.c (below) and main.c. paletteCount travels
    # alongside offset/length so main.c can validate a requested palette
    # row is actually in range, rather than silently reading past a
    # texture's real CLUT data into whatever bytes happen to follow it in
    # the blob.
    header_lines = []
    header_lines.append("/* Auto-generated by py_convert_textures.py. Do not edit manually.\n")
    header_lines.append(" * Included by tex_blob_table.c (defines the table) and main.c (reads\n")
    header_lines.append(" * it) - keep this the ONLY place TEX_BLOB_ENTRY is defined. */\n\n")
    header_lines.append("#ifndef TEX_BLOB_TABLE_H\n")
    header_lines.append("#define TEX_BLOB_TABLE_H\n\n")
    header_lines.append("extern const unsigned char tex_blob_start[];\n")
    header_lines.append("extern const unsigned char tex_blob_end[];\n\n")
    header_lines.append("typedef struct\n{\n")
    header_lines.append("    const char *material;\n")
    header_lines.append("    unsigned int offset;\n")
    header_lines.append("    unsigned int length;\n")
    header_lines.append("    unsigned int paletteCount;\n")
    header_lines.append("} TEX_BLOB_ENTRY;\n\n")
    header_lines.append("extern const unsigned int texBlobEntryCount;\n")
    header_lines.append("extern const TEX_BLOB_ENTRY texBlobMaterialTable[];\n\n")
    header_lines.append("#endif\n")
    BLOB_HEADER_H_PATH.write_text("".join(header_lines), newline="\n")

    # tex_blob_table.c now just holds the actual data, typed against the
    # shared header instead of redefining the struct itself.
    lines = []
    lines.append("/* Auto-generated by py_convert_textures.py. Do not edit manually. */\n\n")
    lines.append('#include "tex_blob_table.h"\n\n')
    lines.append(f"const unsigned int texBlobEntryCount = {len(offsets)};\n")
    lines.append("const TEX_BLOB_ENTRY texBlobMaterialTable[] = {\n")
    for name, offset, length, clut_height in offsets:
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'    {{ "{escaped}", {offset}, {length}, {clut_height} }},\n')
    lines.append("};\n")
    BLOB_HEADER_C_PATH.write_text("".join(lines), newline="\n")

    print(f"\nBlob written: {BLOB_BIN_PATH} ({running_offset} bytes total)")
    print(f"Generated: {BLOB_S_PATH}")
    print(f"Generated: {BLOB_HEADER_H_PATH}")
    print(f"Generated: {BLOB_HEADER_C_PATH}")


if __name__ == "__main__":
    discovered = discover_tims()

    print(f"Discovered {len(discovered)} texture(s):")
    for entry in discovered:
        print(f"  {entry['base_name']} <- {entry['source'].relative_to(ASSETS_DIR)} "
              f"({entry['image_width_units']*4}x{entry['image_height']} px, "
              f"{entry['clut_height']} palette row(s))")

    if not discovered:
        print("Nothing to do.")
    else:
        packed = pack_tims(discovered)
        build_blob(packed)