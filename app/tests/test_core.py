import os

from conftest import PASS, TOKEN, make_wav, upload


# ---- health / auth ---------------------------------------------------------
def test_health(client):
    assert client.get("/health").get_json() == {"status": "ok"}


def test_upload_requires_auth(client):
    assert upload(client, make_wav(), token=None).status_code == 401
    assert upload(client, make_wav(), token="wrong").status_code == 401


def test_bad_login(client):
    assert client.post("/api/login", json={"passphrase": "nope"}).status_code == 401
    assert client.post("/api/login", json={}).status_code == 401


def test_empty_passphrase_config_never_logs_in(app):
    app.config["PASSPHRASE"] = ""
    c = app.test_client()
    assert c.post("/api/login", json={"passphrase": ""}).status_code == 401


def test_audio_and_list_require_session(client):
    assert client.get("/api/audio/1").status_code == 401
    assert client.get("/api/recordings").status_code == 401


def test_token_cannot_read_audio(client):
    upload(client, make_wav())
    r = client.get("/api/audio/1", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 401  # upload token is add-only for audio


def test_session_status(client, authed):
    assert authed.get("/api/session").get_json() == {"ok": True}
    fresh = client.application.test_client()
    assert fresh.get("/api/session").status_code == 401


def test_logout(authed):
    authed.post("/api/logout")
    assert authed.get("/api/recordings").status_code == 401


# ---- upload ----------------------------------------------------------------
def test_upload_stores_file_and_row(client, app):
    data = make_wav()
    r = upload(client, data)
    assert r.status_code == 201
    body = r.get_json()
    assert body["duplicate"] is False
    on_disk = list(app.config["AUDIO_DIR"].glob("*.m4a"))
    assert len(on_disk) == 1
    assert on_disk[0].read_bytes() == data
    # no stray temp files left behind
    assert not list(app.config["AUDIO_DIR"].glob(".incoming-*"))


def test_new_upload_lands_in_inbox_with_defaults(client, authed):
    upload(client, make_wav(), recorded_at="2026-11-08T15:42:00Z")
    rec = authed.get("/api/recordings").get_json()["recordings"][0]
    assert rec["status"] == "inbox"
    assert rec["title"] == "Idea, Nov 8 3:42pm"
    assert rec["recorded_at"] == "2026-11-08T15:42:00Z"
    assert rec["orig_filename"] == "New Recording 12.m4a"
    assert rec["mime"] == "audio/mp4"
    assert rec["rating"] is None and rec["tempo"] is None


def test_custom_title_and_bad_date_fallback(client, authed):
    upload(client, make_wav(), title="  My riff ", recorded_at="garbage")
    rec = authed.get("/api/recordings").get_json()["recordings"][0]
    assert rec["title"] == "My riff"
    assert rec["recorded_at"].endswith("Z")


def test_reupload_is_deduped(client, authed, app):
    data = make_wav()
    first = upload(client, data).get_json()
    second = upload(client, data, name="renamed.m4a")
    assert second.status_code == 200
    assert second.get_json() == {"id": first["id"], "duplicate": True}
    assert len(authed.get("/api/recordings").get_json()["recordings"]) == 1
    assert len(list(app.config["AUDIO_DIR"].iterdir())) == 1


def test_different_files_both_kept(client, authed):
    upload(client, make_wav(freq_seed=1))
    upload(client, make_wav(freq_seed=2))
    assert len(authed.get("/api/recordings").get_json()["recordings"]) == 2


def test_rejects_bad_type_and_empty(client):
    assert upload(client, b"x", name="evil.exe").status_code == 415
    assert upload(client, b"x", name="noext").status_code == 415
    assert upload(client, b"", name="a.m4a").status_code == 400
    assert client.post(
        "/api/upload", headers={"Authorization": f"Bearer {TOKEN}"}
    ).status_code == 400


def test_path_traversal_filename_is_neutralised(client, app):
    r = upload(client, make_wav(), name="../../etc/passwd.m4a")
    assert r.status_code == 201
    for p in app.config["AUDIO_DIR"].iterdir():
        assert p.parent == app.config["AUDIO_DIR"]


def test_upload_via_session_cookie(authed):
    r = upload(authed, make_wav(), token=None)
    assert r.status_code == 201


# ---- audio / Range ---------------------------------------------------------
def test_full_audio_roundtrip(client, authed):
    data = make_wav()
    rid = upload(client, data).get_json()["id"]
    r = authed.get(f"/api/audio/{rid}")
    assert r.status_code == 200
    assert r.data == data
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.mimetype == "audio/mp4"


def test_range_returns_206_with_exact_bytes(client, authed):
    data = make_wav(seconds=2)
    rid = upload(client, data).get_json()["id"]
    r = authed.get(f"/api/audio/{rid}", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.data == data[0:100]
    assert r.headers["Content-Range"] == f"bytes 0-99/{len(data)}"
    assert r.headers["Content-Length"] == "100"


def test_open_ended_and_suffix_ranges(client, authed):
    data = make_wav(seconds=2)
    rid = upload(client, data).get_json()["id"]
    r = authed.get(f"/api/audio/{rid}", headers={"Range": "bytes=1000-"})
    assert r.status_code == 206 and r.data == data[1000:]
    r = authed.get(f"/api/audio/{rid}", headers={"Range": "bytes=-50"})
    assert r.status_code == 206 and r.data == data[-50:]


def test_unsatisfiable_range_is_416(client, authed):
    data = make_wav()
    rid = upload(client, data).get_json()["id"]
    r = authed.get(f"/api/audio/{rid}", headers={"Range": f"bytes={len(data)+10}-"})
    assert r.status_code == 416


def test_download_flag_sets_attachment_with_original_name(client, authed):
    rid = upload(client, make_wav(), name="Bass riff 3.m4a").get_json()["id"]
    r = authed.get(f"/api/audio/{rid}?download=1")
    assert "attachment" in r.headers["Content-Disposition"]
    assert "Bass riff 3.m4a" in r.headers["Content-Disposition"]


def test_missing_audio_404(authed):
    assert authed.get("/api/audio/9999").status_code == 404


def test_audio_file_missing_on_disk_404(client, authed, app):
    rid = upload(client, make_wav()).get_json()["id"]
    for p in app.config["AUDIO_DIR"].glob("*.m4a"):
        os.remove(p)
    assert authed.get(f"/api/audio/{rid}").status_code == 404


# ---- config ----------------------------------------------------------------
def test_refuses_to_start_without_secret(tmp_path):
    import pytest
    from riffbox import create_app
    with pytest.raises(RuntimeError):
        create_app({"DATA_DIR": str(tmp_path), "SECRET_KEY": ""})
