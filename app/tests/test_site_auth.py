"""The site-wide login (kit/login) as seen by Riffbox, and the safeguards added with it."""
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app
from siteauth import keys, make_token

KEYS_PY = Path(__file__).resolve().parents[1] / "siteauth" / "keys.py"
NOW = 1_800_000_000.0


class Wall:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def site(tmp_path):
    d = tmp_path / "site-auth"
    run = lambda *a: subprocess.run([sys.executable, str(KEYS_PY), *a, "--no-chown"], check=True, capture_output=True)   # noqa: E731
    run("init", "--dir", str(d))
    run("ensure-app", "--dir", str(d), "--app", "riffbox", "--path", "/ideas")
    run("ensure-app", "--dir", str(d), "--app", "music", "--path", "/music")
    return d


def build(tmp_path, site, mode, wall=None, **extra):
    cfg = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "test-secret",
           "SESSION_COOKIE_SECURE": False, "AUTH_MODE": mode, "SITE_KEY_FILE": str(site / "keys" / "riffbox.key"),
           "WALL_CLOCK": wall or Wall()}
    cfg.update(extra)
    return create_app(cfg)


def cookie(site, app_name="riffbox", now=NOW, **kw):
    master = keys.read_first_line(str(site / "master"))
    return make_token(keys.derive(master, app_name, keys.read_first_line(str(site / "generation"))), now, **kw)


def test_local_mode_ignores_the_site_cookie(tmp_path, site):
    c = build(tmp_path, site, "local").test_client()
    c.set_cookie("site_riffbox", cookie(site))
    assert c.get("/api/session").status_code == 401


@pytest.mark.parametrize("mode", ["both", "site"])
def test_site_cookie_opens_the_app(tmp_path, site, mode):
    c = build(tmp_path, site, mode).test_client()
    assert c.get("/api/session").status_code == 401
    c.set_cookie("site_riffbox", cookie(site))
    assert c.get("/api/session").status_code == 200
    assert c.get("/api/groups").status_code == 200


def test_a_cookie_made_for_another_app_is_refused(tmp_path, site):
    c = build(tmp_path, site, "both").test_client()
    c.set_cookie("site_riffbox", cookie(site, "music"))
    assert c.get("/api/session").status_code == 401


def test_expired_and_tampered_site_cookies_are_refused(tmp_path, site):
    wall = Wall()
    c = build(tmp_path, site, "both", wall).test_client()
    good = cookie(site)
    c.set_cookie("site_riffbox", good)
    assert c.get("/api/session").status_code == 200
    wall.t = NOW + 31 * 86400
    assert c.get("/api/session").status_code == 401
    wall.t = NOW
    c.set_cookie("site_riffbox", good[:-3] + "abc")
    assert c.get("/api/session").status_code == 401


def test_no_key_file_fails_closed(tmp_path, site):
    (site / "keys" / "riffbox.key").unlink()
    c = build(tmp_path, site, "site").test_client()
    c.set_cookie("site_riffbox", cookie(site))
    assert c.get("/api/session").status_code == 401


def test_rotating_the_generation_logs_everyone_out(tmp_path, site):
    c = build(tmp_path, site, "site").test_client()
    c.set_cookie("site_riffbox", cookie(site))
    assert c.get("/api/session").status_code == 200
    subprocess.run([sys.executable, str(KEYS_PY), "rotate", "--dir", str(site)], check=True, capture_output=True)
    import os
    os.utime(site / "keys" / "riffbox.key", ns=(10**18, 10**18 + 7))
    assert c.get("/api/session").status_code == 401


def test_site_mode_retires_the_local_login(tmp_path, site):
    c = build(tmp_path, site, "site").test_client()
    r = c.post("/api/login", json={"passphrase": PASS})
    assert r.status_code == 410 and r.json["site_login"] == "/login"
    assert build(tmp_path, site, "both").test_client().post("/api/login", json={"passphrase": PASS}).status_code == 200


def test_auth_info_tells_the_page_where_to_sign_in(tmp_path, site):
    assert build(tmp_path, site, "local").test_client().get("/api/auth-info").json == {"mode": "local", "site_login": None}
    assert build(tmp_path, site, "site").test_client().get("/api/auth-info").json == {"mode": "site", "site_login": "/login"}


def test_unknown_mode_is_refused_at_start(tmp_path, site):
    with pytest.raises(RuntimeError):
        build(tmp_path, site, "sideways")


def test_active_site_session_is_refreshed_once_an_hour(tmp_path, site):
    wall = Wall()
    c = build(tmp_path, site, "site", wall).test_client()
    c.set_cookie("site_riffbox", cookie(site))
    assert "site_riffbox" not in c.get("/api/session").headers.get("Set-Cookie", "")
    wall.t = NOW + 2 * 3600
    r = c.get("/api/session")
    assert "site_riffbox=" in r.headers["Set-Cookie"] and "HttpOnly" in r.headers["Set-Cookie"]


# ---- safeguards that apply whatever the mode -----------------------------------------------------------------
def test_login_body_is_limited_so_strangers_cannot_make_it_read_300mb(client):
    r = client.post("/api/login", data=b'{"passphrase": "' + b"x" * 10000 + b'"}', content_type="application/json")
    assert r.status_code == 413


def test_other_routes_still_accept_big_bodies(authed):
    assert upload(authed, make_wav(2.0)).status_code == 201


def test_failed_token_guesses_are_counted_and_then_refused(client):
    for _ in range(20):
        assert upload(client, make_wav(), token="guess").status_code == 401
    assert upload(client, make_wav(), token=TOKEN).status_code == 401           # that client is now refused, even with the right token
    assert upload(client, make_wav(), token=TOKEN).status_code == 401
    r = client.post("/api/upload", data={"file": (__import__("io").BytesIO(make_wav()), "a.wav")}, headers={"Authorization": f"Bearer {TOKEN}", "X-Forwarded-For": "5.5.5.5"},
                    content_type="multipart/form-data")
    assert r.status_code == 201                                                # a different client is unaffected


def test_cross_origin_state_changes_are_refused(authed):
    assert authed.post("/api/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert authed.post("/api/logout", headers={"Origin": "null"}).status_code == 403
    assert authed.post("/api/tags", json={"name": "x"}, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert authed.post("/api/tags", json={"name": "x"}, headers={"Origin": "http://localhost"}).status_code == 201
    assert authed.post("/api/tags", json={"name": "y"}).status_code == 201       # no Origin: the phone Shortcut, curl, tests


def test_strict_security_headers_on_every_answer(client):
    r = client.get("/api/auth-info")
    csp = r.headers["Content-Security-Policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp and "'unsafe-inline'" not in csp
    assert r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["Referrer-Policy"] == "same-origin"


def test_every_route_is_protected_or_on_the_public_list(app):
    """Fail closed: a new route must either use @require_auth or be added to this short list on purpose."""
    public = {"riffbox.login", "riffbox.logout", "riffbox.auth_info", "riffbox.health", "riffbox.index", "riffbox.static_files",
              "base_redirect", "riffbox.static_root"}
    client = app.test_client()
    unprotected = []
    for rule in app.url_map.iter_rules():
        if rule.endpoint in public or "GET" not in rule.methods:
            continue
        url = __import__("re").sub(r"<[^>]+>", "1", rule.rule)
        if client.get(url).status_code not in (401, 404, 405):
            unprotected.append(rule.endpoint)
    assert unprotected == [], f"routes answering without a login: {unprotected}"

def test_site_mode_refuses_an_old_local_session_but_keeps_the_phone_token(tmp_path, site):
    """After RIFFBOX_AUTH=site: a session cookie from the old passphrase login stops working, the Shortcut's Bearer token still uploads."""
    both = build(tmp_path, site, "both").test_client()
    assert both.post("/api/login", json={"passphrase": PASS}).status_code == 200
    local_cookie = both.get_cookie("session")
    assert local_cookie is not None and both.get("/api/session").status_code == 200
    c = build(tmp_path, site, "site").test_client()
    c.set_cookie("session", local_cookie.value)
    assert c.get("/api/session").status_code == 401
    assert c.get("/api/groups").status_code == 401
    assert upload(c, make_wav(2.0)).status_code == 201


@pytest.mark.parametrize("mode", ["both", "site"])
def test_a_missing_site_key_is_logged_loudly_at_start(tmp_path, site, mode, caplog):
    (site / "keys" / "riffbox.key").unlink()
    with caplog.at_level("ERROR"):
        build(tmp_path, site, mode)
    assert "site key" in caplog.text and "RIFFBOX_AUTH=local" in caplog.text


def test_local_mode_does_not_look_for_the_site_key(tmp_path, site, caplog):
    (site / "keys" / "riffbox.key").unlink()
    with caplog.at_level("ERROR"):
        build(tmp_path, site, "local")
    assert "site key" not in caplog.text
