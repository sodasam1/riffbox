"""Riffbox: a tiny single-user vault for musical voice-memo ideas.

Phase 1 core: upload (deduped by sha256), range-capable audio streaming,
passphrase/cookie login, and a bare recordings list.
"""
import datetime as dt
import hashlib
import hmac
import io
import json
import mimetypes
import os
import queue
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import urllib.parse
import uuid
from functools import wraps
from pathlib import Path
from types import SimpleNamespace

from flask import (
    Blueprint,
    Flask,
    Response,
    abort,
    g,
    jsonify,
    redirect,
    request,
    send_file,
    send_from_directory,
    session,
)

from . import backup as backups
from . import exporter, groups, webcache
from .health import collect as collect_health
from .intake import (
    MAX_BULK,
    MAX_TAGS_PER_RECORDING,
    MAX_TAGS_TOTAL,
    MAX_TITLE,
    Invalid,
    normalize_tag,
    validate_bulk,
    validate_patch,
)
from .library import build_query, parse_filters
from .media import (
    INPUT_FORMAT,
    analyze_audio,
    convert_to_flac,
    mp4_audio_codec,
    sniff_audio_ext,
)
from .throttle import (  # noqa: F401  (re-exported for the tests)
    LOGIN_GLOBAL_MAX,
    LOGIN_PER_CLIENT_MAX,
    LOGIN_WINDOW,
    LoginThrottle,
)

ALLOWED_EXT = {
    ".m4a", ".mp3", ".wav", ".aac", ".caf", ".aif", ".aiff", ".ogg", ".flac", ".mp4",
}
FALLBACK_MIME = {".m4a": "audio/mp4", ".caf": "audio/x-caf", ".aac": "audio/aac"}
MP4_EXT = (".m4a", ".mp4")        # containers whose audio codec we can read
NEW_COLUMNS = ("codec", "play_status", "play_filename", "play_error")


def disk_usage(path):
    """(total, free) bytes of the disk holding `path`. Module-level so tests can pretend the disk is full."""
    usage = shutil.disk_usage(path)
    return usage.total, usage.free


def default_ffmpeg():
    return (os.environ.get("RIFFBOX_FFMPEG") or shutil.which("ffmpeg")
            or ("/usr/local/bin/ffmpeg" if os.access("/usr/local/bin/ffmpeg", os.X_OK) else ""))

SCHEMA = Path(__file__).with_name("schema.sql")
ABOUT = Path(__file__).with_name("about.html")        # the private "How this works" page

# Login throttling: after PER_CLIENT_MAX wrong passphrases from one client (or GLOBAL_MAX from
# anyone) inside WINDOW seconds, logins get HTTP 429 until the oldest failure ages out.
LOOPBACK = ("127.0.0.1", "::1")


def _now():
    # Module-level so tests can replace the clock.
    return time.monotonic()


def utcnow_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value):
    """Return a normalized UTC ISO string, or None if value is unusable."""
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    try:
        return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OverflowError:         # e.g. year 1 with a positive offset: not representable in UTC
        return None


def default_title(iso):
    # Built by hand: avoids platform differences in strftime flags like %-d.
    t = dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")
    hour12 = t.hour % 12 or 12
    ampm = "am" if t.hour < 12 else "pm"
    return f"Idea, {t.strftime('%b')} {t.day} {hour12}:{t.minute:02d}{ampm}"


def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATA_DIR=os.environ.get("RIFFBOX_DATA_DIR", "/var/riffbox"),
        UPLOAD_TOKEN=os.environ.get("RIFFBOX_UPLOAD_TOKEN", ""),
        PASSPHRASE=os.environ.get("RIFFBOX_PASSPHRASE", ""),
        SECRET_KEY=os.environ.get("RIFFBOX_SECRET", ""),
        MAX_CONTENT_LENGTH=300 * 1024 * 1024,
        # URL prefix the app is served under, e.g. "/ideas" ("" at the root, for dev/tests).
        BASE_PATH=os.environ.get("RIFFBOX_BASE_PATH", ""),
        # ffmpeg is optional: without it ALAC memos still upload and download, they just have no
        # browser-friendly FLAC play copy.
        FFMPEG=default_ffmpeg(),
        CONVERT_TIMEOUT=900,
        # Where the "Back up now" button writes (and the nightly script, if you use it). Empty = the button is off.
        BACKUP_DIR=os.environ.get("RIFFBOX_BACKUP_DIR", ""),
        STATIC_DIR=os.environ.get("RIFFBOX_STATIC_DIR", str(Path(__file__).resolve().parents[2] / "static")),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # Set RIFFBOX_INSECURE_COOKIES=1 only for local http testing.
        SESSION_COOKIE_SECURE=os.environ.get("RIFFBOX_INSECURE_COOKIES") != "1",
        PERMANENT_SESSION_LIFETIME=dt.timedelta(days=60),
    )
    if config:
        app.config.update(config)
    if not app.config["SECRET_KEY"]:
        raise RuntimeError("RIFFBOX_SECRET must be set")
    base = "/" + app.config["BASE_PATH"].strip("/") if app.config["BASE_PATH"].strip("/") else ""
    app.config["BASE_PATH"] = base
    # Scope the login cookie to our prefix so it is never sent to the rest of the site.
    app.config["SESSION_COOKIE_PATH"] = base or "/"
    bp = Blueprint("riffbox", __name__)

    data_dir = Path(app.config["DATA_DIR"])
    audio_dir = data_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "riffbox.db"
    app.config["AUDIO_DIR"] = audio_dir
    app.config["DB_PATH"] = db_path

    def connect():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # SQLite's own LOWER() only handles A-Z, so searching "été" would miss a title "Été"
        conn.create_function("ulower", 1, lambda v: v.lower() if isinstance(v, str) else v, deterministic=True)
        return conn

    def migrate(conn):
        """Databases created before phase 3.5 lack the playback-copy columns: add them in place."""
        have = {r["name"] for r in conn.execute("PRAGMA table_info(recordings)")}
        for col in NEW_COLUMNS:
            if col not in have:
                conn.execute(f"ALTER TABLE recordings ADD COLUMN {col} TEXT")
        conn.commit()
        groups.migrate(conn)           # every recording belongs to a group (see groups.py)

    # Werkzeug parks big uploads in a temp file while it parses them. Keep that inside the data directory
    # (the disk with room), not the system /tmp, which may be small.
    scratch = data_dir / "tmp"
    scratch.mkdir(exist_ok=True)
    tempfile.tempdir = str(scratch)
    for leftover in scratch.iterdir():
        if leftover.is_dir():                      # an export that was cut off by a restart
            shutil.rmtree(leftover, ignore_errors=True)
        else:
            leftover.unlink(missing_ok=True)
    for stale in audio_dir.glob(".incoming-*"):      # half-written files from a crash or a restart mid-upload
        stale.unlink(missing_ok=True)
    boot = connect()
    try:
        boot.execute("PRAGMA journal_mode = WAL")
        boot.executescript(SCHEMA.read_text())
        migrate(boot)
    finally:
        boot.close()

    def db():
        if "db" not in g:
            g.db = connect()
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    # ---- FLAC play copies (background, one at a time: this is a 1 vCPU / 1 GB server) -----------
    jobs = queue.Queue()

    def run_conversion(rec_id):
        conn = connect()
        try:
            row = conn.execute("SELECT filename FROM recordings WHERE id = ?", (rec_id,)).fetchone()
            if row is None:
                return
            out_name = f"{uuid.uuid4().hex}.flac"
            tmp_out = audio_dir / f".incoming-{out_name}"
            ok, err = convert_to_flac(app.config["FFMPEG"], audio_dir / row["filename"], tmp_out,
                                      app.config["CONVERT_TIMEOUT"])
            if ok:
                os.replace(tmp_out, audio_dir / out_name)
                os.chmod(audio_dir / out_name, 0o640)
                conn.execute("UPDATE recordings SET play_status='ready', play_filename=?, play_error=NULL"
                             " WHERE id=?", (out_name, rec_id))
            else:
                if tmp_out.exists():
                    tmp_out.unlink()
                app.logger.error("riffbox: FLAC conversion failed for recording %s: %s", rec_id, err)
                conn.execute("UPDATE recordings SET play_status='failed', play_error=? WHERE id=?",
                             (err, rec_id))
            conn.commit()
        finally:
            conn.close()

    def run_analysis(rec_id):
        """Work out a recording's length and waveform once, so the player can draw it and the Library
        can sort by length. A failure is remembered (an empty waveform) so it is not retried forever."""
        conn = connect()
        try:
            row = conn.execute("SELECT filename, group_id FROM recordings WHERE id = ?", (rec_id,)).fetchone()
            if row is None:
                return
            ok, duration, peaks, err = analyze_audio(app.config["FFMPEG"], audio_dir / row["filename"],
                                                     app.config["CONVERT_TIMEOUT"])
            if ok:
                conn.execute("UPDATE recordings SET duration_s=?, peaks=? WHERE id=?",
                             (duration, json.dumps(peaks, separators=(",", ":")), rec_id))
                groups.refresh(conn, row["group_id"])             # the idea's length follows its longest part
            else:
                app.logger.error("riffbox: could not analyse recording %s: %s", rec_id, err)
                conn.execute("UPDATE recordings SET peaks='[]' WHERE id=?", (rec_id,))
            conn.commit()
        finally:
            conn.close()

    def worker():
        while True:
            job = jobs.get()
            try:
                if job is None:
                    return
                kind, rec_id = job
                (run_conversion if kind == "convert" else run_analysis)(rec_id)
            except Exception:                      # never let one bad file kill the worker
                app.logger.exception("riffbox: background job crashed: %s", job)
            finally:
                jobs.task_done()

    worker_thread = threading.Thread(target=worker, name="riffbox-convert", daemon=True)
    worker_thread.start()

    def detect_codec(filename):
        if filename.lower().endswith(MP4_EXT):
            return mp4_audio_codec(audio_dir / filename) or "unknown"
        return "n/a"

    def backfill():
        """Examine recordings from before phase 3.5, and (re)queue ALAC ones that need a play copy.
        Runs at start-up, so deploying new code and restarting converts what is already uploaded."""
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT id, filename, codec, play_status FROM recordings WHERE deleted_at IS NULL AND"
                " (codec IS NULL OR (codec = 'alac' AND (play_status IS NULL OR play_status = 'pending')))"
            ).fetchall()
            for r in rows:
                codec = r["codec"] or detect_codec(r["filename"])
                if r["codec"] is None:
                    conn.execute("UPDATE recordings SET codec=? WHERE id=?", (codec, r["id"]))
                if codec == "alac" and app.config["FFMPEG"]:
                    conn.execute("UPDATE recordings SET play_status='pending' WHERE id=?", (r["id"],))
                    conn.commit()
                    jobs.put(("convert", r["id"]))
            conn.commit()
            if app.config["FFMPEG"]:        # recordings that have not been measured yet (older ones, or ffmpeg arrived later)
                for r in conn.execute("SELECT id FROM recordings WHERE deleted_at IS NULL AND peaks IS NULL"):
                    jobs.put(("analyze", r["id"]))
        finally:
            conn.close()

    backfill()

    app.extensions["riffbox"] = SimpleNamespace(
        jobs=jobs,
        stop=lambda: (jobs.put(None), worker_thread.join(timeout=10)),
    )

    # ---- auth ----------------------------------------------------------
    def token_ok():
        expected = app.config["UPLOAD_TOKEN"]
        header = request.headers.get("Authorization", "")
        if not expected or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode(), expected.encode())

    def require_auth(allow_token=False):
        def deco(fn):
            @wraps(fn)
            def wrapper(*a, **kw):
                if session.get("ok") or (allow_token and token_ok()):
                    return fn(*a, **kw)
                return jsonify(error="unauthorized", message="Riffbox: not allowed (wrong or missing token, or logged out)."), 401
            return wrapper
        return deco

    # ---- login throttling (see throttle.py) ---------------------------------------------------------
    throttle = LoginThrottle(lambda: _now())        # looked up on each use, so tests can replace _now

    def client_key():
        """Who is asking. waitress only listens on loopback, so every real connection comes from
        relayd, which *sets* X-Forwarded-For to the true client address (any client-supplied value
        is overwritten). Trust that header only for loopback peers."""
        addr = request.remote_addr or "?"
        if addr in LOOPBACK:
            forwarded = request.headers.get("X-Forwarded-For", "")
            last = forwarded.split(",")[-1].strip()
            if last:
                return last
        return addr

    @bp.post("/api/login")
    def login():
        key = client_key()
        wait = throttle.wait_for(key)
        if wait:
            resp = jsonify(error="too many attempts", retry_after=wait)
            resp.status_code = 429
            resp.headers["Retry-After"] = str(wait)
            return resp
        body = request.get_json(silent=True) or {}
        supplied = str(body.get("passphrase", ""))
        expected = app.config["PASSPHRASE"]
        if expected and hmac.compare_digest(supplied.encode(), expected.encode()):
            throttle.succeeded(key)
            session.clear()
            session.permanent = True
            session["ok"] = True
            return jsonify(ok=True)
        throttle.failed(key)
        return jsonify(error="bad passphrase"), 401

    @bp.get("/api/session")
    @require_auth()
    def session_status():
        return jsonify(ok=True)

    @bp.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    # ---- routes --------------------------------------------------------
    @bp.get("/health")
    def health():
        db().execute("SELECT 1").fetchone()
        return jsonify(status="ok")

    def bad_request(message):
        return jsonify(error=message), 400

    @bp.post("/api/upload")
    @require_auth(allow_token=True)
    def upload():
        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify(error="no file", message="Riffbox: no file was sent."), 400
        orig = os.path.basename(f.filename)
        ext = Path(orig).suffix.lower()
        if ext and ext not in ALLOWED_EXT:
            return jsonify(error=f"unsupported file type {ext}", message=f"Riffbox: unsupported file type {ext}."), 415

        # Stream to a temp file inside the data dir (same filesystem for rename).
        h = hashlib.sha256()
        size = 0
        stored_path = None
        with tempfile.NamedTemporaryFile(dir=audio_dir, prefix=".incoming-", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            try:
                while True:
                    chunk = f.stream.read(1024 * 1024)
                    if not chunk:
                        break
                    h.update(chunk)
                    size += len(chunk)
                    tmp.write(chunk)
            except BaseException:
                tmp_path.unlink(missing_ok=True)       # an upload cut off half way leaves nothing behind
                raise
        try:
            if size == 0:
                return jsonify(error="empty file", message="Riffbox: the file was empty."), 400
            if not ext:                                 # no extension on the name: let the content decide
                with open(tmp_path, "rb") as fh:
                    ext = sniff_audio_ext(fh.read(16))
                if ext is None:
                    return jsonify(error="unsupported file type (none)",
                                   message="Riffbox: that does not look like an audio file."), 415
                orig += ext
            digest = h.hexdigest()
            db().execute("BEGIN IMMEDIATE")      # check-then-insert as one step: two identical uploads at once cannot both pass
            existing = db().execute(
                "SELECT id, title, group_id FROM recordings WHERE sha256 = ? AND deleted_at IS NULL", (digest,)
            ).fetchone()
            if existing:
                db().rollback()
                return jsonify(id=existing["id"], group_id=existing["group_id"], duplicate=True,
                               message=f"Already in Riffbox as \u201c{existing['title']}\u201d."), 200

            now = utcnow_iso()
            recorded_at = parse_iso(request.form.get("recorded_at")) or now
            title = (request.form.get("title") or "").strip()
            if Path(title).suffix.lower() in ALLOWED_EXT:     # a client that sends the file name as the title
                title = title[:-len(Path(title).suffix)].strip()
            title = title or default_title(recorded_at)
            mime = FALLBACK_MIME.get(ext) or mimetypes.guess_type(orig)[0] or "application/octet-stream"
            stored = f"{uuid.uuid4().hex}{ext}"
            os.replace(tmp_path, audio_dir / stored)
            stored_path = audio_dir / stored
            os.chmod(stored_path, 0o640)
            codec = detect_codec(stored)
            needs_copy = codec == "alac" and bool(app.config["FFMPEG"])
            cur = db().execute(
                "INSERT INTO recordings (title, filename, orig_filename, mime, size, sha256,"
                " recorded_at, uploaded_at, codec, play_status) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (title, stored, orig, mime, size, digest, recorded_at, now, codec,
                 "pending" if needs_copy else None),
            )
            gid = groups.create_single(db(), cur.lastrowid, title, recorded_at, now)     # every recording belongs to a group
            db().commit()
            stored_path = None                          # recorded in the database: keep the file
            if needs_copy:
                jobs.put(("convert", cur.lastrowid))   # convert in the background; the upload returns now
            if app.config["FFMPEG"] and ext in INPUT_FORMAT:
                jobs.put(("analyze", cur.lastrowid))   # and measure it (length + waveform)
            return jsonify(id=cur.lastrowid, group_id=gid, duplicate=False, message=f"Uploaded \u201c{title}\u201d to the Riffbox Inbox."), 201
        finally:
            tmp_path.unlink(missing_ok=True)
            if stored_path is not None:                 # the database insert failed: don't leave an orphan file
                stored_path.unlink(missing_ok=True)

    @bp.get("/api/token-check")
    @require_auth(allow_token=True)
    def token_check():
        """For setting up the phone Shortcut: answers 200 when the upload token (or a login) is right."""
        return jsonify(ok=True, message="Riffbox: the upload token works.")

    def group_or_404(gid, live=True):
        row = groups.get(db(), gid, live)
        if row is None:
            abort(404)
        return row

    def one_group(gid):
        return groups.load(db(), [groups.get(db(), gid, live=False)])[0]

    def known_tags():
        return {r["name"] for r in db().execute("SELECT name FROM tags")}

    def guarded(work):
        """Run a change that writes several rows: all of it, or none of it. A refused request answers 409 with a message."""
        conn = db()
        try:
            result = work(conn)
            conn.commit()
            return result
        except groups.Conflict as exc:
            conn.rollback()
            return jsonify(error=str(exc)), 409
        except BaseException:
            conn.rollback()
            raise

    @bp.get("/api/groups")
    @require_auth()      # the upload token is add-only: it must not be able to read the library
    def list_groups():
        """The ideas (groups) matching the filters in the query string (see library.py). `count` is how many
        matched; `total` is how many exist in this status before any filter, for "12 of 40"."""
        try:
            filters = parse_filters(request.args)
        except Invalid as exc:
            return bad_request(str(exc))
        sql, params = build_query(filters)
        rows = db().execute(sql, params).fetchall()
        count_sql, count_params = "SELECT rating, COUNT(*) AS n FROM idea_groups WHERE deleted_at IS NULL", []
        if filters["status"]:
            count_sql += " AND status = ?"
            count_params.append(filters["status"])
        counts = {"heart": 0, "check": 0, "x": 0, "none": 0}      # how many carry each mark, before any filter
        for r in db().execute(count_sql + " GROUP BY rating", count_params):
            counts[r["rating"] or "none"] = r["n"]
        total = sum(counts.values())
        needs = db().execute("SELECT COUNT(*) FROM idea_groups WHERE deleted_at IS NULL AND unresolved IS NOT NULL"
                             + (" AND status = ?" if filters["status"] else ""), [filters["status"]] if filters["status"] else []).fetchone()[0]
        trashed = db().execute("SELECT COUNT(*) FROM idea_groups WHERE deleted_at IS NOT NULL").fetchone()[0]
        return jsonify(groups=groups.load(db(), rows), count=len(rows), total=total, ratings=counts, needs=needs, trashed=trashed)

    def patch_group(gid, body, part_title_for=None):
        """Validate and apply a change request to a group. `part_title_for` is the recording id a legacy request named: for a
        group with several parts its `title` renames that part instead of the group."""
        row = group_or_404(gid)
        if not isinstance(body, dict):
            return bad_request("send a JSON object")
        body = dict(body)
        labels = body.pop("parts", None)
        resolved = body.pop("resolved", [])
        if not isinstance(resolved, list) or any(r not in ("bpm", "key") for r in resolved):
            return bad_request("resolved must be a list of 'bpm' and/or 'key'")
        if part_title_for is not None and row["part_count"] > 1 and "title" in body:
            title = body.pop("title")
            if not isinstance(title, str) or not title.strip() or len(title.strip()) > MAX_TITLE:
                return bad_request(f"a part's title must be text of 1 to {MAX_TITLE} characters")
            db().execute("UPDATE recordings SET title = ? WHERE id = ?", (title.strip(), part_title_for))
        if labels is not None:
            if (not isinstance(labels, list) or any(not isinstance(p, dict) or isinstance(p.get("id"), bool) or not isinstance(p.get("id"), int)
                                                    or not isinstance(p.get("title"), str) or not p["title"].strip()
                                                    or len(p["title"].strip()) > MAX_TITLE for p in labels)):
                return bad_request("parts must be a list of {id, title}")
            labels = [{"id": p["id"], "title": p["title"].strip()} for p in labels]
        try:
            cols, tag_list = validate_patch(body, known_tags(), default_title(row["recorded_at"]), row["uploaded_at"])
        except Invalid as exc:
            return bad_request(str(exc))
        recorded = groups.KEEP
        if "recorded_at" in cols:       # a date typed by hand; blank goes back to the earliest part
            recorded = None if body.get("recorded_at") in (None, "") else cols["recorded_at"]
            del cols["recorded_at"]
        # "used in" names the song a ✓ idea became, so it only belongs to a ✓
        rating_after = cols["rating"] if "rating" in cols else row["rating"]
        if "rating" in cols and rating_after != "check" and "used_in" not in cols:
            cols["used_in"] = None
        if cols.get("used_in") and rating_after != "check":
            return bad_request("'used in' only applies to an idea marked ✓")
        failed = guarded(lambda conn: groups.update(conn, gid, cols, tag_list, recorded, labels, resolved))
        return failed

    @bp.patch("/api/groups/<int:gid>")
    @require_auth()
    def update_group(gid):
        """Change an idea's details. Every field is optional; saving an unchanged or empty form is fine. `status: "tagged"`
        is what moves an idea out of the inbox. `parts: [{id, title}, ...]` renames and reorders the parts."""
        failed = patch_group(gid, request.get_json(silent=True))
        return failed if failed is not None else jsonify(group=one_group(gid))

    @bp.patch("/api/recordings/<int:rec_id>")
    @require_auth()
    def update_recording(rec_id):
        """Older form of the change request, kept for compatibility: it changes the group the recording belongs to."""
        row = groups.group_of_recording(db(), rec_id)
        if row is None:
            abort(404)
        failed = patch_group(row["id"], request.get_json(silent=True), part_title_for=rec_id)
        return failed if failed is not None else jsonify(recording=one_group(row["id"]))

    @bp.post("/api/groups/suggest")
    @require_auth()
    def suggest_group():
        """What a group made from these ideas would start with, and which tempos and keys disagree (for the Group dialog)."""
        ids = (request.get_json(silent=True) or {}).get("ids")
        if not isinstance(ids, list) or not ids or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
            return bad_request("ids must be a list of idea numbers")
        try:
            return jsonify(groups.suggest(db(), list(dict.fromkeys(ids))))
        except groups.Conflict as exc:
            return jsonify(error=str(exc)), 409

    @bp.post("/api/groups")
    @require_auth()
    def create_group():
        """Make one group out of several ideas. Any detail left out is filled in from the ideas (see `suggest`); the ones given
        replace it. Nothing is lost: every recording keeps its own copy of what it had."""
        body = request.get_json(silent=True)
        ids = body.get("ids") if isinstance(body, dict) else None
        if not isinstance(ids, list) or len(ids) < 2 or len(ids) > MAX_BULK or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
            return bad_request(f"ids must be a list of 2 to {MAX_BULK} idea numbers")
        ids = list(dict.fromkeys(ids))
        try:
            start = groups.suggest(db(), ids)
        except groups.Conflict as exc:
            return jsonify(error=str(exc)), 409
        given = {k: v for k, v in body.items() if k in (*groups.GROUP_FIELDS, "tags")}
        fields = {**{k: start.get(k) for k in groups.GROUP_FIELDS}, **given}
        fields["tags"] = given.get("tags", start["tags"])
        try:
            cols, tag_list = validate_patch(fields, known_tags(), start["title"])
        except Invalid as exc:
            return bad_request(str(exc))
        cols.setdefault("title", start["title"])
        if cols.get("used_in") and cols.get("rating") != "check":
            return bad_request("'used in' only applies to an idea marked ✓")
        unresolved = {}                      # tempos or keys the recordings disagree on are kept, to be picked later in Edit
        if "bpm" not in given and start["conflicts"]["bpm"]:
            unresolved["bpm"] = start["conflicts"]["bpm"]
        if "key_root" not in given and "key_mode" not in given and start["conflicts"]["key"]:
            unresolved["key"] = start["conflicts"]["key"]
        made = guarded(lambda conn: groups.combine(conn, ids, cols, tag_list, unresolved or None))
        return made if isinstance(made, tuple) else (jsonify(group=one_group(made)), 201)

    @bp.post("/api/groups/<int:gid>/parts")
    @require_auth()
    def add_parts(gid):
        """Move other ideas into this group (it keeps its own details)."""
        ids = (request.get_json(silent=True) or {}).get("ids")
        if not isinstance(ids, list) or not ids or any(isinstance(i, bool) or not isinstance(i, int) for i in ids):
            return bad_request("ids must be a list of idea numbers")
        done = guarded(lambda conn: groups.add_to(conn, gid, ids))
        return done if isinstance(done, tuple) else jsonify(group=one_group(gid))

    @bp.delete("/api/groups/<int:gid>/parts/<int:rec_id>")
    @require_auth()
    def remove_part(gid, rec_id):
        """Take one recording out of a group: it becomes its own idea again."""
        done = guarded(lambda conn: groups.remove_part(conn, gid, rec_id))
        return done if isinstance(done, tuple) else jsonify(group=one_group(gid), freed=one_group(done))

    @bp.post("/api/groups/<int:gid>/ungroup")
    @require_auth()
    def ungroup(gid):
        done = guarded(lambda conn: groups.ungroup(conn, gid))
        return done if isinstance(done, tuple) else jsonify(groups=[one_group(g) for g in done])

    @bp.post("/api/bulk")
    @require_auth()
    def bulk_update():
        """Change many ideas at once (Select mode). All or nothing: if any idea is missing or a tag limit would be broken,
        nothing changes."""
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return bad_request("send a JSON object")
        try:
            ids, changes = validate_bulk(body, known_tags())
        except Invalid as exc:
            return bad_request(str(exc))
        conn = db()
        marks = ",".join("?" * len(ids))
        found = conn.execute(f"SELECT COUNT(*) FROM idea_groups WHERE deleted_at IS NULL AND id IN ({marks})", ids).fetchone()[0]
        if found != len(ids):
            return bad_request("some of these recordings no longer exist; reload the page")
        if changes.get("add_tags"):
            held = {}
            for r in conn.execute(f"SELECT group_id, tag FROM group_tags WHERE group_id IN ({marks})", ids):
                held.setdefault(r["group_id"], set()).add(r["tag"])
            if any(len(held.get(gid, set()) | set(changes["add_tags"])) > MAX_TAGS_PER_RECORDING for gid in ids):
                return bad_request(f"at most {MAX_TAGS_PER_RECORDING} tags per recording")

        def work(conn):
            if changes.get("trash"):
                groups.trash(conn, ids, utcnow_iso())
            if "rating" in changes:        # "used in" only belongs to a ✓, as with a single change
                clear = "" if changes["rating"] == "check" else ", used_in = NULL"
                conn.execute(f"UPDATE idea_groups SET rating = ?{clear} WHERE id IN ({marks})", [changes["rating"], *ids])
            if "status" in changes:
                conn.execute(f"UPDATE idea_groups SET status = ? WHERE id IN ({marks})", [changes["status"], *ids])
            if changes.get("add_tags"):
                conn.executemany("INSERT OR IGNORE INTO group_tags (group_id, tag) VALUES (?, ?)",
                                 [(gid, t) for gid in ids for t in changes["add_tags"]])
            if changes.get("remove_tags"):
                tag_marks = ",".join("?" * len(changes["remove_tags"]))
                conn.execute(f"DELETE FROM group_tags WHERE group_id IN ({marks}) AND tag IN ({tag_marks})",
                             [*ids, *changes["remove_tags"]])
            for gid in ids:
                groups.sync_single(conn, gid)
        failed = guarded(work)
        return failed if failed is not None else jsonify(updated=len(ids))

    # ---- delete and restore: "delete" only moves an idea to the Trash; nothing is removed from disk ----
    @bp.delete("/api/groups/<int:gid>")
    @require_auth()
    def trash_group(gid):
        group_or_404(gid)
        guarded(lambda conn: groups.trash(conn, [gid], utcnow_iso()))
        return jsonify(ok=True)

    @bp.delete("/api/recordings/<int:rec_id>")
    @require_auth()
    def trash_recording(rec_id):
        row = groups.group_of_recording(db(), rec_id)
        if row is None:
            abort(404)
        guarded(lambda conn: groups.trash(conn, [row["id"]], utcnow_iso()))
        return jsonify(ok=True)

    def restore_by_group(gid, legacy):
        row = groups.get(db(), gid, live=False)
        if row is None or not row["deleted_at"]:
            abort(404)
        done = guarded(lambda conn: groups.restore(conn, gid))
        if done is not None:
            return done
        return jsonify(recording=one_group(gid)) if legacy else jsonify(group=one_group(gid))

    @bp.post("/api/groups/<int:gid>/restore")
    @require_auth()
    def restore_group(gid):
        return restore_by_group(gid, False)

    @bp.post("/api/recordings/<int:rec_id>/restore")
    @require_auth()
    def restore_recording(rec_id):
        row = groups.group_of_recording(db(), rec_id, live=False)
        if row is None:
            abort(404)
        return restore_by_group(row["id"], True)

    @bp.get("/api/trash")
    @require_auth()
    def list_trash():
        rows = db().execute("SELECT * FROM idea_groups WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC").fetchall()
        return jsonify(groups=groups.load(db(), rows))

    @bp.get("/api/resurface")
    @require_auth()
    def resurface():
        """Hearted Library ideas not played for `days` days (0 = every hearted one), never-played first, then the
        longest ago. A group counts once, with all its parts. `hearts` is how many hearted ideas exist at all."""
        try:
            days = int(request.args.get("days", "30"))
        except ValueError:
            return bad_request("days must be a whole number")
        if not 0 <= days <= 3650:
            return bad_request("days must be between 0 and 3650")
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        base = "FROM idea_groups WHERE deleted_at IS NULL AND status = 'tagged' AND rating = 'heart'"
        hearts = db().execute("SELECT COUNT(*) " + base).fetchone()[0]
        rows = db().execute(
            "SELECT * " + base + " AND (? = 0 OR last_played_at IS NULL OR last_played_at < ?)"
            " ORDER BY last_played_at IS NOT NULL, last_played_at ASC, recorded_at ASC, id ASC", (days, cutoff)).fetchall()
        resp = jsonify(groups=groups.load(db(), rows), hearts=hearts, days=days)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.get("/api/tags")
    @require_auth()
    def list_tags():
        return jsonify(tags=[r["name"] for r in db().execute("SELECT name FROM tags ORDER BY rowid")])

    @bp.post("/api/tags")
    @require_auth()
    def create_tag():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return bad_request("send a JSON object")
        try:
            name = normalize_tag(body.get("name"))
        except Invalid as exc:
            return bad_request(str(exc))
        conn = db()
        if conn.execute("SELECT 1 FROM tags WHERE name = ?", (name,)).fetchone():
            return jsonify(name=name, created=False), 200
        if conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0] >= MAX_TAGS_TOTAL:
            return bad_request(f"at most {MAX_TAGS_TOTAL} tags")
        conn.execute("INSERT INTO tags (name) VALUES (?)", (name,))
        conn.commit()
        return jsonify(name=name, created=True), 201

    def live_row(rec_id):
        row = db().execute(
            "SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL", (rec_id,)
        ).fetchone()
        if row is None:
            abort(404)
        return row

    def send_audio(path, mime, download_name, as_attachment, cache):
        if not path.is_file():
            abort(404)
        # conditional=True makes werkzeug honor Range (206) and If-Range/ETag.
        resp = send_file(path, mimetype=mime, as_attachment=as_attachment,
                         download_name=download_name, conditional=True, max_age=0)
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Cache-Control"] = cache
        return resp

    @bp.get("/api/audio/<int:rec_id>")
    @require_auth()
    def audio(rec_id):
        """The original file, byte for byte (what Download gives you)."""
        row = live_row(rec_id)
        return send_audio(audio_dir / row["filename"], row["mime"], row["orig_filename"],
                          request.args.get("download") == "1", "private, max-age=3600")

    @bp.get("/api/play/<int:rec_id>")
    @require_auth()
    def play(rec_id):
        """What the player streams: the FLAC play copy once it exists, otherwise the original.
        The answer changes over time, so browsers must revalidate rather than cache it."""
        row = live_row(rec_id)
        copy = row["play_filename"] if row["play_status"] == "ready" else None
        if copy and (audio_dir / copy).is_file():
            return send_audio(audio_dir / copy, "audio/flac", Path(row["orig_filename"]).stem + ".flac",
                              False, "private, no-cache")
        return send_audio(audio_dir / row["filename"], row["mime"], row["orig_filename"],
                          False, "private, no-cache")

    @bp.get("/api/recordings/<int:rec_id>/analysis")
    @require_auth()
    def analysis(rec_id):
        """Length and waveform for the player. `peaks` is null until the server has measured the
        recording, and an empty list if it could not (the player then draws a plain line)."""
        row = live_row(rec_id)
        peaks = None if row["peaks"] is None else json.loads(row["peaks"])
        if peaks is None and not app.config["FFMPEG"]:
            peaks = []             # nothing will ever measure it, so say so instead of making the player keep asking
        resp = jsonify(duration_s=row["duration_s"], peaks=peaks)
        resp.headers["Cache-Control"] = "private, no-cache"
        return resp

    @bp.post("/api/recordings/<int:rec_id>/played")
    @require_auth()
    def mark_played(rec_id):
        """Called by the player once a recording has really been listened to (not just skipped past)."""
        live_row(rec_id)
        now = utcnow_iso()
        db().execute("UPDATE recordings SET last_played_at = ? WHERE id = ?", (now, rec_id))
        groups.refresh(db(), live_row(rec_id)["group_id"])
        db().commit()
        return jsonify(ok=True, last_played_at=now)

    # ---- backup and export page ---------------------------------------------------------------------
    backup_runner = backups.Runner(data_dir, app.config["BACKUP_DIR"]) if app.config["BACKUP_DIR"] else None

    def library_health(original_bytes, recordings, backup):
        return collect_health(db(), data_dir, audio_dir, app.config["BACKUP_DIR"], backup, original_bytes, recordings,
                              disk_usage=lambda path: disk_usage(path))      # looked up on each use, so tests can fake a full disk

    @bp.get("/api/data")
    @require_auth()
    def data_overview():
        """Numbers for the "Backup and export" page."""
        row = db().execute("SELECT COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS live,"
                           " COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS trashed,"
                           " COALESCE(SUM(size), 0) AS bytes FROM recordings").fetchone()
        out = {"recordings": row["live"], "trashed": row["trashed"], "audio_bytes": row["bytes"], "backup": None}
        if backup_runner:
            out["backup"] = {**backups.status(data_dir, app.config["BACKUP_DIR"]), "job": backup_runner.job}
        out["health"] = library_health(row["bytes"], row["live"] + row["trashed"], out["backup"])
        resp = jsonify(out)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.post("/api/backup")
    @require_auth()
    def backup_now():
        if not backup_runner:
            return jsonify(error="backups are not set up on the server (see the page for how)"), 404
        started = backup_runner.start()
        return jsonify(started=started), (202 if started else 409)

    @bp.get("/api/groups/<int:gid>/download")
    @require_auth()
    def download_group(gid):
        """All the original recordings of one idea as a zip (each part by its own name), streamed as it is made."""
        g = group_or_404(gid)
        parts = db().execute("SELECT * FROM recordings WHERE group_id = ? ORDER BY position, id", (gid,)).fetchall()
        files = []
        for n, r in enumerate(parts, 1):
            path = audio_dir / r["filename"]
            if not path.is_file():
                abort(404)
            files.append((f"{n:02d} {exporter.safe_name(r['title'], 60)}{path.suffix}", path))      # the number keeps equal names apart
        title = exporter.safe_name(g["title"], 80)
        resp = Response(exporter.stream_files_zip(files, title), mimetype="application/zip")
        ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", title) or "idea"
        resp.headers["Content-Disposition"] = f"attachment; filename=\"{ascii_name}.zip\"; filename*=UTF-8''{urllib.parse.quote(title)}.zip"
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Accel-Buffering"] = "no"
        return resp

    @bp.get("/api/export.zip")
    @require_auth()
    def export_zip():
        """Everything as one zip, streamed as it is made (see exporter.py). `?trash=1` includes the Trash."""
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
        folder = f"riffbox-export-{stamp}"
        stream = exporter.stream_zip(data_dir, request.args.get("trash") == "1", scratch=scratch, folder=folder)
        resp = Response(stream, mimetype="application/zip")
        resp.headers["Content-Disposition"] = f'attachment; filename="{folder}.zip"'
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Accel-Buffering"] = "no"
        return resp

    @bp.get("/api/export/database")
    @require_auth()
    def export_database():
        """A consistent copy of the database file alone (small, instant)."""
        with tempfile.TemporaryDirectory(dir=scratch) as tmp:
            target = Path(tmp) / "riffbox.db"
            exporter.snapshot_database(data_dir, target)
            payload = io.BytesIO(target.read_bytes())
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
        return send_file(payload, mimetype="application/vnd.sqlite3", as_attachment=True,
                         download_name=f"riffbox-{stamp}.db", max_age=0)

    @bp.get("/api/about")
    @require_auth()
    def about():
        """The "How this works" page. It describes the server setup, so unlike the page files it is
        only handed to a logged-in session."""
        resp = send_file(ABOUT, mimetype="text/html", conditional=True, max_age=0)
        resp.headers["Cache-Control"] = "private, no-cache"
        return resp

    pages = webcache.PageFiles(Path(app.config["STATIC_DIR"]))
    MIME = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}

    def text_response(body, gzipped, etag, cache):
        """A text answer, gzip-compressed if the browser accepts it, with a weak ETag so a repeat visit can get "not modified"."""
        zip_ok = webcache.accepts_gzip(request.headers.get("Accept-Encoding"))
        resp = Response(gzipped if zip_ok else body)
        if zip_ok:
            resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
        resp.headers["Cache-Control"] = cache
        resp.set_etag(etag, weak=True)
        return resp.make_conditional(request)

    @bp.get("/")
    def index():
        page = pages.index()
        if page is None:
            abort(404)
        body, fingerprint = page
        resp = text_response(body, webcache.squeeze(body), fingerprint, "no-cache")         # always re-checked: tiny when unchanged
        resp.mimetype = "text/html"
        return resp

    @bp.get("/static/<path:name>")
    def static_files(name):
        ext = Path(name).suffix
        found = pages.read(name) if ext in MIME else None
        if found is None:                                          # anything else (or a missing file): as before
            return send_from_directory(app.config["STATIC_DIR"], name, max_age=0)
        body, gzipped, fingerprint = found
        # an address with ?v=<fingerprint> (as written into the page) can be kept for a year; a bare one is re-checked every time
        cache = f"public, max-age={webcache.ONE_YEAR}, immutable" if request.args.get("v") else "no-cache"
        resp = text_response(body, gzipped, fingerprint, cache)
        resp.mimetype = MIME[ext]
        return resp

    app.register_blueprint(bp, url_prefix=base)
    if base:
        # "/ideas" (no slash) -> "/ideas/". Relative redirect, so the scheme stays https.
        app.add_url_rule(base, "base_redirect", lambda: redirect(base + "/"))

    @app.after_request
    def harden(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        return resp

    @app.after_request
    def shrink(resp):
        """Compress text answers (the idea lists, this page's explanation) for browsers that accept it. Never audio or the export."""
        if resp.direct_passthrough or resp.is_streamed or resp.mimetype not in webcache.COMPRESSIBLE:
            return resp
        resp.vary.add("Accept-Encoding")
        data = resp.get_data()
        if (webcache.accepts_gzip(request.headers.get("Accept-Encoding"))
                and webcache.should_compress(resp.mimetype, resp.status_code, len(data), "Content-Encoding" in resp.headers)):
            resp.set_data(webcache.squeeze(data))
            resp.headers["Content-Encoding"] = "gzip"
        return resp

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(error="file too large"), 413

    return app
