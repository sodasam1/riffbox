#!/usr/bin/env python3
"""Riffbox backup: a consistent copy of the database plus every original audio file. Standard library only.

    python3 backup.py /var/riffbox /path/to/backup-folder [--keep 14]

  <backup-folder>/db/riffbox-YYYYMMDD-HHMMSS.db   one per run, checked with SQLite's own integrity check;
                                                  only the newest --keep are kept
  <backup-folder>/audio/                          every original audio file, copied once and never deleted
                                                  (audio files never change, so only new ones are copied)
FLAC play copies are not backed up: they can be rebuilt from the originals.
Safe to run while the app is running. To restore: copy a db file to <data>/riffbox.db and the audio folder
to <data>/audio/, then start the app. See deploy/PHASE8.md.
"""
import argparse
import datetime as dt
import shutil
import sqlite3
import sys
from pathlib import Path


def backup(data_dir, dest, keep=14, now=None):
    data_dir, dest = Path(data_dir), Path(dest)
    db_file = data_dir / "riffbox.db"
    if not db_file.is_file():
        raise SystemExit(f"no riffbox.db in {data_dir}")
    (dest / "db").mkdir(parents=True, exist_ok=True)
    (dest / "audio").mkdir(parents=True, exist_ok=True)
    stamp = (now or dt.datetime.now(dt.timezone.utc)).strftime("%Y%m%d-%H%M%S")
    target = dest / "db" / f"riffbox-{stamp}.db"
    partial = target.with_name(target.name + ".partial")
    src, snap = sqlite3.connect(db_file), sqlite3.connect(partial)
    try:
        src.backup(snap)
        check = snap.execute("PRAGMA integrity_check").fetchone()[0]
        names = [r[0] for r in snap.execute("SELECT filename FROM recordings")]
    finally:
        snap.close()
        src.close()
    if check != "ok":
        partial.unlink(missing_ok=True)
        raise SystemExit(f"database copy failed its integrity check: {check}")
    partial.replace(target)

    copied, problems = 0, []
    for name in names:
        source, copy = data_dir / "audio" / name, dest / "audio" / name
        if not source.is_file():
            problems.append(f"audio file missing in the data folder: {name}")
            continue
        if copy.is_file() and copy.stat().st_size == source.stat().st_size:
            continue
        tmp = copy.with_name(copy.name + ".partial")
        shutil.copy2(source, tmp)
        tmp.replace(copy)
        copied += 1

    for old in sorted((dest / "db").glob("riffbox-*.db"))[:-keep]:
        old.unlink()
    return target, copied, problems


def main(argv=None):
    ap = argparse.ArgumentParser(description="Back up a Riffbox data directory.")
    ap.add_argument("data_dir")
    ap.add_argument("dest")
    ap.add_argument("--keep", type=int, default=14, help="how many database copies to keep (default 14)")
    a = ap.parse_args(argv)
    target, copied, problems = backup(a.data_dir, a.dest, max(1, a.keep))
    print(f"database -> {target.name}; {copied} new audio file(s) copied")
    for p in problems:
        print("WARNING:", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
