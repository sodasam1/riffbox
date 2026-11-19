#!/usr/bin/env python3
"""Practice restore: put a backup (or an export) into a brand-new EMPTY library on THIS computer, through the app's own restore code,
then check the result against the source. Run it on your own computer, never on the server.

    python deploy/practice_restore.py C:\\path\\to\\backup-folder            restore, then check everything, then clean up
    python deploy/practice_restore.py C:\\path\\to\\backup-folder --serve    also start the app so you can look at it in a browser
    options: --port 8765 (with --serve), --keep (do not delete the practice library afterwards)

The folder is what you pulled from /mnt/data/apps/riffbox/backup (it holds db/ and audio/), an unzipped export, or a folder holding one export zip.
Nothing in it is changed. The practice library lives in a temporary folder and is deleted afterwards. Needs Python with Flask installed
(`pip install flask waitress`). Exit code 0 = every check passed, 1 = a check failed, 2 = nothing usable in the folder.
The checks: the restore reports no missing or damaged audio; every recording's audio file matches its recorded checksum; and, for a backup or an
unzipped export, the restored database has the same rows (titles, tags, notes, marks, tempo, key, dates, Trash) as the source.
"""
import argparse
import hashlib
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True          # no __pycache__ next to the source (see deploy/INSTALL.md)
APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))

TABLES = ("recordings", "idea_groups", "tags", "recording_tags", "group_tags")
SKIP_COLUMNS = {"play_status", "play_filename", "play_error"}      # play copies are rebuilt, not restored


def _ro(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro&immutable=1", uri=True)       # immutable: leave no -wal/-shm files behind
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def compare_databases(src_path, dst_path):
    """Returns a list of problems (empty = the restored database holds the same information as the source)."""
    problems = []
    src, dst = _ro(src_path), _ro(dst_path)
    try:
        for table in TABLES:
            sc, dc = _columns(src, table), _columns(dst, table)
            if not sc:
                continue                                           # an older source without this table (groups came later)
            cols = [c for c in sc if c in dc and c not in SKIP_COLUMNS]
            order = "id" if "id" in cols else ", ".join(cols)
            q = f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}"
            a = [tuple(r) for r in src.execute(q)]
            b = [tuple(r) for r in dst.execute(q)]
            if len(a) != len(b):
                problems.append(f"{table}: {len(a)} rows in the source, {len(b)} after the restore")
            elif a != b:
                bad = next(i for i, (x, y) in enumerate(zip(a, b)) if x != y)
                problems.append(f"{table}: row {bad + 1} differs between the source and the restored copy")
    finally:
        src.close()
        dst.close()
    return problems


def check_audio(data_dir, db_path):
    """Every recording in the restored database has its audio file, and it matches the recorded checksum."""
    problems, n = [], 0
    conn = _ro(db_path)
    try:
        for r in conn.execute("SELECT id, title, filename, sha256 FROM recordings ORDER BY id"):
            n += 1
            path = Path(data_dir) / "audio" / r["filename"]
            if not path.is_file():
                problems.append(f"recording {r['id']} ({r['title']}): audio file missing")
                continue
            h = hashlib.sha256()
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != r["sha256"]:
                problems.append(f"recording {r['id']} ({r['title']}): audio does not match its checksum")
    finally:
        conn.close()
    return n, problems


def main(argv=None):
    ap = argparse.ArgumentParser(description="Practice a restore on this computer.")
    ap.add_argument("source", help="the backup folder, an unzipped export, or a folder holding one export zip")
    ap.add_argument("--serve", action="store_true", help="start the app on the restored library so you can look at it")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--keep", action="store_true", help="do not delete the practice library afterwards")
    a = ap.parse_args(argv)
    try:
        import riffbox
        from riffbox import restorer
    except ImportError as exc:
        print(f"Flask is needed: pip install flask waitress  ({exc})", file=sys.stderr)
        return 2
    source = Path(a.source)
    info = restorer.inspect_source(source)
    if info is None:
        print(f"Nothing usable in {source}: expected db/ and audio/ (a backup), or riffbox.db and recordings/ (an export), or one export zip.")
        return 2
    print(f"Found a {info['layout']}" + (f" with {info['recordings']} recordings" if info["recordings"] is not None else "") + f" in {source}")
    tmp = Path(tempfile.mkdtemp(prefix="riffbox-practice-"))
    old_tempdir = tempfile.tempdir
    data = tmp / "data"
    app = riffbox.create_app({"TESTING": True, "DATA_DIR": str(data), "RESTORE_DIR": str(source), "PASSPHRASE": "practice",
                              "SECRET_KEY": "practice", "UPLOAD_TOKEN": "", "FFMPEG": "", "SESSION_COOKIE_SECURE": False})
    client = app.test_client()
    results, ok = [], True

    def record(good, text):
        nonlocal ok
        ok = ok and good
        results.append(("PASS" if good else "FAIL") + ": " + text)

    try:
        client.post("/api/login", json={"passphrase": "practice"})
        r = client.post("/api/restore")
        if r.status_code != 202:
            print("Could not start the restore:", r.get_json())
            return 1
        started = time.time()
        while True:
            job = client.get("/api/restore").get_json()["job"]
            if not job["running"] and job["finished_at"]:
                break
            time.sleep(0.2)
            if time.time() - started > 6 * 3600:
                print("Gave up waiting after 6 hours.")
                return 1
        print(f"{job['message']}  ({time.time() - started:.1f} s)")
        record(job["ok"], "the restore itself reported no problems")
        for line in job["missing"] + job["damaged"]:
            results.append("      " + line)
        n, bad = check_audio(data, data / "riffbox.db")
        record(not bad, f"all {n} audio files are present and match their checksums")
        results.extend("      " + b for b in bad)
        if info["db"] is not None:
            diffs = compare_databases(info["db"], data / "riffbox.db")
            record(not diffs, "the restored library has the same rows as the source (titles, tags, notes, marks, tempo, key, dates, Trash)")
            results.extend("      " + d for d in diffs)
        else:
            results.append("note: the source is a zip, so the row-by-row comparison was skipped (the audio checks above still ran)")
        d = client.get("/api/data").get_json()
        record(d["recordings"] + d["trashed"] == n, f"the app shows {d['recordings']} recordings and {d['trashed']} in the Trash")
        print("\n".join(results))
        print("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
        if a.serve:
            from waitress import serve
            print(f"\nRiffbox is running on the practice library: http://127.0.0.1:{a.port}/  (passphrase: practice).  Press Ctrl+C to stop.")
            app.config["SESSION_COOKIE_SECURE"] = False
            try:
                serve(app, host="127.0.0.1", port=a.port)
            except KeyboardInterrupt:
                pass
        return 0 if ok else 1
    finally:
        app.extensions["riffbox"].stop()
        tempfile.tempdir = old_tempdir          # create_app points the process-wide temp folder at the library, which is about to be deleted
        if a.keep:
            print(f"Practice library kept in {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
