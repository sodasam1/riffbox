"""Backup: a consistent copy of the database plus every original audio file. Standard library only, no Flask.

Used by deploy/backup.py (command line, e.g. from cron) and by the "Backup and export" page's button.

  <backup folder>/db/riffbox-YYYYMMDD-HHMMSS.db   one per run, checked with SQLite's own integrity test;
                                                  only the newest `keep` are kept
  <backup folder>/audio/                          every original audio file, copied once and never deleted
FLAC play copies are not backed up: they can be rebuilt from the originals.
"""
import datetime as dt
import shutil
import sqlite3
import threading
from pathlib import Path


def backup(data_dir, dest, keep=14, now=None):
    """Returns (database_copy_path, new_audio_files_copied, problems)."""
    data_dir, dest = Path(data_dir), Path(dest)
    db_file = data_dir / "riffbox.db"
    if not db_file.is_file():
        raise ValueError(f"no riffbox.db in {data_dir}")
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
        raise ValueError(f"database copy failed its integrity check: {check}")
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

    for old in sorted((dest / "db").glob("riffbox-*.db"))[:-max(1, keep)]:
        old.unlink()
    for leftover in (dest / "audio").glob("*.partial"):            # from an interrupted run
        leftover.unlink(missing_ok=True)
    return target, copied, problems


def status(data_dir, dest):
    """What the backup folder holds, compared with the live library."""
    data_dir, dest = Path(data_dir), Path(dest)
    copies = sorted((dest / "db").glob("riffbox-*.db")) if (dest / "db").is_dir() else []
    latest = None
    if copies:
        try:
            latest = dt.datetime.strptime(copies[-1].stem, "riffbox-%Y%m%d-%H%M%S").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            latest = None
    conn = sqlite3.connect(data_dir / "riffbox.db")
    try:
        names = [r[0] for r in conn.execute("SELECT filename FROM recordings")]
    finally:
        conn.close()
    have = {p.name for p in (dest / "audio").iterdir()} if (dest / "audio").is_dir() else set()
    return {
        "copies": len(copies),
        "latest": latest.strftime("%Y-%m-%dT%H:%M:%SZ") if latest else None,
        "audio_total": len(names),
        "audio_missing": sum(1 for n in names if n not in have),
    }


class Runner:
    """Runs one backup at a time on a background thread, for the page's "Back up now" button."""

    def __init__(self, data_dir, dest, keep=14):
        self.data_dir, self.dest, self.keep = data_dir, dest, keep
        self._lock = threading.Lock()
        self.job = {"running": False, "finished_at": None, "ok": None, "message": "", "problems": []}

    def start(self):
        """True if a backup was started, False if one is already running."""
        with self._lock:
            if self.job["running"]:
                return False
            self.job = {"running": True, "finished_at": None, "ok": None, "message": "", "problems": []}
        threading.Thread(target=self._run, name="riffbox-backup", daemon=True).start()
        return True

    def _run(self):
        try:
            target, copied, problems = backup(self.data_dir, self.dest, self.keep)
            result = {"ok": not problems, "message": f"Saved {target.name}; {copied} new audio file(s) copied.",
                      "problems": problems}
        except Exception as exc:                      # shown on the page; never crashes the server
            result = {"ok": False, "message": f"Backup failed: {exc}", "problems": []}
        with self._lock:
            self.job = {"running": False, "finished_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        **result}
