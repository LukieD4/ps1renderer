# root/py_convert_textures.py

import os
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

# Textures now live alongside the object that uses them
# (assets/<object>/textures/<file>.png), not in one shared assets/textures/
# folder - see py_migrate_assets.py for the one-time move. Converted TIM
# output lands directly in assets_c/ (no textures/ subfolder), flat
# alongside the converted .c model files - same reasoning as the flat .c
# output: everything in assets_c/ is fully regenerated each run, so
# there's no benefit to mirroring the per-object source structure, or to
# splitting textures out from models, on the output side.
#
# NOTE: this moves face.tim from assets_c/textures/face.tim to
# assets_c/face.tim - if tim_face.S .incbin's the TIM by path (rather than
# a build-system-resolved include dir), that path needs updating there too.
ROOT_DIR = Path(__file__).resolve().parent
ASSETS_DIR = ROOT_DIR / "assets"
OUTPUT_TEXTURE_DIR = ROOT_DIR / "assets_c"

# VRAM placement - img2tim does NOT pick this for you and does no overlap
# checking (per img2tim.txt: "No offset checking is done so its recommended
# to check the resulting tim file with timtool"). These are plain constants
# for now since there's only one texture; if/when more textures show up,
# each one needs its own non-overlapping (vram_x, vram_y) / (clut_x, clut_y)
# pair - bump these by texture width/16 (4-bit CLUTs are 16x1) rather than
# guessing, or check the result in TIMedit/timtool before trusting it.
TEXTURE_BPP = 4  # // 256x256 image

TEXTURES = [
    {
        # Path relative to ASSETS_DIR - now points at the per-object
        # textures/ folder instead of a shared top-level one.
        "source": "ball/textures/face.png",
        "output": "face.tim",
        "vram_x": 640,   # arbitrary starting point outside the two
        "vram_y": 0,     # 320x240 double-buffered display areas (0-319 / 320-639 in X)
        "clut_x": 0,
        "clut_y": 480,   # img2tim's own documented default CLUT spot
    },
    # Add additional textures here as new dicts; each needs vram coords
    # that don't overlap any other texture/CLUT/frame buffer in this list.
    # "source" is relative to ASSETS_DIR, e.g. "somemodel/textures/foo.png".
]


def convert_texture(entry):
    src_path = ASSETS_DIR / entry["source"]
    # dst_path now resolves to assets_c/<output>.tim directly (no
    # textures/ subfolder) - OUTPUT_TEXTURE_DIR points at assets_c/ itself.
    dst_path = OUTPUT_TEXTURE_DIR / entry["output"]

    if not src_path.exists():
        print(f"  SKIPPED - source not found: {src_path}")
        return False

    cmd = [
        str(IMG2TIM_EXE),
        "-bpp", str(TEXTURE_BPP),
        "-org", str(entry["vram_x"]), str(entry["vram_y"]),
        "-plt", str(entry["clut_x"]), str(entry["clut_y"]),
        "-o", str(dst_path),
        str(src_path),
    ]

    print(f"\n{entry['source']} -> {entry['output']}")
    print(f"  img: VRAM ({entry['vram_x']}, {entry['vram_y']})  "
          f"clut: VRAM ({entry['clut_x']}, {entry['clut_y']})  bpp: {TEXTURE_BPP}")

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.stdout.strip():
        print(f"  {result.stdout.strip()}")
    if result.stderr.strip():
        print(f"  STDERR: {result.stderr.strip()}")

    if result.returncode != 0:
        print(f"  FAILED (exit code {result.returncode})")
        return False

    if not dst_path.exists():
        # img2tim returned 0 but didn't actually produce the file - treat
        # this as a failure too rather than silently reporting success.
        print(f"  FAILED - img2tim exited cleanly but {dst_path.name} was not created")
        return False

    print(f"  OK - {dst_path}")
    return True


if __name__ == "__main__":
    OUTPUT_TEXTURE_DIR.mkdir(parents=True, exist_ok=True)

    succeeded = 0
    failed = 0

    for entry in TEXTURES:
        if convert_texture(entry):
            succeeded += 1
        else:
            failed += 1

    print(f"\n{succeeded} converted, {failed} failed (of {len(TEXTURES)} total)")