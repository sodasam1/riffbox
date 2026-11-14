"""Restore: rebuild a Riffbox data directory from an export bundle (the zip from the Backup and export page, or the
folder `deploy/export.py` makes). Standard library only, no Flask.

The export names audio files readably ("2026-03-01 Title [12].m4a", where 12 is the recording's id) while the app stores them
under random names listed in the database copy that comes in the same bundle. This puts each file back under its stored name,
checks it against the checksum recorded at upload, and copies the database. FLAC play copies are not in an export, so they are
marked for rebuilding (the app makes them again at start-up when `ffmpeg` is installed).
"""
import datetime as dt
import hashlib
import re
import shutil
import sqlite3
import tempfile
import threading
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


# ---- restoring into the running app (the "Restoring" section of the Backup and export page) ---------------------------------
# The folder is one the owner uploaded (with the same sync tool used for the site) to a drop folder on the server. Three kinds are
# recognised, so any copy of the library the app ever made can come back:
#   backup  <folder>/db/riffbox-*.db  and  <folder>/audio/      (what backup.py and "Back up now" write)
#   export  <folder>/riffbox.db  and  <folder>/recordings/      (an unzipped website export)
#   zip     one riffbox-export-*.zip in the folder             (the website export as downloaded)
# The folder itself, or the one folder inside it, may be the bundle. Nothing in the source folder is ever changed or deleted.


def _roots(folder):
    folder = Path(folder)
    yield folder
    try:
        for child in sorted(folder.iterdir()):
            if child.is_dir():
                yield child
    except OSError:
        return


def _count(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
    finally:
        conn.close()


def inspect_source(folder):
    """What is in the drop folder: {"layout", "path", "db", "recordings"} or None if there is nothing usable."""
    folder = Path(folder)
    if not folder.is_dir():
        return None
    for root in _roots(folder):
        dbs = sorted((root / "db").glob("riffbox-*.db")) if (root / "db").is_dir() else []
        try:
            if dbs and (root / "audio").is_dir():
                return {"layout": "backup", "path": root, "db": dbs[-1], "recordings": _count(dbs[-1])}
            if (root / "riffbox.db").is_file() and (root / "recordings").is_dir():
                return {"layout": "export", "path": root, "db": root / "riffbox.db", "recordings": _count(root / "riffbox.db")}
        except sqlite3.Error:
            continue                                   # a damaged or unrelated database: not usable
    zips = sorted(folder.glob("*.zip"))
    if len(zips) == 1:
        try:
            with zipfile.ZipFile(zips[0]) as z:
                if any(n.endswith("riffbox.db") for n in z.namelist()):
                    return {"layout": "zip", "path": zips[0], "db": None, "recordings": None}
        except zipfile.BadZipFile:
            pass
    return None


def restore_into_live(folder, data_dir, live_conn, migrate, scratch):
    """Put the library found in `folder` into the running app, which must have an EMPTY library.
    Order matters: (1) work out of sight in `scratch`; (2) copy audio into the live audio folder (never overwriting a file already there);
    (3) only then replace the live database. If anything fails before step 3 the library is still empty and the run can simply be repeated.
    Returns {"layout", "restored", "missing": [...], "damaged": [...]}."""
    info = inspect_source(folder)
    if info is None:
        raise ValueError(f"no backup or export found in {folder}")
    if live_conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]:
        raise ValueError("the library already has recordings: restoring only works into an empty library")
    data_dir, scratch = Path(data_dir), Path(scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="restore-", dir=scratch))
    live_audio = data_dir / "audio"
    live_audio.mkdir(parents=True, exist_ok=True)
    try:
        report = {"layout": info["layout"], "restored": 0, "missing": [], "damaged": []}
        if info["layout"] == "backup":
            db_path, audio_src = stage / "riffbox.db", info["path"] / "audio"
            shutil.copy2(info["db"], db_path)
        else:                                          # export folder or zip: the existing, tested rebuild does the work
            sub = restore(info["path"], stage / "data")
            report["missing"], report["damaged"] = sub["missing"], sub["damaged"]
            db_path, audio_src = stage / "data" / "riffbox.db", stage / "data" / "audio"
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            migrate(conn)                              # a backup made by an older version of the app is brought up to date first
            for r in conn.execute("SELECT id, title, filename, sha256 FROM recordings ORDER BY id").fetchall():
                name = r["filename"]
                if not name or Path(name).name != name:
                    report["damaged"].append(f"recording {r['id']} ({r['title']}): its file name in the database is not a plain name, skipped")
                    continue
                src, dest = audio_src / name, live_audio / name
                if not src.is_file():
                    if info["layout"] == "backup":
                        report["missing"].append(f"recording {r['id']} ({r['title']}): no audio file in the backup")
                    continue                           # (export layout already reported it)
                if not (dest.is_file() and dest.stat().st_size == src.stat().st_size):
                    tmp = dest.with_name(dest.name + ".partial")
                    shutil.copy2(src, tmp)
                    tmp.replace(dest)
                if info["layout"] == "backup" and _sha256(dest) != r["sha256"]:
                    report["damaged"].append(f"recording {r['id']} ({r['title']}): the file does not match its recorded checksum")
                report["restored"] += 1
            conn.execute("UPDATE recordings SET play_status = NULL, play_filename = NULL, play_error = NULL WHERE play_filename IS NOT NULL")
            conn.commit()
            conn.backup(live_conn)                     # step 3: the live database becomes the restored one (SQLite's own online copy)
        finally:
            conn.close()
        return report
    finally:
        shutil.rmtree(stage, ignore_errors=True)


class Runner:
    """Runs one restore at a time on a background thread (a large library takes minutes), for the page's Restore button."""

    def __init__(self, folder, data_dir, connect, migrate, scratch, after=None):
        self.folder, self.data_dir, self.connect, self.migrate, self.scratch, self.after = folder, data_dir, connect, migrate, scratch, after
        self._lock = threading.Lock()
        self.job = {"running": False, "finished_at": None, "ok": None, "message": "", "missing": [], "damaged": []}

    def status(self):
        """For the page: what is in the folder, and whether the library is empty (the only time restoring is allowed)."""
        conn = self.connect()
        try:
            empty = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0] == 0
        finally:
            conn.close()
        info = inspect_source(self.folder)
        found = None if info is None else {"layout": info["layout"], "recordings": info["recordings"],
                                           "name": info["path"].name if info["layout"] == "zip" else (info["db"].name if info["db"] else "")}
        return {"folder": str(self.folder), "found": found, "library_empty": empty, "job": self.job}

    def start(self):
        """(True, "") if started; (False, reason) if not."""
        with self._lock:
            if self.job["running"]:
                return False, "a restore is already running"
            st = self.status()
            if not st["library_empty"]:
                return False, "the library already has recordings: restoring only works into an empty library"
            if not st["found"]:
                return False, f"no backup or export found in {self.folder}"
            self.job = {"running": True, "finished_at": None, "ok": None, "message": "", "missing": [], "damaged": []}
        threading.Thread(target=self._run, name="riffbox-restore", daemon=True).start()
        return True, ""

    def _run(self):
        try:
            conn = self.connect()
            try:
                rep = restore_into_live(self.folder, self.data_dir, conn, self.migrate, self.scratch)
            finally:
                conn.close()
            if self.after:
                self.after()                           # queue waveform measuring and play copies for what came back
            result = {"ok": not (rep["missing"] or rep["damaged"]),
                      "message": f"Restored {rep['restored']} recording(s) from the {rep['layout']} in {self.folder}.",
                      "missing": rep["missing"], "damaged": rep["damaged"]}
        except Exception as exc:                       # shown on the page; never crashes the server
            result = {"ok": False, "message": f"Restore failed: {exc}. The library was not changed; fix the folder and try again.",
                      "missing": [], "damaged": []}
        with self._lock:
            self.job = {"running": False, "finished_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **result}
