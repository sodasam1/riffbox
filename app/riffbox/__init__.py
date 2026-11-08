"""Riffbox: a tiny single-user vault for musical voice-memo ideas.

Phase 1 core: upload (deduped by sha256), range-capable audio streaming,
passphrase/cookie login, and a bare recordings list.
"""
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
from collections import deque
from functools import wraps
from pathlib import Path
from types import SimpleNamespace

from flask import (Blueprint, Flask, abort, g, jsonify, redirect, request,
                   send_file, send_from_directory, session)

from .intake import Invalid, MAX_TAGS_TOTAL, normalize_tag, validate_patch
from .library import build_query, parse_filters
from .media import INPUT_FORMAT, analyze_audio, convert_to_flac, mp4_audio_codec

ALLOWED_EXT = {
    ".m4a", ".mp3", ".wav", ".aac", ".caf", ".aif", ".aiff", ".ogg", ".flac", ".mp4",
}
FALLBACK_MIME = {".m4a": "audio/mp4", ".caf": "audio/x-caf", ".aac": "audio/aac"}
MP4_EXT = (".m4a", ".mp4")        # containers whose audio codec we can read
NEW_COLUMNS = ("codec", "play_status", "play_filename", "play_error")


def default_ffmpeg():
    return (os.environ.get("RIFFBOX_FFMPEG") or shutil.which("ffmpeg")
            or ("/usr/local/bin/ffmpeg" if os.access("/usr/local/bin/ffmpeg", os.X_OK) else ""))

SCHEMA = Path(__file__).with_name("schema.sql")
ABOUT = Path(__file__).with_name("about.html")        # the private "How this works" page

# Login throttling: after PER_CLIENT_MAX wrong passphrases from one client (or GLOBAL_MAX from
# anyone) inside WINDOW seconds, logins get HTTP 429 until the oldest failure ages out.
LOGIN_WINDOW = 15 * 60
LOGIN_PER_CLIENT_MAX = 5
LOGIN_GLOBAL_MAX = 30
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

    # Werkzeug parks big uploads in a temp file while it parses them. Keep that inside the data directory
    # (the disk with room), not the system /tmp, which may be small.
    scratch = data_dir / "tmp"
    scratch.mkdir(exist_ok=True)
    tempfile.tempdir = str(scratch)
    for leftover in scratch.iterdir():
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
            row = conn.execute("SELECT filename FROM recordings WHERE id = ?", (rec_id,)).fetchone()
            if row is None:
                return
            ok, duration, peaks, err = analyze_audio(app.config["FFMPEG"], audio_dir / row["filename"],
                                                     app.config["CONVERT_TIMEOUT"])
            if ok:
                conn.execute("UPDATE recordings SET duration_s=?, peaks=? WHERE id=?",
                             (duration, json.dumps(peaks, separators=(",", ":")), rec_id))
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
                return jsonify(error="unauthorized"), 401
            return wrapper
        return deco

    # ---- login throttling (in memory; resets when the service restarts) ---------
    throttle_lock = threading.Lock()
    failures = {}                 # client key -> deque of failure times
    global_failures = deque()

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

    def _prune(dq, now):
        while dq and now - dq[0] >= LOGIN_WINDOW:
            dq.popleft()

    def login_wait(key, now):
        """Seconds the client must wait (0 = allowed). Caller holds throttle_lock."""
        mine = failures.get(key)
        if mine is not None:
            _prune(mine, now)
            if not mine:
                del failures[key]
        _prune(global_failures, now)
        wait = 0
        if mine and len(mine) >= LOGIN_PER_CLIENT_MAX:
            wait = max(wait, LOGIN_WINDOW - (now - mine[0]))
        if len(global_failures) >= LOGIN_GLOBAL_MAX:
            wait = max(wait, LOGIN_WINDOW - (now - global_failures[0]))
        return int(wait) + 1 if wait > 0 else 0

    @bp.post("/api/login")
    def login():
        key = client_key()
        now = _now()
        with throttle_lock:
            if len(failures) > 1000:             # bound memory
                for k in list(failures):
                    _prune(failures[k], now)
                    if not failures[k]:
                        del failures[k]
            wait = login_wait(key, now)
        if wait:
            resp = jsonify(error="too many attempts", retry_after=wait)
            resp.status_code = 429
            resp.headers["Retry-After"] = str(wait)
            return resp
        body = request.get_json(silent=True) or {}
        supplied = str(body.get("passphrase", ""))
        expected = app.config["PASSPHRASE"]
        if expected and hmac.compare_digest(supplied.encode(), expected.encode()):
            with throttle_lock:
                failures.pop(key, None)
            session.clear()
            session.permanent = True
            session["ok"] = True
            return jsonify(ok=True)
        with throttle_lock:
            failures.setdefault(key, deque()).append(now)
            global_failures.append(now)
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

    def row_to_dict(row, tags=()):
        keys = ("id", "title", "orig_filename", "mime", "size", "duration_s",
                "recorded_at", "uploaded_at", "status", "tempo", "bpm",
                "key_root", "key_mode", "notes", "rating", "used_in", "codec", "play_status", "last_played_at")
        out = {k: row[k] for k in keys}
        out["tags"] = list(tags)
        return out

    def tags_for(ids):
        """{recording id: [tag names]} in the order tags were created (seeded ones first)."""
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        found = {}
        for r in db().execute(
            f"SELECT rt.recording_id AS rid, rt.tag AS tag FROM recording_tags rt"
            f" JOIN tags t ON t.name = rt.tag WHERE rt.recording_id IN ({marks}) ORDER BY t.rowid",
            list(ids),
        ):
            found.setdefault(r["rid"], []).append(r["tag"])
        return found

    def bad_request(message):
        return jsonify(error=message), 400

    @bp.post("/api/upload")
    @require_auth(allow_token=True)
    def upload():
        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify(error="no file"), 400
        orig = os.path.basename(f.filename)
        ext = Path(orig).suffix.lower()
        if ext not in ALLOWED_EXT:
            return jsonify(error=f"unsupported file type {ext or '(none)'}"), 415

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
                return jsonify(error="empty file"), 400
            digest = h.hexdigest()
            db().execute("BEGIN IMMEDIATE")      # check-then-insert as one step: two identical uploads at once cannot both pass
            existing = db().execute(
                "SELECT id FROM recordings WHERE sha256 = ? AND deleted_at IS NULL", (digest,)
            ).fetchone()
            if existing:
                db().rollback()
                return jsonify(id=existing["id"], duplicate=True), 200

            now = utcnow_iso()
            recorded_at = parse_iso(request.form.get("recorded_at")) or now
            title = (request.form.get("title") or "").strip() or default_title(recorded_at)
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
            db().commit()
            stored_path = None                          # recorded in the database: keep the file
            if needs_copy:
                jobs.put(("convert", cur.lastrowid))   # convert in the background; the upload returns now
            if app.config["FFMPEG"] and ext in INPUT_FORMAT:
                jobs.put(("analyze", cur.lastrowid))   # and measure it (length + waveform)
            return jsonify(id=cur.lastrowid, duplicate=False), 201
        finally:
            tmp_path.unlink(missing_ok=True)
            if stored_path is not None:                 # the database insert failed: don't leave an orphan file
                stored_path.unlink(missing_ok=True)

    @bp.get("/api/recordings")
    @require_auth()      # the upload token is add-only: it must not be able to read the library
    def list_recordings():
        """Recordings matching the filters in the query string (see library.py). `count` is how many
        matched; `total` is how many exist in this status before any filter, for "12 of 40"."""
        try:
            filters = parse_filters(request.args)
        except Invalid as exc:
            return bad_request(str(exc))
        sql, params = build_query(filters)
        rows = db().execute(sql, params).fetchall()
        count_sql, count_params = "SELECT rating, COUNT(*) AS n FROM recordings WHERE deleted_at IS NULL", []
        if filters["status"]:
            count_sql += " AND status = ?"
            count_params.append(filters["status"])
        counts = {"heart": 0, "check": 0, "x": 0, "none": 0}      # how many carry each mark, before any filter
        for r in db().execute(count_sql + " GROUP BY rating", count_params):
            counts[r["rating"] or "none"] = r["n"]
        total = sum(counts.values())
        tags = tags_for([r["id"] for r in rows])
        return jsonify(recordings=[row_to_dict(r, tags.get(r["id"], ())) for r in rows],
                       count=len(rows), total=total, ratings=counts)

    @bp.patch("/api/recordings/<int:rec_id>")
    @require_auth()
    def update_recording(rec_id):
        """Change a recording's details. Every field is optional; saving an unchanged or empty
        form is fine. `status: "tagged"` is what moves a recording out of the inbox."""
        row = live_row(rec_id)
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return bad_request("send a JSON object")
        known = {r["name"] for r in db().execute("SELECT name FROM tags")}
        try:
            cols, tag_list = validate_patch(body, known, default_title(row["recorded_at"]), row["uploaded_at"])
        except Invalid as exc:
            return bad_request(str(exc))
        # "used in" names the song a ✓ idea became, so it only belongs to a ✓
        rating_after = cols["rating"] if "rating" in cols else row["rating"]
        if "rating" in cols and rating_after != "check" and "used_in" not in cols:
            cols["used_in"] = None
        if cols.get("used_in") and rating_after != "check":
            return bad_request("'used in' only applies to a recording marked ✓")
        conn = db()
        if cols:    # column names come from validate_patch's fixed set, never from the request
            conn.execute("UPDATE recordings SET " + ", ".join(f"{c} = ?" for c in cols) + " WHERE id = ?",
                         [*cols.values(), rec_id])
        if tag_list is not None:
            conn.execute("DELETE FROM recording_tags WHERE recording_id = ?", (rec_id,))
            conn.executemany("INSERT INTO recording_tags (recording_id, tag) VALUES (?, ?)",
                             [(rec_id, t) for t in tag_list])
        conn.commit()
        fresh = live_row(rec_id)
        return jsonify(recording=row_to_dict(fresh, tags_for([rec_id]).get(rec_id, ())))

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
        db().commit()
        return jsonify(ok=True, last_played_at=now)

    @bp.get("/api/about")
    @require_auth()
    def about():
        """The "How this works" page. It describes the server setup, so unlike the page files it is
        only handed to a logged-in session."""
        resp = send_file(ABOUT, mimetype="text/html", conditional=True, max_age=0)
        resp.headers["Cache-Control"] = "private, no-cache"
        return resp

    @bp.get("/")
    def index():
        return send_from_directory(app.config["STATIC_DIR"], "index.html", max_age=0)

    @bp.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(app.config["STATIC_DIR"], name, max_age=0)

    app.register_blueprint(bp, url_prefix=base)
    if base:
        # "/ideas" (no slash) -> "/ideas/". Relative redirect, so the scheme stays https.
        app.add_url_rule(base, "base_redirect", lambda: redirect(base + "/"))

    @app.after_request
    def harden(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        return resp

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(error="file too large"), 413

    return app
