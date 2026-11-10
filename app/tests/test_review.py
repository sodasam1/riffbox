"""Bugs found in the whole-code review: each test fails on the code as it was before the fix."""
import pytest

from conftest import make_wav, upload
from riffbox import create_app, parse_iso


@pytest.mark.parametrize("stamp", ["0001-01-01T00:00:00+05:00", "9999-12-31T23:59:59-05:00"])
def test_extreme_timestamps_are_rejected_not_a_server_error(authed, stamp):
    assert parse_iso(stamp) is None
    rid = upload(authed, make_wav(), "a.wav", title="x").get_json()["id"]
    r = authed.patch(f"/api/recordings/{rid}", json={"recorded_at": stamp})
    assert r.status_code == 400
    r = upload(authed, make_wav(freq_seed=3), "b.wav", recorded_at=stamp)       # the upload form just ignores it
    assert r.status_code == 201


def test_search_ignores_case_beyond_ascii(authed):
    ids = {}
    for seed, title in enumerate(["Été en Provence", "zebra riff", "Ångström theme"]):
        ids[title] = upload(authed, make_wav(freq_seed=seed), f"{seed}.wav", title=title).get_json()["id"]
    got = authed.get("/api/groups?q=%C3%A9t%C3%A9").get_json()["groups"]          # "été"
    assert [r["title"] for r in got] == ["Été en Provence"]
    got = authed.get("/api/groups?q=%C3%85NGSTR%C3%96M").get_json()["groups"]     # "ÅNGSTRÖM"
    assert [r["title"] for r in got] == ["Ångström theme"]


def test_half_written_uploads_are_swept_at_start_up(tmp_path):
    data = tmp_path / "data"
    (data / "audio").mkdir(parents=True)
    stale = data / "audio" / ".incoming-abc123"
    stale.write_bytes(b"x" * 10)
    app = create_app({"TESTING": True, "DATA_DIR": str(data), "SECRET_KEY": "k", "PASSPHRASE": "p"})
    try:
        assert not stale.exists()
    finally:
        app.extensions["riffbox"].stop()


def test_counts_and_total_still_agree(authed):
    a = upload(authed, make_wav(freq_seed=1), "a.wav").get_json()["id"]
    b = upload(authed, make_wav(freq_seed=2), "b.wav").get_json()["id"]
    authed.patch(f"/api/recordings/{a}", json={"rating": "heart", "status": "tagged"})
    body = authed.get("/api/groups?status=tagged").get_json()
    assert (body["total"], body["ratings"]) == (1, {"heart": 1, "check": 0, "x": 0, "none": 0})
    body = authed.get("/api/groups?status=inbox").get_json()
    assert (body["total"], body["ratings"]["none"], b) == (1, 1, b)
    assert authed.get("/api/groups").get_json()["total"] == 2


def test_responses_say_nosniff(authed):
    assert authed.get("/api/groups").headers["X-Content-Type-Options"] == "nosniff"


def test_identical_uploads_at_the_same_moment_make_one_recording(app):
    import threading
    data = make_wav(freq_seed=9)
    barrier = threading.Barrier(6)
    results = []

    def go():
        c = app.test_client()
        barrier.wait()
        r = upload(c, data, "same.wav")
        results.append((r.status_code, r.get_json().get("duplicate")))

    threads = [threading.Thread(target=go) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [(200, True)] * 5 + [(201, False)], results
    c = app.test_client()
    c.post("/api/login", json={"passphrase": "correct horse"})
    assert c.get("/api/groups").get_json()["total"] == 1


def test_without_ffmpeg_the_player_is_told_there_is_no_waveform(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "d"), "SECRET_KEY": "k", "PASSPHRASE": "p",
                      "UPLOAD_TOKEN": "t", "FFMPEG": "", "SESSION_COOKIE_SECURE": False})
    try:
        c = app.test_client()
        rid = upload(c, make_wav(), "a.wav", token="t").get_json()["id"]
        c.post("/api/login", json={"passphrase": "p"})
        assert c.get(f"/api/recordings/{rid}/analysis").get_json()["peaks"] == []
    finally:
        app.extensions["riffbox"].stop()


def test_big_uploads_are_staged_inside_the_data_directory(app, tmp_path):
    import tempfile
    assert tempfile.gettempdir() == str(app.config["DATA_DIR"] + "/tmp")
