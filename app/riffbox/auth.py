"""Everything about who may use Riffbox, in one file, so changing how login works means replacing this file.

Three ways in, nothing else:
  1. the owner's passphrase  -> POST /api/login -> a signed session cookie (HttpOnly, Secure, SameSite=Lax; set in __init__.py)
  2. the add-only upload token (Authorization: Bearer ...) -> only routes marked allow_token (upload, token-check)
  3. otherwise: 401

Standard parts used, none of them mine: Flask's signed session cookie, Werkzeug's password hashing (passwords.py), a constant-time
compare for the token. The one small piece written here is the attempt limit (throttle.py), because it is shorter than a package
that does the same. See docs/AUTH.md for how to replace this with a shared login or a proxy later.

Settings (app.config): PASSPHRASE_HASH (preferred) or PASSPHRASE (older plain-text setting, still accepted with a warning at
start-up), UPLOAD_TOKEN. With neither passphrase setting nobody can log in.
"""
import hmac
from functools import wraps

from flask import jsonify, request, session

from . import passwords
from .throttle import LoginThrottle

LOOPBACK = ("127.0.0.1", "::1")


class Auth:
    def __init__(self, app, clock):
        self.app = app
        self.throttle = LoginThrottle(clock)
        if not app.config.get("PASSPHRASE_HASH") and app.config.get("PASSPHRASE"):
            app.logger.warning("RIFFBOX_PASSPHRASE is stored as plain text. Run deploy/install.sh (or deploy/hash_passphrase.py) "
                               "to replace it with RIFFBOX_PASSPHRASE_HASH; plain-text support will be removed in a later version.")

    # ---- checks ----------------------------------------------------------------------------------------
    def passphrase_ok(self, supplied):
        stored = self.app.config.get("PASSPHRASE_HASH")
        if stored:
            return passwords.verify(stored, supplied)
        plain = self.app.config.get("PASSPHRASE")
        return bool(plain) and hmac.compare_digest(supplied.encode(), plain.encode())

    def token_ok(self):
        expected = self.app.config["UPLOAD_TOKEN"]
        header = request.headers.get("Authorization", "")
        if not expected or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode(), expected.encode())

    def client_key(self):
        """Who is asking. waitress only listens on loopback, so every real connection comes from relayd, which *sets*
        X-Forwarded-For to the true client address (any client-supplied value is overwritten). Trust that header only
        for loopback peers."""
        addr = request.remote_addr or "?"
        if addr in LOOPBACK:
            last = request.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
            if last:
                return last
        return addr

    # ---- the decorator every protected route uses ---------------------------------------------------------
    def require(self, allow_token=False):
        def deco(fn):
            @wraps(fn)
            def wrapper(*a, **kw):
                if session.get("ok") or (allow_token and self.token_ok()):
                    return fn(*a, **kw)
                return jsonify(error="unauthorized", message="Riffbox: not allowed (wrong or missing token, or logged out)."), 401
            return wrapper
        return deco

    # ---- the three login routes ---------------------------------------------------------------------------
    def register_routes(self, bp):
        @bp.post("/api/login")
        def login():
            key = self.client_key()
            wait = self.throttle.wait_for(key)
            if wait:
                resp = jsonify(error="too many attempts", retry_after=wait)
                resp.status_code = 429
                resp.headers["Retry-After"] = str(wait)
                return resp
            body = request.get_json(silent=True) or {}
            if self.passphrase_ok(str(body.get("passphrase", ""))):
                self.throttle.succeeded(key)
                session.clear()
                session.permanent = True
                session["ok"] = True
                return jsonify(ok=True)
            self.throttle.failed(key)
            return jsonify(error="bad passphrase"), 401

        @bp.get("/api/session")
        @self.require()
        def session_status():
            return jsonify(ok=True)

        @bp.post("/api/logout")
        def logout():
            session.clear()
            return jsonify(ok=True)
