#!/usr/bin/env python3
"""Riffbox restore: rebuild a data directory from an export bundle. Standard library only; never imports the app.

    python3 restore.py /path/to/riffbox-export-20261110.zip /path/to/new-data-folder [--drop-missing-trash]

Accepts the zip from the "Backup and export" page or the folder deploy/export.py writes. The new folder gets riffbox.db and
audio/ (each file under the name the database expects, checked against its recorded checksum). Then start the app with
RIFFBOX_DATA_DIR pointing at it (see the README's "Run locally"). Recordings that were in the Trash when the export was made
are missing from an export made without "Include recordings in the Trash"; they are reported, and --drop-missing-trash removes
those rows instead of leaving entries with no audio. The secrets in /etc/riffbox.conf are not part of an export.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _shared import load  # noqa: E402

restore = load("restorer").restore


def main(argv=None):
    ap = argparse.ArgumentParser(description="Rebuild a Riffbox data directory from an export bundle.")
    ap.add_argument("source", help="the export zip, or the export folder")
    ap.add_argument("data_dir", help="a new, empty folder")
    ap.add_argument("--drop-missing-trash", action="store_true", help="delete Trash entries whose audio is not in the export")
    a = ap.parse_args(argv)
    try:
        report = restore(a.source, a.data_dir, a.drop_missing_trash)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    print(f"restored {report['restored']} audio file(s) into {a.data_dir}")
    if report["dropped"]:
        print(f"removed {report['dropped']} Trash entr{'y' if report['dropped'] == 1 else 'ies'} with no audio")
    for line in report["missing"]:
        print("WARNING:", line, file=sys.stderr)
    for line in report["damaged"]:
        print("WARNING:", line, file=sys.stderr)
    return 1 if report["damaged"] or (report["missing"] and not a.drop_missing_trash and any("[in the Trash]" not in m for m in report["missing"])) else 0


if __name__ == "__main__":
    sys.exit(main())
