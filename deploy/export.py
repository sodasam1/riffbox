#!/usr/bin/env python3
"""Riffbox export: turn the data directory into a folder you can read with nothing but a file manager,
a text editor and a web browser. Standard library only; it never imports the Riffbox app.

    python3 export.py /var/riffbox /path/to/new-export-folder [--include-trash]

Makes, inside the new folder: recordings/ (readable audio names with a .md note beside each), index.html,
index.csv, riffbox.db, manifest-sha256.txt and README.txt (and PROBLEMS.txt only if something was wrong).
The same export is available as a zip download on the app's "Backup and export" page; both come from
app/riffbox/exporter.py. The originals are copied, never changed or removed.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _shared import load  # noqa: E402

_mod = load("exporter")
export_to_folder = _mod.export_to_folder


def main(argv=None):
    ap = argparse.ArgumentParser(description="Export a Riffbox data directory to plain, portable files.")
    ap.add_argument("data_dir")
    ap.add_argument("out_dir", help="a new, empty folder")
    ap.add_argument("--include-trash", action="store_true", help="also export recordings in the Trash")
    a = ap.parse_args(argv)
    try:
        count, problems = export_to_folder(a.data_dir, a.out_dir, a.include_trash)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print(f"exported {count} recordings to {a.out_dir}")
    for p in problems:
        print("WARNING:", p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
