"""Everything about who may use Riffbox, in one file, so changing how login works means replacing this file.

Ways in, nothing else:
  1. the owner's passphrase  -> POST /api/login -> a signed session cookie ("local" login; HttpOnly, Secure, SameSite=Lax; set in __init__.py)
  2. the SITE LOGIN: one passphrase for every app on the server (kit/login). It sets a cookie `site_riffbox`, signed with THIS app's own
     key (/etc/site-auth/keys/riffbox.key), which this file verifies with kit/siteauth. See docs/AUTH.md and personal-site docs/MULTI-APP.md.
  3. the add-only upload token (Authorization: Bearer ...) -> only routes marked allow_token (upload, token-check)
  4. otherwise: 401

RIFFBOX_AUTH chooses which of 1 and 2 work:
  local  (default) only the older local login. Nothing about the site login is looked at.
  both   either works: use this while moving over.
  site   only the site login; POST /api/login answers 410 and the page sends you to /login.

Standard parts used, none of them mine: Flask's signed session cookie, Werkzeug's password hashing (passwords.py), itsdangerous (via
siteauth), a constant-time compare for the token. The small pieces written here are the attempt limits (throttle.py, siteauth.ratelimit).
Safeguards in this file: login bodies are limited to 4 KB (an unauthenticated route must not read 300 MB), failed token guesses are
counted, state-changing browser requests from another origin are refused, and a lockout of the owner by strangers is not possible.

Settings (app.config): PASSPHRASE_HASH (preferred) or PASSPHRASE (older plain-text setting, still accepted with a warning at
start-up), UPLOAD_TOKEN, AUTH_MODE, SITE_KEY_FILE, SITE_LOGIN_URL. With no passphrase setting nobody can log in locally.
"""
import hmac
import time
from functools import wraps
from urllib.parse import urlsplit

from flask import jsonify, request, session

from siteauth.core import REFRESH_EVERY, make_token, read_token
from siteauth.keys import KeyFile
from siteauth.ratelimit import Limiter

from . import passwords
from .throttle import LOGIN_PER_CLIENT_MAX, LOGIN_SLOW_DELAY, LOGIN_WINDOW, LoginThrottle

LOOPBACK = ("127.0.0.1", "::1")
UNSAFE = ("POST", "PUT", "PATCH", "DELETE")
MODES = ("local", "both", "site")
COOKIE = "site_riffbox"
TOKEN_FAILS_PER_CLIENT = 20
LOGIN_BODY_LIMIT = 4096


class Auth:
    def __init__(self, app, clock):
        self.app = app
        self.throttle = LoginThrottle(clock, per_client_max=int(app.config.get("LOGIN_MAX_FAILS", LOGIN_PER_CLIENT_MAX)),
                                      window=int(app.config.get("LOGIN_WINDOW_MINUTES", LOGIN_WINDOW // 60)) * 60)
        self.token_limiter = Limiter(clock, per_key_max=TOKEN_FAILS_PER_CLIENT)
        self.mode = app.config.get("AUTH_MODE", "local")
        if self.mode not in MODES:
            raise RuntimeError(f"RIFFBOX_AUTH must be one of {', '.join(MODES)} (got '{self.mode}')")
        self.site_keys = KeyFile(app.config.get("SITE_KEY_FILE", "/etc/site-auth/keys/riffbox.key"))
        self.wall = app.config.get("WALL_CLOCK", time.time)          # the login service stamps cookies with the real time, not the monotonic clock
        if not app.config.get("PASSPHRASE_HASH") and app.config.get("PASSPHRASE"):
            app.logger.warning("RIFFBOX_PASSPHRASE is stored as plain text. Run deploy/install.sh --repair (or deploy/hash_passphrase.py) "
                               "to replace it with RIFFBOX_PASSPHRASE_HASH; plain-text support will be removed in a later version.")
        app.before_request(self._refuse_cross_origin)
        app.after_request(self._refresh_site_cookie)

    # ---- checks ----------------------------------------------------------------------------------------
    def passphrase_ok(self, supplied):
        stored = self.app.config.get("PASSPHRASE_HASH")
        if stored:
            return passwords.verify(stored, supplied)
        plain = self.app.config.get("PASSPHRASE")
        return bool(plain) and hmac.compare_digest(supplied.encode(), plain.encode())

    def token_ok(self):
        """The add-only upload token. Wrong guesses are counted per client; after TOKEN_FAILS_PER_CLIENT in 15 minutes that client is refused."""
        expected = self.app.config["UPLOAD_TOKEN"]
        header = request.headers.get("Authorization", "")
        if not expected or not header.startswith("Bearer "):
            return False
        key = self.client_key()
        if self.token_limiter.wait_for(key):
            return False
        if hmac.compare_digest(header[7:].encode(), expected.encode()):
            return True
        self.token_limiter.failed(key)
        return False

    def _site_payload(self):
        if self.mode == "local":
            return None
        return read_token(self.site_keys.get(), request.cookies.get(COOKIE), self.wall())

    def site_ok(self):
        return self._site_payload() is not None

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

    def _refuse_cross_origin(self):
        """Defence in depth on top of SameSite=Lax: a state-changing request that a browser says came from another origin is refused.
        Requests with no Origin and no Sec-Fetch-Site (the iPhone Shortcut, curl, tests) are not browsers acting for a page and pass."""
        if request.method not in UNSAFE:
            return None
        origin = request.headers.get("Origin")
        if origin:
            if origin != "null" and urlsplit(origin).netloc == request.host:
                return None
            return jsonify(error="cross-site request refused"), 403
        if request.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            return jsonify(error="cross-site request refused"), 403
        return None

    def _refresh_site_cookie(self, resp):
        """An active site session stays alive: re-sign `seen` at most once an hour (this app holds its own key, so it can)."""
        data = self._site_payload() if request.endpoint else None
        key = self.site_keys.get()
        if data and key and resp.status_code < 400 and self.wall() - int(data["seen"]) > REFRESH_EVERY:
            resp.set_cookie(COOKIE, make_token(key, self.wall(), iat=data["iat"]), max_age=30 * 86400, path=self.app.config["SESSION_COOKIE_PATH"],
                            httponly=True, secure=self.app.config["SESSION_COOKIE_SECURE"], samesite="Lax")
        return resp

    # ---- the decorator every protected route uses ---------------------------------------------------------
    def require(self, allow_token=False):
        def deco(fn):
            @wraps(fn)
            def wrapper(*a, **kw):
                if ((self.mode != "site" and session.get("ok")) or self.site_ok() or (allow_token and self.token_ok())):
                    return fn(*a, **kw)
                return jsonify(error="unauthorized", message="Riffbox: not allowed (wrong or missing token, or logged out)."), 401
            return wrapper
        return deco

    # ---- the login routes ---------------------------------------------------------------------------------
    def register_routes(self, bp):
        @bp.get("/api/auth-info")
        def auth_info():
            """Public: lets the page know where to sign in. Reveals nothing but the login address and which way is in use."""
            return jsonify(mode=self.mode, site_login=self.app.config.get("SITE_LOGIN_URL", "/login") if self.mode != "local" else None)

        @bp.post("/api/login")
        def login():
            if self.mode == "site":
                return jsonify(error="login moved", site_login=self.app.config.get("SITE_LOGIN_URL", "/login")), 410
            request.max_content_length = LOGIN_BODY_LIMIT           # an unauthenticated route never reads more than a passphrase
            key = self.client_key()
            wait = self.throttle.wait_for(key)
            if wait:
                resp = jsonify(error="too many attempts", retry_after=wait)
                resp.status_code = 429
                resp.headers["Retry-After"] = str(wait)
                return resp
            slow = self.throttle.under_pressure()
            if slow:                                                # many clients are guessing: slow every attempt a little, lock nobody out
                if not self.throttle.try_slow():
                    resp = jsonify(error="busy", retry_after=2)
                    resp.status_code = 429
                    resp.headers["Retry-After"] = "2"
                    return resp
                self.app.config.get("LOGIN_SLEEP", time.sleep)(self.app.config.get("LOGIN_SLOW_DELAY", LOGIN_SLOW_DELAY))
            try:
                body = request.get_json(silent=True) or {}
                if self.passphrase_ok(str(body.get("passphrase", ""))):
                    self.throttle.succeeded(key)
                    session.clear()
                    session.permanent = True
                    session["ok"] = True
                    return jsonify(ok=True)
                self.throttle.failed(key)
                return jsonify(error="bad passphrase"), 401
            finally:
                if slow:
                    self.throttle.leave_slow()

        @bp.get("/api/session")
        @self.require()
        def session_status():
            return jsonify(ok=True)

        @bp.post("/api/logout")
        def logout():
            session.clear()
            resp = jsonify(ok=True)
            if self.mode != "local":                                # sign out of THIS app; /login/logout signs out of every app
                resp.set_cookie(COOKIE, "", max_age=0, expires=0, path=self.app.config["SESSION_COOKIE_PATH"],
                                httponly=True, secure=self.app.config["SESSION_COOKIE_SECURE"], samesite="Lax")
            return resp
