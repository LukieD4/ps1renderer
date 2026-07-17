#!/usr/bin/env python3
"""Recursively convert MP3 files to WAV, in-place.

Starts in the current working directory, scans all descendant folders,
converts each .mp3 to a .wav sitting next to it, then removes the original
.mp3 on success.

Requires ffmpeg on PATH (https://ffmpeg.org/download.html).
Tested on Python 3.12.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def find_mp3s(root: Path) -> list[Path]:
    """Return every .mp3 (case-insensitive) below root."""
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".mp3")


def convert_one(src: Path, *, keep: bool, overwrite: bool) -> tuple[Path, bool, str]:
    """Convert a single mp3 to wav. Returns (path, success, message)."""
    dst = src.with_suffix(".wav")

    if dst.exists() and not overwrite:
        return src, False, f"skipped, {dst.name} already exists"

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y" if overwrite else "-n",
        "-i", str(src),
        str(dst),
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        return src, False, "ffmpeg not found on PATH"

    if proc.returncode != 0:
        # Clean up a partial/empty output so we never leave a broken .wav behind.
        if dst.exists() and dst.stat().st_size == 0:
            dst.unlink(missing_ok=True)
        err = proc.stderr.strip().splitlines()
        return src, False, err[-1] if err else "ffmpeg failed"

    if not keep:
        src.unlink(missing_ok=True)

    return src, True, f"-> {dst.name}" + ("" if keep else " (original removed)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", nargs="?", default=".",
                        help="directory to start from (default: current dir)")
    parser.add_argument("--keep", action="store_true",
                        help="keep the original .mp3 files instead of deleting them")
    parser.add_argument("--overwrite", action="store_true",
                        help="overwrite existing .wav files")
    parser.add_argument("--dry-run", action="store_true",
                        help="list what would be converted, then exit")
    parser.add_argument("-j", "--jobs", type=int, default=1,
                        help="number of parallel conversions (default: 1)")
    args = parser.parse_args()

    if shutil.which("ffmpeg") is None:
        print("Error: ffmpeg is required but was not found on PATH.", file=sys.stderr)
        return 2

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"Error: {root} is not a directory.", file=sys.stderr)
        return 2

    mp3s = find_mp3s(root)
    if not mp3s:
        print(f"No .mp3 files found under {root}")
        return 0

    print(f"Found {len(mp3s)} mp3 file(s) under {root}")

    if args.dry_run:
        for p in mp3s:
            print(f"  would convert: {p.relative_to(root)} -> {p.with_suffix('.wav').name}")
        return 0

    ok = failed = 0
    jobs = max(1, args.jobs)

    def report(src: Path, success: bool, msg: str) -> None:
        nonlocal ok, failed
        rel = src.relative_to(root)
        if success:
            ok += 1
            print(f"  [ok]   {rel} {msg}")
        else:
            failed += 1
            print(f"  [FAIL] {rel}: {msg}", file=sys.stderr)

    if jobs == 1:
        for src in mp3s:
            report(*convert_one(src, keep=args.keep, overwrite=args.overwrite))
    else:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {
                pool.submit(convert_one, src, keep=args.keep, overwrite=args.overwrite): src
                for src in mp3s
            }
            for fut in as_completed(futures):
                report(*fut.result())

    print(f"\nDone: {ok} converted, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())