"""Phase 6: waveform + length analysis, the 'played' marker, and the length / last-played sorts."""
import io
import json
import shutil
import sqlite3
import stat
import struct
import subprocess

import pytest

from conftest import PASS, TOKEN
from riffbox import create_app
from riffbox.media import PEAK_BINS, analyze_audio, summarize_pcm

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


def pcm(samples):
    return struct.pack(f"<{len(samples)}h", *samples)


# ---- summarize_pcm: pure ---------------------------------------------------------------------------
def test_duration_comes_from_the_sample_count():
    assert summarize_pcm([pcm([1000] * 8000)])[0] == 1.0
    assert summarize_pcm([pcm([1000] * 12000)])[0] == 1.5
    assert summarize_pcm([pcm([1000] * 8001)])[0] == 1.0          # a stray sample doesn't change it visibly


def test_waveform_has_at_most_200_points_and_scales_to_255():
    duration, peaks = summarize_pcm([pcm([500] * 8000 * 10)])      # 10 s of a steady tone
    assert duration == 10.0
    assert len(peaks) == PEAK_BINS == 200
    assert set(peaks) == {255}                                    # loudest slice is always 255


def test_quiet_recordings_are_scaled_up_and_shape_is_kept():
    loud, quiet = [8000] * 8000, [80] * 8000                      # 1 s loud then 1 s 100x quieter
    _, peaks = summarize_pcm([pcm(loud + quiet)])
    half = len(peaks) // 2
    assert min(peaks[:half - 1]) == 255
    assert 0 < max(peaks[half + 1:]) <= 3                         # quiet part is ~1% of the loud part


def test_silence_gives_zeros_and_no_audio_gives_nothing():
    assert summarize_pcm([pcm([0] * 16000)])[1] == [0] * 100      # 100 windows of 20 ms, all silent
    assert summarize_pcm([]) == (0.0, [])
    assert summarize_pcm([b""]) == (0.0, [])


def test_short_audio_gives_fewer_points_not_padding():
    duration, peaks = summarize_pcm([pcm([1000] * 1600)])         # 0.2 s = 10 windows of 20 ms
    assert duration == 0.2 and len(peaks) == 10


def test_chunk_boundaries_do_not_matter_even_mid_sample():
    data = pcm([(i * 37) % 20000 - 10000 for i in range(8000 * 3 + 77)])
    whole = summarize_pcm([data])
    for size in (1, 3, 159, 160, 161, 4097):                      # odd sizes split samples and windows
        pieces = [data[i:i + size] for i in range(0, len(data), size)]
        assert summarize_pcm(pieces) == whole, size


def test_negative_peaks_count_and_the_most_negative_value_is_handled():
    _, peaks = summarize_pcm([pcm([-32768] * 160 + [100] * 160)])
    assert peaks == [255, 1]                                      # -32768 is the loudest; 100 is 1/328 of that


# ---- analyze_audio / the worker (real ffmpeg) -------------------------------------------------------
def tone_then_silence(tmp_path, name="a.wav", ext_args=()):
    out = tmp_path / name
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i",
                    "aevalsrc='if(lt(t,3),0.8*sin(2*PI*440*t),0)':d=6:s=44100",
                    "-ac", "2", *ext_args, str(out)], check=True)
    return out


@needs_ffmpeg
def test_analyze_real_files_in_several_formats(tmp_path):
    for name, args in (("a.wav", ()), ("b.m4a", ("-c:a", "alac")), ("c.m4a", ("-c:a", "aac")),
                       ("d.flac", ()), ("e.mp3", ()), ("f.ogg", ())):
        f = tone_then_silence(tmp_path, name, args)
        ok, duration, peaks, err = analyze_audio(FFMPEG, f)
        assert ok, (name, err)
        assert 5.8 <= duration <= 6.2, (name, duration)           # lossy codecs pad slightly
        assert len(peaks) == 200
        assert min(peaks[5:95]) >= 200, name                      # loud for the first half
        assert max(peaks[110:]) <= 10, name                       # silent for the second half


@needs_ffmpeg
def test_analyze_rejects_garbage_and_wrong_extensions(tmp_path):
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio at all" * 100)
    ok, duration, peaks, err = analyze_audio(FFMPEG, junk)
    assert (ok, duration, peaks) == (False, 0.0, []) and err
    assert analyze_audio(FFMPEG, tmp_path / "x.txt")[0] is False


@needs_ffmpeg
def test_a_playlist_pretending_to_be_audio_is_not_followed(tmp_path):
    """The container is forced from the file extension. Left to guess from the content, ffmpeg would treat
    this 'wav' as a concat playlist and decode the real audio file it points at; forced, it is just a
    broken wav. (Checked by removing the forcing: this test then fails.)"""
    tone_then_silence(tmp_path, "real.wav")
    playlist = tmp_path / "evil.wav"
    playlist.write_text("ffconcat version 1.0\nfile 'real.wav'\n")
    # sanity: unforced, ffmpeg really would follow it, so this test is able to fail
    unforced = subprocess.run([FFMPEG, "-v", "error", "-i", str(playlist), "-f", "null", "-"],
                              capture_output=True)
    assert unforced.returncode == 0, "premise: ffmpeg follows this playlist when left to guess"
    assert analyze_audio(FFMPEG, playlist)[0] is False


@pytest.fixture
def make_app(tmp_path):
    made = []

    def factory(**cfg):
        base = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS,
                "SECRET_KEY": "k", "SESSION_COOKIE_SECURE": False}
        base.update(cfg)
        app = create_app(base)
        made.append(app)
        return app

    yield factory
    for a in made:
        a.extensions["riffbox"].stop()


def upload(client, data, name="memo.wav"):
    r = client.post("/api/upload", data={"file": (io.BytesIO(data), name)},
                    headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def settle(app):
    app.extensions["riffbox"].jobs.join()


def login(client):
    assert client.post("/api/login", json={"passphrase": PASS}).status_code == 200


@needs_ffmpeg
def test_upload_is_measured_in_the_background(make_app, tmp_path):
    app = make_app()
    c = app.test_client()
    rid = upload(c, tone_then_silence(tmp_path).read_bytes())
    settle(app)
    login(c)
    body = c.get(f"/api/recordings/{rid}/analysis").get_json()
    assert 5.9 <= body["duration_s"] <= 6.1
    assert len(body["peaks"]) == 200 and body["peaks"][10] >= 200 and body["peaks"][190] <= 5
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert rec["duration_s"] == body["duration_s"]
    assert "peaks" not in rec                                       # the list never carries the waveform


@needs_ffmpeg
def test_alac_is_both_converted_and_measured(make_app, tmp_path):
    app = make_app()
    c = app.test_client()
    rid = upload(c, tone_then_silence(tmp_path, "m.m4a", ("-c:a", "alac")).read_bytes(), "m.m4a")
    settle(app)
    login(c)
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert rec["play_status"] == "ready" and 5.9 <= rec["duration_s"] <= 6.1


@needs_ffmpeg
def test_unmeasurable_file_is_remembered_not_retried(make_app, tmp_path):
    app = make_app()
    c = app.test_client()
    rid = upload(c, b"definitely not a wav" * 50)
    settle(app)
    login(c)
    assert c.get(f"/api/recordings/{rid}/analysis").get_json() == {"duration_s": None, "peaks": []}
    app.extensions["riffbox"].stop()
    again = make_app()                                              # restart: nothing is queued for it again
    again.extensions["riffbox"].jobs.join()
    with sqlite3.connect(again.config["DB_PATH"]) as conn:
        assert conn.execute("SELECT peaks FROM recordings").fetchone()[0] == "[]"


@needs_ffmpeg
def test_without_ffmpeg_nothing_is_measured_until_it_appears(make_app, tmp_path):
    first = make_app(FFMPEG="")
    c = first.test_client()
    rid = upload(c, tone_then_silence(tmp_path).read_bytes())
    settle(first)
    login(c)
    assert c.get(f"/api/recordings/{rid}/analysis").get_json() == {"duration_s": None, "peaks": None}
    first.extensions["riffbox"].stop()

    second = make_app(FFMPEG=FFMPEG)                                # "ffmpeg installed, service restarted"
    settle(second)
    c2 = second.test_client()
    login(c2)
    body = c2.get(f"/api/recordings/{rid}/analysis").get_json()
    assert body["duration_s"] and len(body["peaks"]) == 200


@needs_ffmpeg
def test_failed_ffmpeg_does_not_break_uploads(make_app, tmp_path):
    fake = tmp_path / "bad-ffmpeg"
    fake.write_text("#!/bin/sh\necho nope >&2\nexit 1\n")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    app = make_app(FFMPEG=str(fake))
    c = app.test_client()
    rid = upload(c, tone_then_silence(tmp_path).read_bytes())
    settle(app)
    login(c)
    assert c.get(f"/api/recordings/{rid}/analysis").get_json()["peaks"] == []
    assert c.get(f"/api/audio/{rid}").status_code == 200            # the recording itself is fine


# ---- analysis endpoint and the "played" marker ------------------------------------------------------
def test_analysis_for_an_unmeasured_recording_and_access_rules(make_app):
    app = make_app(FFMPEG="")
    c = app.test_client()
    rid = upload(c, b"RIFF" + b"\0" * 100)
    assert c.get(f"/api/recordings/{rid}/analysis").status_code == 401
    assert c.get(f"/api/recordings/{rid}/analysis", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401
    login(c)
    assert c.get(f"/api/recordings/{rid}/analysis").get_json() == {"duration_s": None, "peaks": None}
    assert c.get("/api/recordings/9999/analysis").status_code == 404
    assert c.get(f"/api/recordings/{rid}/analysis").headers["Cache-Control"] == "private, no-cache"


def test_played_marker(make_app):
    app = make_app(FFMPEG="")
    c = app.test_client()
    rid = upload(c, b"RIFF" + b"\0" * 100)
    assert c.post(f"/api/recordings/{rid}/played").status_code == 401
    assert c.post(f"/api/recordings/{rid}/played", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401
    login(c)
    assert c.get("/api/recordings").get_json()["recordings"][0]["last_played_at"] is None
    r = c.post(f"/api/recordings/{rid}/played")
    assert r.status_code == 200 and r.get_json()["last_played_at"].endswith("Z")
    assert c.get("/api/recordings").get_json()["recordings"][0]["last_played_at"] == r.get_json()["last_played_at"]
    assert c.post("/api/recordings/9999/played").status_code == 404


# ---- sorting by length and by last played ----------------------------------------------------------
@pytest.fixture
def sortable(make_app):
    app = make_app(FFMPEG="")
    c = app.test_client()
    ids = {name: upload(c, b"RIFF" + bytes([i]) * 100, f"{name}.wav") for i, name in enumerate("abcd")}
    with sqlite3.connect(app.config["DB_PATH"]) as conn:
        for name, (dur, played) in {"a": (30.0, "2026-03-01T00:00:00Z"), "b": (5.5, None),
                                    "c": (None, "2026-03-09T00:00:00Z"), "d": (120.0, None)}.items():
            conn.execute("UPDATE recordings SET title=?, duration_s=?, last_played_at=? WHERE id=?",
                         (name, dur, played, ids[name]))
    login(c)

    def titles(**q):
        r = c.get("/api/recordings", query_string=q)
        assert r.status_code == 200, r.get_json()
        return [x["title"] for x in r.get_json()["recordings"]]
    return titles


def test_sort_by_length_unknown_always_last(sortable):
    assert sortable(sort="length") == ["d", "a", "b", "c"]                       # longest first
    assert sortable(sort="length", order="asc") == ["b", "a", "d", "c"]          # shortest first, unknown still last


def test_sort_by_last_played(sortable):
    assert sortable(sort="played") == ["c", "a", "d", "b"]                       # most recent first, never-played last
    asc = sortable(sort="played", order="asc")
    assert set(asc[:2]) == {"b", "d"} and asc[2:] == ["a", "c"]                  # never played, then longest ago first
