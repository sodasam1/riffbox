"""Compressed text answers and fingerprinted, long-cached page files."""
import gzip
import json
import re
import shutil
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app, webcache

STATIC = Path(__file__).resolve().parents[2] / "static"
GZ = {"Accept-Encoding": "gzip, deflate, br"}


def test_accept_encoding_is_read_carefully():
    ok = webcache.accepts_gzip
    assert ok("gzip") and ok("gzip, deflate, br") and ok("deflate, gzip;q=0.5") and ok("*")
    assert not ok("") and not ok(None) and not ok("deflate, br") and not ok("gzip;q=0") and not ok("identity")


def test_lists_are_compressed_for_browsers_that_accept_gzip_and_identical_after_unpacking(authed):
    for i in range(12):
        upload(authed, make_wav(freq_seed=i), f"m{i}.wav", title=f"A fairly long title for idea number {i}")
    plain = authed.get("/api/groups")
    zipped = authed.get("/api/groups", headers=GZ)
    assert "Content-Encoding" not in plain.headers
    assert zipped.headers["Content-Encoding"] == "gzip" and "Accept-Encoding" in zipped.headers["Vary"]
    assert gzip.decompress(zipped.data) == plain.data
    assert len(zipped.data) < len(plain.data) / 3
    assert int(zipped.headers["Content-Length"]) == len(zipped.data)
    assert json.loads(gzip.decompress(zipped.data))["count"] == 12


def test_small_answers_and_non_text_are_left_alone(authed):
    small = authed.get("/api/tags", headers=GZ)
    assert "Content-Encoding" not in small.headers                       # too small to be worth it
    rid = upload(authed, make_wav(freq_seed=1), "a.wav").get_json()["id"]
    audio = authed.get(f"/api/audio/{rid}", headers=GZ)
    assert "Content-Encoding" not in audio.headers and audio.data[:4] == b"RIFF"
    ranged = authed.get(f"/api/play/{rid}", headers={**GZ, "Range": "bytes=0-9"})
    assert ranged.status_code == 206 and "Content-Encoding" not in ranged.headers and len(ranged.data) == 10
    exp = authed.get("/api/export.zip", headers=GZ)
    assert "Content-Encoding" not in exp.headers and exp.data[:2] == b"PK"


def test_errors_and_login_still_work_with_compression(client):
    r = client.get("/api/groups", headers=GZ)
    assert r.status_code == 401
    assert client.post("/api/login", json={"passphrase": "wrong"}, headers=GZ).status_code in (401, 429)


def test_the_page_names_each_file_by_its_fingerprint(client):
    page = client.get("/").get_data(as_text=True)
    found = dict(re.findall(r'(?:src|href)="static/([\w.]+)\?v=([0-9a-f]{12})"', page))
    assert set(found) == {"theme.js", "style.css", "app.js"}
    for name, v in found.items():
        assert v == webcache.PageFiles(STATIC).read(name)[2]


def test_a_fingerprinted_file_is_kept_for_a_year_a_bare_one_is_rechecked(client):
    v = re.search(r'static/app\.js\?v=([0-9a-f]+)', client.get("/").get_data(as_text=True)).group(1)
    kept = client.get(f"/static/app.js?v={v}")
    assert "max-age=31536000" in kept.headers["Cache-Control"] and "immutable" in kept.headers["Cache-Control"]
    assert kept.mimetype == "text/javascript"
    bare = client.get("/static/app.js")
    assert bare.headers["Cache-Control"] == "no-cache" and bare.data == kept.data
    index = client.get("/")
    assert index.headers["Cache-Control"] == "no-cache" and index.mimetype == "text/html"


def test_repeat_visits_get_not_modified_for_the_page_and_its_files(client):
    for path in ("/", "/static/app.js", "/static/style.css"):
        first = client.get(path, headers=GZ)
        assert first.status_code == 200 and first.headers["Content-Encoding"] == "gzip"
        again = client.get(path, headers={**GZ, "If-None-Match": first.headers["ETag"]})
        assert again.status_code == 304 and again.data == b""
        plain_again = client.get(path, headers={"If-None-Match": first.headers["ETag"]})      # same validator whichever encoding is asked for
        assert plain_again.status_code == 304


def test_static_files_unpack_to_exactly_the_file_on_disk(client):
    for name in ("app.js", "style.css", "theme.js"):
        r = client.get(f"/static/{name}", headers=GZ)
        assert gzip.decompress(r.data) == (STATIC / name).read_bytes() if "Content-Encoding" in r.headers else r.data == (STATIC / name).read_bytes()
    assert client.get("/static/app.js").data == (STATIC / "app.js").read_bytes()


def test_a_changed_file_gets_a_new_fingerprint_without_restarting(tmp_path):
    static = tmp_path / "static"
    shutil.copytree(STATIC, static)
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "d"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
                      "SESSION_COOKIE_SECURE": False, "STATIC_DIR": str(static), "FFMPEG": ""})
    c = app.test_client()
    pat = re.compile(r"static/app\.js\?v=([0-9a-f]+)")
    before = pat.search(c.get("/").get_data(as_text=True)).group(1)
    (static / "app.js").write_text((static / "app.js").read_text() + "\n// changed\n")
    after = pat.search(c.get("/").get_data(as_text=True)).group(1)
    assert before != after
    assert b"// changed" in c.get(f"/static/app.js?v={after}").data


def test_only_plain_files_in_the_static_folder_are_served_and_the_rest_is_refused(client):
    assert client.get("/static/nope.js").status_code == 404
    assert client.get("/static/../riffbox/about.html").status_code == 404
    assert client.get("/static/.hidden.js").status_code == 404
    assert client.get("/static/sub/dir.js").status_code == 404


def test_lists_can_be_revalidated_and_come_back_not_modified_until_something_changes(authed):
    upload(authed, make_wav(freq_seed=1), "a.wav", title="First")
    first = authed.get("/api/groups?status=inbox", headers=GZ)
    assert first.status_code == 200 and first.headers["Cache-Control"] == "private, no-cache" and first.headers["ETag"].startswith('W/"')
    again = authed.get("/api/groups?status=inbox", headers={**GZ, "If-None-Match": first.headers["ETag"]})
    assert again.status_code == 304 and again.data == b""
    assert authed.get("/api/groups?status=inbox", headers={"If-None-Match": first.headers["ETag"]}).status_code == 304     # either encoding
    upload(authed, make_wav(freq_seed=2), "b.wav", title="Second")                                                        # a change: a new answer
    changed = authed.get("/api/groups?status=inbox", headers={**GZ, "If-None-Match": first.headers["ETag"]})
    assert changed.status_code == 200 and changed.headers["ETag"] != first.headers["ETag"]
    assert json.loads(gzip.decompress(changed.data))["count"] == 2
    other = authed.get("/api/groups?status=tagged", headers={"If-None-Match": first.headers["ETag"]})                     # another list is not "not modified"
    assert other.status_code == 200
    for path in ("/api/tags", "/api/trash"):
        r = authed.get(path)
        assert r.headers["ETag"] and authed.get(path, headers={"If-None-Match": r.headers["ETag"]}).status_code == 304
    assert "ETag" not in authed.get("/api/resurface").headers                                                              # that one is never kept


def test_revalidated_lists_do_not_vary_by_cookie_but_the_login_still_renews(authed):
    """The login cookie changes on every answer; a "Vary: Cookie" would make no saved copy ever match again."""
    for path in ("/api/groups", "/api/tags", "/api/trash"):
        r = authed.get(path, headers=GZ)
        assert "Cookie" not in r.headers.get("Vary", "") and "Accept-Encoding" in r.headers.get("Vary", "")
        assert r.headers.get("Set-Cookie", "").startswith("session=")                    # the sliding 60-day login is unchanged
    assert "Cookie" in authed.get("/api/session").headers.get("Vary", "")                # everything else behaves as before
