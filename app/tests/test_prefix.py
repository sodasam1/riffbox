import io

from conftest import PASS, TOKEN, make_wav


def test_everything_lives_under_prefix(prefixed_app):
    c = prefixed_app.test_client()
    assert c.get("/ideas/health").get_json() == {"status": "ok"}
    assert c.get("/health").status_code == 404          # not exposed at the site root
    assert c.get("/api/recordings").status_code == 404


def test_bare_prefix_redirects_with_relative_location(prefixed_app):
    r = prefixed_app.test_client().get("/ideas")
    assert r.status_code == 302
    assert r.headers["Location"] == "/ideas/"           # relative: stays https behind relayd


def test_index_and_static_served(prefixed_app):
    c = prefixed_app.test_client()
    assert b"Riffbox" in c.get("/ideas/").data
    assert c.get("/ideas/static/../app/wsgi.py").status_code == 404   # no traversal


def test_login_cookie_is_scoped_to_prefix(prefixed_app):
    c = prefixed_app.test_client()
    r = c.post("/ideas/api/login", json={"passphrase": PASS})
    assert r.status_code == 200
    cookie = r.headers["Set-Cookie"]
    assert "Path=/ideas" in cookie and "HttpOnly" in cookie


def test_upload_and_range_under_prefix(prefixed_app):
    c = prefixed_app.test_client()
    data = make_wav(seconds=2)
    r = c.post("/ideas/api/upload", data={"file": (io.BytesIO(data), "a.m4a")},
               headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
    assert r.status_code == 201
    c.post("/ideas/api/login", json={"passphrase": PASS})
    r = c.get("/ideas/api/audio/1", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and r.data == data[:100]
