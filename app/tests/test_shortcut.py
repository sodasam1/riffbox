"""The phone Shortcut talks to the upload endpoint: friendly replies, names without extensions, token check."""
import struct

import pytest

from conftest import TOKEN, make_wav, upload


def mp4_head():
    return struct.pack(">I4s", 24, b"ftyp") + b"M4A \0\0\0\0M4A isom" + b"\0" * 64


@pytest.mark.parametrize("data,ext", [
    (make_wav(), ".wav"),
    (mp4_head(), ".m4a"),
    (b"fLaC" + b"\0" * 60, ".flac"),
    (b"OggS" + b"\0" * 60, ".ogg"),
    (b"caff" + b"\0" * 60, ".caf"),
    (b"ID3\x04" + b"\0" * 60, ".mp3"),
    (b"\xff\xfb\x90\x00" + b"\0" * 60, ".mp3"),
    (b"\xff\xf1\x50\x80" + b"\0" * 60, ".aac"),
    (b"FORM\0\0\0\0AIFF" + b"\0" * 60, ".aiff"),
])
def test_a_name_without_an_extension_is_identified_from_the_content(authed, data, ext):
    r = upload(authed, data, name="Idea, Nov 8 3:42pm")
    assert r.status_code == 201, r.get_json()
    row = authed.get("/api/groups").get_json()["groups"][0]
    assert row["parts"][0]["orig_filename"] == "Idea, Nov 8 3:42pm" + ext
    assert ext in authed.get(f"/api/audio/{row['id']}?download=1").headers["Content-Disposition"]


def test_a_name_without_an_extension_that_is_not_audio_is_refused(authed, app):
    r = upload(authed, b"hello this is a text file, not audio", name="notes")
    assert r.status_code == 415 and "audio" in r.get_json()["message"]
    assert not list(app.config["AUDIO_DIR"].iterdir())                 # nothing left behind
    assert upload(authed, make_wav(), name="clip.txt").status_code == 415      # a wrong extension is still refused


def test_replies_carry_a_message_a_shortcut_can_show(client, authed):
    r = upload(client, make_wav(freq_seed=1), name="a.wav", title="Hook idea")
    assert r.status_code == 201 and r.get_json()["message"] == "Uploaded “Hook idea” to the Riffbox Inbox."
    again = upload(client, make_wav(freq_seed=1), name="b.wav")
    assert again.status_code == 200 and "Already in Riffbox as “Hook idea”" in again.get_json()["message"]
    assert "message" in upload(client, b"", name="e.wav").get_json()


def test_a_title_that_is_the_file_name_loses_its_extension(client, authed):
    upload(client, make_wav(freq_seed=2), name="Idea, Nov 8 3:42pm.m4a", title="Idea, Nov 8 3:42pm.m4a")
    assert authed.get("/api/groups").get_json()["groups"][0]["title"] == "Idea, Nov 8 3:42pm"


def test_token_check_for_setting_up_the_shortcut(client):
    assert client.get("/api/token-check").status_code == 401
    assert client.get("/api/token-check", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = client.get("/api/token-check", headers={"Authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200 and "token works" in ok.get_json()["message"]


def test_the_token_still_cannot_read_anything(client):
    upload(client, make_wav(freq_seed=3), name="a.wav")
    auth = {"Authorization": f"Bearer {TOKEN}"}
    for url in ("/api/groups", "/api/data", "/api/trash", "/api/export.zip", "/api/audio/1"):
        assert client.get(url, headers=auth).status_code == 401, url
