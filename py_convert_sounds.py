# root/py_convert_sounds.py
#
# Generates iso.xml from iso.xml.template by expanding the
# "@SOUND_VAG_FILES@" placeholder into one <file> entry per discovered
# assets/sound/**/*.vag - so dropping a new sample into assets/sound/ is
# all it takes to ship it on the disc (no more hand-editing iso.xml and
# forgetting, which shows up at runtime as SFX UNRES on the debug
# overlay).
#
# ALSO emits the tier-2 embedded-audio fallback (same .incbin-blob
# pattern as py_convert_textures.py's texture blob):
#   generated/sound_embed.bin      every shipped audio file, concatenated
#                                  (each entry 4-byte aligned for SPU DMA)
#   generated/sound_embed.S        fixed .incbin of sound_embed.bin
#   generated/sound_embed_table.c  cdPath -> offset/length table
#   generated/sound_embed_table.h  SND_EMBED_ENTRY struct + externs
# sfx.c/music.c fall back to these blobs when a CD load fails at any
# step, so audio survives a hostile CD path on real hardware while the
# overlay's ERR codes still report what the CD path did. NOTE: these
# live in generated/, which py_convert_assets.py WIPES - so this script
# runs both at CMake configure time (for iso.xml) and as the last step
# of the atomic conversion pipeline (to restore the embed artifacts).
#
# EDIT iso.xml.template, NOT iso.xml - iso.xml is overwritten by this
# script. Everything except the placeholder passes through verbatim,
# including the ${PROJECT_SOURCE_DIR}/${PSN00BSDK_VERSION} tokens CMake
# substitutes later (this script must not touch those).
#
# Runs automatically at CMake configure time (see CMakeLists.txt, which
# also globs the .vag files with CONFIGURE_DEPENDS so adding/removing one
# triggers a reconfigure). Can also be run by hand from the repo root.
#
# Naming rules, matching py_convert_stages.py's sample_to_cd_path():
#   - disc name = <BASENAME uppercased>.VAG (ISO9660 8.3), so the
#     basename must be 1-8 chars of A-Z 0-9 _ after uppercasing;
#   - basenames must be UNIQUE across all of assets/sound/ (the disc
#     root is flat) - two folders both containing "CAW1.vag" is an error
#     here rather than a silent last-one-wins on the disc.

import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
SOUND_DIR = ROOT_DIR / "assets" / "sound"
MUSIC_DIR = SOUND_DIR / "music"
TEMPLATE_PATH = ROOT_DIR / "iso.xml.template"
OUTPUT_PATH = ROOT_DIR / "iso.xml"

GENERATED_DIR = ROOT_DIR / "generated"
EMBED_BIN     = GENERATED_DIR / "sound_embed.bin"
EMBED_S       = GENERATED_DIR / "sound_embed.S"
EMBED_TABLE_C = GENERATED_DIR / "sound_embed_table.c"
EMBED_TABLE_H = GENERATED_DIR / "sound_embed_table.h"

PLACEHOLDER = "<!-- @SOUND_VAG_FILES@ -->"
MUSIC_PLACEHOLDER = "<!-- @MUSIC_FILES@ -->"

# The BIOS limits the disc ROOT directory to 30 entries total. The
# template carries ~5 fixed root files (SYSTEM.CNF, TEMPLATE.EXE,
# SONG.VAB/SEQ, README); warn well before the hard wall so the fix
# (moving samples into a <dir>) can happen calmly, not as a boot failure.
ROOT_ENTRY_SOFT_LIMIT = 24

# Subfolders of assets/sound/ whose .vag files are NOT standalone stage
# samples and must not be shipped as disc root files:
#   instruments/ - OST Studio's raw instrument waveforms; they reach the
#                  disc INSIDE the compiled SONG.VAB, and their long
#                  descriptive names (BASSBOWED, ...) aren't 8.3 anyway.
#   music/       - the VAB/SEQ pair lives here, listed by hand in the
#                  template (not .vag, but excluded for future-proofing).
EXCLUDED_SUBDIRS = {"instruments", "music"}


def discover_vags():
    if not SOUND_DIR.exists():
        return []
    # rglob("*") + suffix filter instead of rglob("*.vag") so the match is
    # case-insensitive on every platform (WIND.VAG and caw1.vag both count).
    return sorted(
        (
            p
            for p in SOUND_DIR.rglob("*")
            if p.is_file()
            and p.suffix.lower() == ".vag"
            and not (set(p.relative_to(SOUND_DIR).parts[:-1]) & EXCLUDED_SUBDIRS)
        ),
        key=lambda p: p.name.upper(),
    )


def discover_music():
    """
    assets/sound/music/*.vab + *.seq (case-insensitive), played by
    music.c. Ships every file found; warns about an unpaired VAB or SEQ
    (a stage's mode=music entity always resolves BOTH \\NAME.VAB;1 and
    \\NAME.SEQ;1, so half a pair means silence at runtime).
    """
    if not MUSIC_DIR.exists():
        return []
    files = sorted(
        (p for p in MUSIC_DIR.iterdir() if p.is_file() and p.suffix.lower() in (".vab", ".seq")),
        key=lambda p: (p.stem.upper(), p.suffix.upper()),
    )
    stems = {}
    for p in files:
        stems.setdefault(p.stem.upper(), set()).add(p.suffix.lower())
    for stem, exts in sorted(stems.items()):
        if exts != {".vab", ".seq"}:
            missing = ".SEQ" if ".vab" in exts else ".VAB"
            print(
                f"WARNING: assets/sound/music/{stem} has no {missing} half - "
                f"a mode=music sound entity referencing '{stem}' will be silent.",
                file=sys.stderr,
            )
    return files


def write_embed_artifacts(embed_files):
    """
    embed_files: list of (disc_path, source Path) where disc_path is the
    runtime CD path string the loaders use, e.g. "\\WIND.VAG;1" - the
    embed table is keyed by EXACTLY that string so sound_embed_find() is
    a plain strcmp against STAGE_SOUND.cdPath / the music pair paths.
    """
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)

    blob = bytearray()
    entries = []  # (disc_path, offset, length)
    for disc_path, src in embed_files:
        data = src.read_bytes()
        # 4-byte-align each entry: VAG bodies (offset 48) and VAB VB
        # sections (offset 0x20+2048+n*512+512) are then also aligned,
        # which SpuWrite's DMA wants.
        while len(blob) % 4:
            blob.append(0)
        entries.append((disc_path, len(blob), len(data)))
        blob += data

    EMBED_BIN.write_bytes(bytes(blob))

    # .incbin with an absolute forward-slash path, matching tex_blob.S -
    # this file's shape never changes; only the .bin and table do.
    EMBED_S.write_text(
        "/* Auto-generated by py_convert_sounds.py. Do not edit manually.\n"
        " * Concatenated audio blob (tier-2 embedded fallback) - same\n"
        " * .incbin pattern as tex_blob.S. */\n"
        "\n"
        "    .section .rodata\n"
        "    .align 4\n"
        "\n"
        "    .global snd_embed_start\n"
        "snd_embed_start:\n"
        f"    .incbin \"{EMBED_BIN.as_posix()}\"\n"
        "\n"
        "    .global snd_embed_end\n"
        "snd_embed_end:\n",
        newline="\n",
    )

    EMBED_TABLE_H.write_text(
        "/* Auto-generated by py_convert_sounds.py. Do not edit manually.\n"
        " * Included by sound_embed_table.c (defines the table) and\n"
        " * sound.c (sound_embed_find) - keep this the ONLY place\n"
        " * SND_EMBED_ENTRY is defined. */\n"
        "\n"
        "#ifndef SOUND_EMBED_TABLE_H\n"
        "#define SOUND_EMBED_TABLE_H\n"
        "\n"
        "extern const unsigned char snd_embed_start[];\n"
        "extern const unsigned char snd_embed_end[];\n"
        "\n"
        "typedef struct\n"
        "{\n"
        "    const char *cdPath;     /* runtime CD path, e.g. \"\\\\WIND.VAG;1\" */\n"
        "    unsigned int offset;    /* into snd_embed_start[] (4-byte aligned) */\n"
        "    unsigned int length;    /* file bytes */\n"
        "} SND_EMBED_ENTRY;\n"
        "\n"
        "extern const unsigned int sndEmbedEntryCount;\n"
        "extern const SND_EMBED_ENTRY sndEmbedTable[];\n"
        "\n"
        "#endif\n",
        newline="\n",
    )

    lines = [
        "/* Auto-generated by py_convert_sounds.py. Do not edit manually. */",
        "",
        '#include "sound_embed_table.h"',
        "",
        f"const unsigned int sndEmbedEntryCount = {len(entries)};",
        "",
        "const SND_EMBED_ENTRY sndEmbedTable[] = {",
    ]
    for disc_path, off, length in entries:
        c_path = disc_path.replace("\\", "\\\\")
        lines.append(f'    {{ "{c_path}", {off}u, {length}u }},')
    if not entries:
        lines.append("    { 0, 0u, 0u }, /* keep the array non-empty */")
    lines.append("};")
    lines.append("")
    EMBED_TABLE_C.write_text("\n".join(lines), newline="\n")

    total = len(blob)
    print(
        f"Generated: {EMBED_BIN.relative_to(ROOT_DIR)} "
        f"({len(entries)} file(s), {total} bytes embedded in the EXE)"
    )


def main():
    template = TEMPLATE_PATH.read_text()
    for ph in (PLACEHOLDER, MUSIC_PLACEHOLDER):
        if ph not in template:
            raise SystemExit(
                f"{TEMPLATE_PATH}: placeholder {ph!r} not found - "
                f"it must appear exactly as-is (see the template's own comment)"
            )

    vags = discover_vags()

    entries = []
    seen = {}  # disc basename -> source path (collision reporting)

    for vag in vags:
        name = vag.stem.upper()
        if not re.fullmatch(r"[A-Z0-9_]{1,8}", name):
            raise SystemExit(
                f"{vag}: basename {vag.stem!r} is not a valid 8.3 base name "
                f"(1-8 chars, A-Z 0-9 _ only after uppercasing) - rename the file"
            )
        if name in seen:
            raise SystemExit(
                f"disc name collision: {vag} and {seen[name]} would both be "
                f"\\{name}.VAG on the disc (the root is flat) - rename one"
            )
        seen[name] = vag

        rel = vag.relative_to(ROOT_DIR).as_posix()
        entries.append(
            f'<file name="{name}.VAG"\t\ttype="data" source="${{PROJECT_SOURCE_DIR}}/{rel}" />'
        )

    # Music pairs (VAB/SEQ). Same flat disc root, so the same 8.3
    # validation and the same collision namespace-per-full-name rules.
    music_files = discover_music()
    music_entries = []
    shipped_music = []
    for mf in music_files:
        stem = mf.stem.upper()
        if not re.fullmatch(r"[A-Z0-9_]{1,8}", stem):
            # WARN + SKIP rather than hard-fail (unlike .vag samples,
            # which error): OST Studio exports carry song-title names
            # ("Something_is_amiss.seq"), and a WIP export sitting in the
            # folder shouldn't break every CMake configure. It just
            # can't ship until renamed to 8.3 - which the warning says.
            print(
                f"WARNING: skipping assets/sound/music/{mf.name} - basename "
                f"{mf.stem!r} is not 8.3 (1-8 chars, A-Z 0-9 _). Rename it "
                f"(e.g. AMISS.vab/.seq) for it to ship on the disc.",
                file=sys.stderr,
            )
            continue
        rel = mf.relative_to(ROOT_DIR).as_posix()
        music_entries.append(
            f'<file name="{stem}{mf.suffix.upper()}"\t\ttype="data" source="${{PROJECT_SOURCE_DIR}}/{rel}" />'
        )
        shipped_music.append(mf)

    if len(entries) + len(music_entries) > ROOT_ENTRY_SOFT_LIMIT:
        print(
            f"WARNING: {len(entries)} .vag + {len(music_entries)} music entries approaches "
            f"the BIOS's 30-entry root directory limit (plus the fixed files) - consider a <dir>.",
            file=sys.stderr,
        )

    def expand(text, placeholder, entry_list, empty_note):
        # Match the placeholder line's own leading whitespace so the
        # generated entries sit at the same indentation depth in the tree.
        m = re.search(r"^([ \t]*)" + re.escape(placeholder), text, re.MULTILINE)
        indent = m.group(1) if m else "\t\t\t"
        repl = ("\n" + indent).join(entry_list) if entry_list else empty_note
        return text.replace(placeholder, repl)

    output = expand(template, PLACEHOLDER, entries, "<!-- no .vag files found under assets/sound/ -->")
    output = expand(output, MUSIC_PLACEHOLDER, music_entries, "<!-- no .vab/.seq files found under assets/sound/music/ -->")

    header = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
        "<!-- AUTO-GENERATED by py_convert_sounds.py from iso.xml.template -\n"
        "     do NOT edit this file, edit the template. -->\n"
    )
    # Replace the template's own XML declaration line so the generated
    # warning sits at the very top of iso.xml.
    output = re.sub(r"^<\?xml[^>]*\?>\n", header, output, count=1)

    OUTPUT_PATH.write_text(output, newline="\n")

    # Tier-2 embedded fallback: every file that ships on the disc is
    # also baked into the EXE, keyed by its exact runtime CD path.
    embed_files = [(f"\\{name}.VAG;1", seen[name]) for name in sorted(seen)]
    embed_files += [
        (f"\\{mf.stem.upper()}{mf.suffix.upper()};1", mf) for mf in shipped_music
    ]
    write_embed_artifacts(embed_files)

    print(f"Generated: {OUTPUT_PATH} ({len(entries)} sound file(s), {len(music_entries)} music file(s))")
    for name in sorted(seen):
        print(f"  \\{name}.VAG;1  <-  {seen[name].relative_to(ROOT_DIR).as_posix()}")
    for mf in shipped_music:
        print(f"  \\{mf.stem.upper()}{mf.suffix.upper()};1  <-  {mf.relative_to(ROOT_DIR).as_posix()}")


if __name__ == "__main__":
    main()
