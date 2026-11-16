"""SiteAuth: verify the owner's cookie for ONE app, with that app's own key. Fails closed.

Every route must be declared with exactly one of:
    @auth.public    anyone (public pages, share links, health)
    @auth.owner     the owner's cookie (same as undeclared: undeclared routes are owner-only)
    @auth.token     the owner's cookie OR a machine credential checked by `bearer_check(request)` (e.g. the phone upload token)
and `undeclared_routes(app)` lets each app's tests fail if someone forgets.

Cookie: signed (itsdangerous, standard), HttpOnly, Secure, SameSite, scoped to the app's path. It holds only {role, iat, seen}.
Lifetime: `absolute` seconds from login (default 30 days) and `idle` seconds since last use (default 7 days); every use at most once an
hour refreshes `seen`. The signing key is the app's own key file; changing the generation (keys.rotate) logs everything out.
"""
import time
from functools import wraps
from urllib.parse import quote, urlsplit

from flask import jsonify, redirect, request
from itsdangerous import BadSignature, URLSafeSerializer

from .keys import KeyFile

SALT = "siteauth-cookie-v1"
UNSAFE = ("POST", "PUT", "PATCH", "DELETE")
ABSOLUTE = 30 * 86400
IDLE = 7 * 86400
REFRESH_EVERY = 3600


def make_token(key, now, role="owner", iat=None):
    return URLSafeSerializer(key, salt=SALT).dumps({"r": role, "iat": int(iat if iat is not None else now), "seen": int(now)})


def read_token(key, token, now, absolute=ABSOLUTE, idle=IDLE):
    """The payload dict if the token is genuine and not expired, else None. Never raises."""
    if not key or not token:
        return None
    try:
        data = URLSafeSerializer(key, salt=SALT).loads(token)
        if data.get("r") != "owner" or now - int(data["iat"]) > absolute or now - int(data["seen"]) > idle:
            return None
        return data
    except (BadSignature, KeyError, TypeError, ValueError, AttributeError):
        return None


def safe_next(value, fallback="/"):
    """A redirect target after login: a plain same-site path only (no scheme, no //host, no backslash, no control characters)."""
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return fallback
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        return fallback
    parts = urlsplit(value)
    return fallback if parts.scheme or parts.netloc else value


def _mark(mode):
    def deco(fn):
        fn._siteauth = mode
        return fn
    return deco


def undeclared_routes(app):
    """Endpoints that have no @public/@owner/@token declaration (Flask's own static route excluded). Apps test this is empty."""
    return sorted(e for e, fn in app.view_functions.items() if e != "static" and not getattr(fn, "_siteauth", None))


class SiteAuth:
    def __init__(self, app, *, name, key_file, cookie_path="/", login_url="/login", clock=time.time, samesite="Lax",
                 secure=True, absolute=ABSOLUTE, idle=IDLE, bearer_check=None, api_prefixes=("/api/",)):
        self.app, self.name, self.keys = app, name, KeyFile(key_file)
        self.cookie_name = f"site_{name}"
        self.cookie_path, self.login_url, self.clock = cookie_path, login_url, clock
        self.samesite, self.secure, self.absolute, self.idle = samesite, secure, absolute, idle
        self.bearer_check, self.api_prefixes = bearer_check, api_prefixes
        self.public, self.owner, self.token = _mark("public"), _mark("owner"), _mark("token")
        app.before_request(self._guard)
        app.after_request(self._refresh)

    # ---- who is asking --------------------------------------------------------------------------------
    def _payload(self):
        return read_token(self.keys.get(), request.cookies.get(self.cookie_name), self.clock(), self.absolute, self.idle)

    def is_owner(self):
        """True if the request carries a valid owner cookie (for templates and "owner" flags on public pages)."""
        return self._payload() is not None

    # ---- the guard ------------------------------------------------------------------------------------
    def _origin_ok(self):
        origin = request.headers.get("Origin")
        if origin and origin != "null":
            return urlsplit(origin).netloc == request.host
        if origin == "null":
            return False
        site = request.headers.get("Sec-Fetch-Site")
        return site in (None, "same-origin", "none")

    def _denied(self):
        wants_html = request.method == "GET" and "text/html" in request.headers.get("Accept", "") \
            and not any(request.path.startswith(p) for p in self.api_prefixes)
        if wants_html:
            target = request.path + ("?" + request.query_string.decode("latin-1") if request.query_string else "")
            return redirect(f"{self.login_url}?next={quote(target, safe='/')}", 303)
        return jsonify(error="unauthorized"), 401

    def _guard(self):
        if request.endpoint is None:                       # unknown URL: Flask answers 404
            return None
        mode = getattr(self.app.view_functions.get(request.endpoint), "_siteauth", "owner")
        if request.method in UNSAFE and not self._origin_ok():
            return jsonify(error="cross-site request refused"), 403
        if mode == "public":
            return None
        if self._payload() is not None:
            return None
        if mode == "token" and self.bearer_check and self.bearer_check(request):
            return None
        return self._denied()

    def _refresh(self, resp):
        """Keep an active session alive: re-sign `seen` at most once an hour (this app holds its own key, so it can)."""
        data = self._payload() if request.endpoint else None
        key = self.keys.get()
        if data and key and self.clock() - int(data["seen"]) > REFRESH_EVERY and resp.status_code < 400:
            now = self.clock()
            resp.set_cookie(self.cookie_name, make_token(key, now, iat=data["iat"]), max_age=int(self.absolute),
                            path=self.cookie_path, httponly=True, secure=self.secure, samesite=self.samesite)
        return resp
