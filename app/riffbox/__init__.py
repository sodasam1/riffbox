"""Riffbox: a tiny single-user vault for musical voice-memo ideas.

Phase 1 core: upload (deduped by sha256), range-capable audio streaming,
passphrase/cookie login, and a bare recordings list.
"""
import datetime as dt
import hashlib
import hmac
import mimetypes
import os
import secrets
import sqlite3
import tempfile
import uuid
from functools import wraps
from pathlib import Path

from flask import (Blueprint, Flask, abort, g, jsonify, redirect, request,
                   send_file, send_from_directory, session)

ALLOWED_EXT = {
    ".m4a", ".mp3", ".wav", ".aac", ".caf", ".aif", ".aiff", ".ogg", ".flac", ".mp4",
}
FALLBACK_MIME = {".m4a": "audio/mp4", ".caf": "audio/x-caf", ".aac": "audio/aac"}

SCHEMA = Path(__file__).with_name("schema.sql")


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
    return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
        return conn

    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA.read_text())

    def db():
        if "db" not in g:
            g.db = connect()
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

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

    @bp.post("/api/login")
    def login():
        body = request.get_json(silent=True) or {}
        supplied = str(body.get("passphrase", ""))
        expected = app.config["PASSPHRASE"]
        if expected and hmac.compare_digest(supplied.encode(), expected.encode()):
            session.clear()
            session.permanent = True
            session["ok"] = True
            return jsonify(ok=True)
        return jsonify(error="bad passphrase"), 401

    @bp.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    # ---- routes --------------------------------------------------------
    @bp.get("/health")
    def health():
        db().execute("SELECT 1").fetchone()
        return jsonify(status="ok")

    def row_to_dict(row):
        keys = ("id", "title", "orig_filename", "mime", "size", "duration_s",
                "recorded_at", "uploaded_at", "status", "tempo", "bpm",
                "key_root", "key_mode", "notes", "rating", "used_in")
        return {k: row[k] for k in keys}

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
        with tempfile.NamedTemporaryFile(dir=audio_dir, prefix=".incoming-", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            while True:
                chunk = f.stream.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
                size += len(chunk)
                tmp.write(chunk)
        try:
            if size == 0:
                return jsonify(error="empty file"), 400
            digest = h.hexdigest()
            existing = db().execute(
                "SELECT id FROM recordings WHERE sha256 = ? AND deleted_at IS NULL", (digest,)
            ).fetchone()
            if existing:
                return jsonify(id=existing["id"], duplicate=True), 200

            now = utcnow_iso()
            recorded_at = parse_iso(request.form.get("recorded_at")) or now
            title = (request.form.get("title") or "").strip() or default_title(recorded_at)
            mime = (mimetypes.guess_type(orig)[0] or FALLBACK_MIME.get(ext)
                    or "application/octet-stream")
            if ext in FALLBACK_MIME:
                mime = FALLBACK_MIME[ext]
            stored = f"{uuid.uuid4().hex}{ext}"
            os.replace(tmp_path, audio_dir / stored)
            os.chmod(audio_dir / stored, 0o640)
            cur = db().execute(
                "INSERT INTO recordings (title, filename, orig_filename, mime, size, sha256,"
                " recorded_at, uploaded_at) VALUES (?,?,?,?,?,?,?,?)",
                (title, stored, orig, mime, size, digest, recorded_at, now),
            )
            db().commit()
            return jsonify(id=cur.lastrowid, duplicate=False), 201
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    @bp.get("/api/recordings")
    @require_auth(allow_token=True)
    def list_recordings():
        rows = db().execute(
            "SELECT * FROM recordings WHERE deleted_at IS NULL ORDER BY recorded_at DESC, id DESC"
        ).fetchall()
        return jsonify(recordings=[row_to_dict(r) for r in rows])

    @bp.get("/api/audio/<int:rec_id>")
    @require_auth()
    def audio(rec_id):
        row = db().execute(
            "SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL", (rec_id,)
        ).fetchone()
        if row is None:
            abort(404)
        path = audio_dir / row["filename"]
        if not path.is_file():
            abort(404)
        download = request.args.get("download") == "1"
        # conditional=True makes werkzeug honor Range (206) and If-Range/ETag.
        resp = send_file(
            path,
            mimetype=row["mime"],
            as_attachment=download,
            download_name=row["orig_filename"],
            conditional=True,
            max_age=3600,
        )
        resp.headers["Accept-Ranges"] = "bytes"
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    @bp.get("/")
    def index():
        return send_from_directory(app.config["STATIC_DIR"], "index.html", max_age=0)

    @bp.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(app.config["STATIC_DIR"], name, max_age=3600)

    app.register_blueprint(bp, url_prefix=base)
    if base:
        # "/ideas" (no slash) -> "/ideas/". Relative redirect, so the scheme stays https.
        app.add_url_rule(base, "base_redirect", lambda: redirect(base + "/"))

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(error="file too large"), 413

    return app
