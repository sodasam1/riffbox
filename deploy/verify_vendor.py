#!/usr/bin/env python3
"""Check that the vendored copy of Flask, waitress and their helpers (the vendor/ folder) is exactly what was recorded.

    python3 deploy/verify_vendor.py            # check
    python3 deploy/verify_vendor.py --write    # record the current files (after deliberately updating vendor/)

Standard library only. The record is vendor/MANIFEST-sha256.txt: one line per file, "<sha256>  <path>", paths relative to vendor/.
Exit status 0 if every file matches and none is missing or extra.
"""
import hashlib
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "vendor"
MANIFEST = VENDOR / "MANIFEST-sha256.txt"


def files():
    return sorted(p for p in VENDOR.rglob("*") if p.is_file() and p != MANIFEST and "__pycache__" not in p.parts and p.suffix != ".pyc")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def current():
    return {p.relative_to(VENDOR).as_posix(): digest(p) for p in files()}


def main(argv):
    if "--write" in argv:
        MANIFEST.write_text("".join(f"{h}  {name}\n" for name, h in sorted(current().items())), newline="\n")
        print(f"recorded {len(current())} files in {MANIFEST}")
        return 0
    if not MANIFEST.is_file():
        print("vendor/MANIFEST-sha256.txt is missing")
        return 1
    recorded = dict(line.split("  ", 1)[::-1] for line in MANIFEST.read_text().splitlines() if line.strip())
    now = current()
    problems = [f"changed: {n}" for n in sorted(recorded) if n in now and now[n] != recorded[n]]
    problems += [f"missing: {n}" for n in sorted(set(recorded) - set(now))]
    problems += [f"not recorded: {n}" for n in sorted(set(now) - set(recorded))]
    for line in problems:
        print(line)
    print("vendor/ matches its record" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
