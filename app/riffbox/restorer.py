"""Restore: rebuild a Riffbox data directory from an export bundle (the zip from the Backup and export page, or the
folder `deploy/export.py` makes). Standard library only, no Flask.

The export names audio files readably ("2026-03-01 Title [12].m4a", where 12 is the recording's id) while the app stores them
under random names listed in the database copy that comes in the same bundle. This puts each file back under its stored name,
checks it against the checksum recorded at upload, and copies the database. FLAC play copies are not in an export, so they are
marked for rebuilding (the app makes them again at start-up when `ffmpeg` is installed).
"""
import hashlib
import re
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path

ID_IN_NAME = re.compile(r"\[(\d+)\]\.[^./\\]+$")


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_bundle_root(folder):
    """The folder that holds riffbox.db: the export itself, or the single folder inside an unzipped bundle."""
    folder = Path(folder)
    if (folder / "riffbox.db").is_file():
        return folder
    for child in folder.iterdir():
        if child.is_dir() and (child / "riffbox.db").is_file():
            return child
    raise ValueError(f"no riffbox.db found in {folder}: this does not look like a Riffbox export")


def restore(source, data_dir, drop_missing_trash=False):
    """Rebuild `data_dir` (which must be new or empty) from `source` (an export folder or .zip).
    Returns a report: {"restored": n, "missing": [...], "damaged": [...], "dropped": n}."""
    source, data_dir = Path(source), Path(data_dir)
    if data_dir.exists() and any(data_dir.iterdir()):
        raise ValueError(f"{data_dir} already has files in it; restore into a new, empty folder")
    scratch = None
    try:
        if source.is_file() and source.suffix.lower() == ".zip":
            scratch = Path(tempfile.mkdtemp(prefix="riffbox-restore-"))
            with zipfile.ZipFile(source) as z:
                z.extractall(scratch)
            root = _find_bundle_root(scratch)
        else:
            root = _find_bundle_root(source)
        (data_dir / "audio").mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / "riffbox.db", data_dir / "riffbox.db")
        conn = sqlite3.connect(data_dir / "riffbox.db")
        conn.row_factory = sqlite3.Row
        by_id = {}
        for p in (root / "recordings").glob("*"):
            m = ID_IN_NAME.search(p.name)
            if m and p.suffix.lower() != ".md":
                by_id[int(m.group(1))] = p
        report = {"restored": 0, "missing": [], "damaged": [], "dropped": 0}
        drop = []
        for r in conn.execute("SELECT id, title, filename, sha256, deleted_at FROM recordings ORDER BY id").fetchall():
            src = by_id.get(r["id"])
            if src is None:
                report["missing"].append(f"recording {r['id']} ({r['title']}){' [in the Trash]' if r['deleted_at'] else ''}: no audio file in the export")
                if r["deleted_at"] and drop_missing_trash:
                    drop.append(r["id"])
                continue
            if not r["filename"] or Path(r["filename"]).name != r["filename"]:          # a file name, never a path
                report["damaged"].append(f"recording {r['id']} ({r['title']}): its file name in the database is not a plain name, skipped")
                continue
            dest = data_dir / "audio" / r["filename"]
            shutil.copy2(src, dest)
            if _sha256(dest) != r["sha256"]:
                report["damaged"].append(f"recording {r['id']} ({r['title']}): the file does not match its recorded checksum")
            report["restored"] += 1
        for rid in drop:
            conn.execute("DELETE FROM recordings WHERE id = ?", (rid,))
            conn.execute("DELETE FROM recording_tags WHERE recording_id = ?", (rid,))
        if drop:                      # an idea left with no recordings goes too
            conn.execute("DELETE FROM group_tags WHERE group_id NOT IN (SELECT group_id FROM recordings WHERE group_id IS NOT NULL)")
            conn.execute("DELETE FROM idea_groups WHERE id NOT IN (SELECT group_id FROM recordings WHERE group_id IS NOT NULL)")
        report["dropped"] = len(drop)
        # play copies are not in an export: let the app rebuild them
        conn.execute("UPDATE recordings SET play_status = NULL, play_filename = NULL, play_error = NULL WHERE play_filename IS NOT NULL")
        conn.commit()
        conn.close()
        return report
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
