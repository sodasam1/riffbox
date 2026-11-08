#!/usr/bin/env python3
"""Riffbox backup: a consistent copy of the database plus every original audio file. Standard library only.

    python3 backup.py /var/riffbox /path/to/backup-folder [--keep 14]

  <backup-folder>/db/riffbox-YYYYMMDD-HHMMSS.db   one per run, checked with SQLite's own integrity check;
                                                  only the newest --keep are kept
  <backup-folder>/audio/                          every original audio file, copied once and never deleted
                                                  (audio files never change, so only new ones are copied)
FLAC play copies are not backed up: they can be rebuilt from the originals.
Safe to run while the app is running. The work is done by app/riffbox/backup.py (shared with the web page's
"Back up now" button). To restore: see deploy/PHASE8.md.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _shared import load  # noqa: E402

_mod = load("backup")
backup = _mod.backup


def main(argv=None):
    ap = argparse.ArgumentParser(description="Back up a Riffbox data directory.")
    ap.add_argument("data_dir")
    ap.add_argument("dest")
    ap.add_argument("--keep", type=int, default=14, help="how many database copies to keep (default 14)")
    a = ap.parse_args(argv)
    try:
        target, copied, problems = backup(a.data_dir, a.dest, max(1, a.keep))
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print(f"database -> {target.name}; {copied} new audio file(s) copied")
    for p in problems:
        print("WARNING:", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
