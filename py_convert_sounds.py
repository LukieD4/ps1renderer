# root/py_convert_sounds.py
#
# Generates iso.xml from iso.xml.template by expanding the
# "@SOUND_VAG_FILES@" placeholder into one <file> entry per discovered
# assets/sound/**/*.vag - so dropping a new sample into assets/sound/ is
# all it takes to ship it on the disc (no more hand-editing iso.xml and
# forgetting, which shows up at runtime as SFX UNRES on the debug
# overlay).
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
    print(f"Generated: {OUTPUT_PATH} ({len(entries)} sound file(s), {len(music_entries)} music file(s))")
    for name in sorted(seen):
        print(f"  \\{name}.VAG;1  <-  {seen[name].relative_to(ROOT_DIR).as_posix()}")
    for mf in shipped_music:
        print(f"  \\{mf.stem.upper()}{mf.suffix.upper()};1  <-  {mf.relative_to(ROOT_DIR).as_posix()}")


if __name__ == "__main__":
    main()
