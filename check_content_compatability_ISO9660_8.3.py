# root/check_content_compatability_ISO9660_8.3.py
#
# Audits shippable content against the ISO9660 8.3 naming scheme the disc
# pipeline requires (see iso.xml.template's own comment: max 8 chars for
# the name, 3 for the extension; our pipeline further restricts names to
# A-Z 0-9 _ after uppercasing, matching py_convert_stages.py's
# sample_to_cd_path() and py_convert_sounds.py).
#
# What it checks: every file under the scanned roots whose extension is a
# type that actually ships on the disc (.vag / .vab / .seq today). Tool-
# side companions (.wav, .mid, .OstSong, .VagConfig, ...) never ship, so
# they're ignored rather than punished. assets/sound/instruments/ is
# skipped entirely - its waveforms reach the disc inside the compiled VAB,
# never as standalone files (same exclusion py_convert_sounds.py applies).
#
# Also flags DISC-NAME COLLISIONS: the disc root is flat, so two shippable
# files that uppercase to the same NAME.EXT would silently fight for one
# slot - reported as violations on both.
#
# Usage:
#   python check_content_compatability_ISO9660_8.3.py            # scan assets/sound
#   python check_content_compatability_ISO9660_8.3.py <dir> ...  # scan custom roots
#   python check_content_compatability_ISO9660_8.3.py --all      # also list compliant files
#
# Output: one WARNING line per violation, a compliance summary with a
# success percentage, and exit code 0 when fully compliant / 1 otherwise
# (so this can gate CI or a pre-build step later if wanted).

import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent

# Extensions that ship on the disc as standalone root files.
SHIPPABLE_EXTS = {".vag", ".vab", ".seq"}

# Folders (relative names, matched anywhere in the path under a scanned
# root) whose contents never ship as standalone files.
EXCLUDED_DIRS = {"instruments"}

# 8.3 as our pipeline enforces it: NAME 1-8 of A-Z 0-9 _ (validated after
# uppercasing, since the disc is case-insensitive), EXT 1-3 alphanumeric.
NAME_RE = re.compile(r"^[A-Z0-9_]{1,8}$")
EXT_RE = re.compile(r"^[A-Z0-9]{1,3}$")


def check_file(path):
    """Returns a list of human-readable problems (empty = compliant)."""
    problems = []
    stem = path.stem.upper()
    ext = path.suffix[1:].upper()  # suffix includes the dot

    if not NAME_RE.match(stem):
        if len(stem) > 8:
            problems.append(f"name '{path.stem}' is {len(path.stem)} chars (max 8)")
        else:
            bad = sorted(set(c for c in stem if not re.match(r"[A-Z0-9_]", c)))
            problems.append(f"name '{path.stem}' contains invalid character(s): {' '.join(bad)}")
    if not EXT_RE.match(ext):
        problems.append(f"extension '.{path.suffix[1:]}' is not 1-3 alphanumeric chars")
    return problems


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_all = "--all" in sys.argv[1:]

    roots = [Path(a) for a in args] if args else [ROOT_DIR / "assets" / "sound"]

    checked = []   # (path, problems)
    ignored = 0
    excluded = 0

    for root in roots:
        if not root.exists():
            print(f"WARNING: scan root does not exist: {root}", file=sys.stderr)
            continue
        for p in sorted(root.rglob("*"), key=lambda q: str(q).upper()):
            if not p.is_file():
                continue
            rel_parts = set(p.relative_to(root).parts[:-1])
            if rel_parts & EXCLUDED_DIRS:
                excluded += 1
                continue
            if p.suffix.lower() not in SHIPPABLE_EXTS:
                ignored += 1
                continue
            checked.append((p, check_file(p)))

    # Disc-name collisions across everything checked (flat disc root).
    by_disc_name = {}
    for p, _ in checked:
        by_disc_name.setdefault(f"{p.stem.upper()}.{p.suffix[1:].upper()}", []).append(p)
    for disc_name, paths in by_disc_name.items():
        if len(paths) > 1:
            for p, problems in checked:
                if p in paths:
                    others = [str(q) for q in paths if q != p]
                    problems.append(f"disc-name collision on {disc_name} with: {', '.join(others)}")

    ok = [(p, pr) for p, pr in checked if not pr]
    bad = [(p, pr) for p, pr in checked if pr]

    def rel(p):
        try:
            return p.relative_to(ROOT_DIR).as_posix()
        except ValueError:
            return str(p)

    if show_all:
        for p, _ in ok:
            print(f"[OK]  {rel(p)}  ->  \\{p.stem.upper()}.{p.suffix[1:].upper()};1")

    for p, problems in bad:
        for problem in problems:
            print(f"WARNING: [BAD] {rel(p)}: {problem}", file=sys.stderr)

    total = len(checked)
    print()
    print("ISO9660 8.3 content compatibility")
    print(f"  scanned roots : {', '.join(rel(r) if r.is_absolute() else str(r) for r in roots)}")
    print(f"  checked       : {total} shippable file(s) ({', '.join(sorted(SHIPPABLE_EXTS))})")
    print(f"  ignored       : {ignored} non-shippable file(s), {excluded} in excluded folder(s) ({', '.join(sorted(EXCLUDED_DIRS))})")
    print(f"  compliant     : {len(ok)}")
    print(f"  violations    : {len(bad)}")

    if total == 0:
        print("  success       : n/a (nothing to check)")
        return 0

    pct = (len(ok) * 100.0) / total
    print(f"  success       : {pct:.1f}%")

    if bad:
        print()
        print("Fix: rename to 8 chars max, A-Z 0-9 _ only (e.g. Something_is_amiss.vab -> AMISS.vab).")
        print("Renamed samples are picked up automatically by py_convert_sounds.py on the next configure.")

    return 1 if bad else 0


if __name__ == "__main__":
    code = main()
    conclude_def = "success" if code == 0 else "fail" 
    conclude = f"Code: {code} ({conclude_def})"
    input(f"\n{conclude}")
    sys.exit(code)
