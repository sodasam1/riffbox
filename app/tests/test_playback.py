"""Phase 3.5: ALAC detection, FLAC play copies, migration and backfill."""
import io
import shutil
import sqlite3
import stat
import struct
import subprocess

import pytest

from conftest import PASS, TOKEN
from riffbox import create_app
from riffbox.media import mp4_audio_codec

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not installed")


# ---- synthetic MP4 structures (no ffmpeg needed) -----------------------------------------------
def box(typ, payload=b""):
    return struct.pack(">I4s", 8 + len(payload), typ) + payload


def track(fourcc, handler=b"soun"):
    entry = struct.pack(">I4s", 16, fourcc) + b"\0" * 8
    stsd = box(b"stsd", b"\0\0\0\0" + struct.pack(">I", 1) + entry)
    hdlr = box(b"hdlr", b"\0" * 8 + handler + b"\0" * 13)
    minf = box(b"minf", box(b"stbl", stsd))
    return box(b"trak", box(b"mdia", hdlr + minf))


def mp4(*tracks, moov_first=False, big_mdat=False):
    ftyp = box(b"ftyp", b"M4A \0\0\0\0M4A isom")
    mdat = (struct.pack(">I4sQ", 1, b"mdat", 16 + 100) + b"x" * 100) if big_mdat else box(b"mdat", b"x" * 100)
    moov = box(b"moov", b"".join(tracks))
    return ftyp + (moov + mdat if moov_first else mdat + moov)


def write(tmp_path, data, name="a.m4a"):
    p = tmp_path / name
    p.write_bytes(data)
    return p


@pytest.mark.parametrize("fourcc,expected", [(b"alac", "alac"), (b"mp4a", "aac"), (b"ac-3", "ac-3")])
def test_codec_from_sample_entry(tmp_path, fourcc, expected):
    assert mp4_audio_codec(write(tmp_path, mp4(track(fourcc)))) == expected


def test_moov_before_or_after_mdat_and_64bit_boxes(tmp_path):
    for kw in ({"moov_first": True}, {"big_mdat": True}, {"moov_first": True, "big_mdat": True}):
        assert mp4_audio_codec(write(tmp_path, mp4(track(b"alac"), **kw))) == "alac"


def test_skips_video_tracks_and_finds_the_audio_one(tmp_path):
    data = mp4(track(b"avc1", handler=b"vide"), track(b"alac"))
    assert mp4_audio_codec(write(tmp_path, data)) == "alac"


def test_unreadable_inputs_give_none_not_a_crash(tmp_path):
    good = mp4(track(b"alac"))
    assert mp4_audio_codec(write(tmp_path, b"")) is None
    assert mp4_audio_codec(write(tmp_path, b"not an mp4 at all" * 50)) is None
    assert mp4_audio_codec(write(tmp_path, good[:-30])) is None            # truncated moov
    assert mp4_audio_codec(write(tmp_path, mp4())) is None                 # moov with no tracks
    assert mp4_audio_codec(tmp_path / "missing.m4a") is None
    huge = box(b"ftyp", b"M4A ") + struct.pack(">I4s", 0xFFFFFFF0, b"moov") + b"\0" * 64
    assert mp4_audio_codec(write(tmp_path, huge)) is None                  # absurd box size


# ---- real files ---------------------------------------------------------------------------------
def make_m4a(tmp_path, codec, name):
    out = tmp_path / name
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
                    "-ac", "2", "-c:a", codec, str(out)], check=True)
    return out.read_bytes()


def pcm(path_or_bytes, tmp_path):
    src = tmp_path / "pcm-src"
    src.write_bytes(path_or_bytes if isinstance(path_or_bytes, bytes) else path_or_bytes.read_bytes())
    return subprocess.run([FFMPEG, "-v", "error", "-i", str(src), "-f", "s16le", "-"],
                          capture_output=True, check=True).stdout


@needs_ffmpeg
def test_real_ffmpeg_files_are_classified(tmp_path):
    assert mp4_audio_codec(write(tmp_path, make_m4a(tmp_path, "alac", "x.m4a"), "alac.m4a")) == "alac"
    assert mp4_audio_codec(write(tmp_path, make_m4a(tmp_path, "aac", "y.m4a"), "aac.m4a")) == "aac"


@pytest.fixture
def make_app(tmp_path):
    made = []

    def factory(**cfg):
        base = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN,
                "PASSPHRASE": PASS, "SECRET_KEY": "k", "SESSION_COOKIE_SECURE": False}
        base.update(cfg)
        app = create_app(base)
        made.append(app)
        return app

    yield factory
    for app in made:
        app.extensions["riffbox"].stop()


def up(client, data, name="memo.m4a"):
    r = client.post("/api/upload", data={"file": (io.BytesIO(data), name)},
                    headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    return r.get_json()["id"]


def settle(app):
    app.extensions["riffbox"].jobs.join()


def listing(client):
    client.post("/api/login", json={"passphrase": PASS})
    return {r["id"]: r for r in client.get("/api/groups").get_json()["groups"]}


@needs_ffmpeg
def test_alac_upload_gets_a_lossless_flac_play_copy(make_app, tmp_path):
    app = make_app()
    c = app.test_client()
    original = make_m4a(tmp_path, "alac", "m.m4a")
    rid = up(c, original)
    settle(app)

    row = listing(c)[rid]
    assert (row["parts"][0]["codec"], row["parts"][0]["play_status"]) == ("alac", "ready")

    r = c.get(f"/api/play/{rid}")                              # the player gets FLAC...
    assert r.status_code == 200 and r.mimetype == "audio/flac" and r.data[:4] == b"fLaC"
    assert pcm(r.data, tmp_path) == pcm(original, tmp_path)    # ...which decodes to identical audio

    part = c.get(f"/api/play/{rid}", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and part.data == r.data[:100]
    assert part.headers["Cache-Control"] == "private, no-cache"  # answer changes once the copy exists

    assert c.get(f"/api/audio/{rid}").data == original          # the original is untouched
    dl = c.get(f"/api/audio/{rid}?download=1")
    assert dl.data == original and "memo.m4a" in dl.headers["Content-Disposition"]
    assert not list(app.config["AUDIO_DIR"].glob(".incoming-*"))


@needs_ffmpeg
def test_aac_upload_needs_no_copy_and_plays_original(make_app, tmp_path):
    app = make_app()
    c = app.test_client()
    original = make_m4a(tmp_path, "aac", "m.m4a")
    rid = up(c, original)
    settle(app)
    row = listing(c)[rid]
    assert (row["parts"][0]["codec"], row["parts"][0]["play_status"]) == ("aac", None)
    assert c.get(f"/api/play/{rid}").data == original
    assert not list(app.config["AUDIO_DIR"].glob("*.flac"))


def test_non_mp4_uploads_are_marked_not_applicable(make_app):
    app = make_app()
    c = app.test_client()
    rid = up(c, b"RIFF....WAVE" + b"\0" * 64, "x.wav")
    assert listing(c)[rid]["parts"][0]["codec"] == "n/a"


@needs_ffmpeg
def test_failed_conversion_is_recorded_and_playback_falls_back(make_app, tmp_path):
    fake = tmp_path / "fake-ffmpeg"
    fake.write_text("#!/bin/sh\necho boom >&2\nexit 1\n")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    app = make_app(FFMPEG=str(fake))
    c = app.test_client()
    original = make_m4a(tmp_path, "alac", "m.m4a")
    rid = up(c, original)
    settle(app)
    assert listing(c)[rid]["parts"][0]["play_status"] == "failed"
    assert c.get(f"/api/play/{rid}").data == original
    assert not list(app.config["AUDIO_DIR"].glob("*.flac"))
    assert not list(app.config["AUDIO_DIR"].glob(".incoming-*"))
    err = sqlite3.connect(app.config["DB_PATH"]).execute(
        "SELECT play_error FROM recordings WHERE id=?", (rid,)).fetchone()[0]
    assert "boom" in err
    assert "play_error" not in listing(c)[rid]                  # internal detail is never sent to the UI


@needs_ffmpeg
def test_without_ffmpeg_alac_still_uploads_then_converts_after_ffmpeg_is_installed(make_app, tmp_path):
    first = make_app(FFMPEG="")
    c = first.test_client()
    original = make_m4a(tmp_path, "alac", "m.m4a")
    rid = up(c, original)
    settle(first)
    row = listing(c)[rid]
    assert (row["parts"][0]["codec"], row["parts"][0]["play_status"]) == ("alac", None)         # nothing to convert with yet
    assert c.get(f"/api/play/{rid}").data == original                    # still playable where supported
    first.extensions["riffbox"].stop()

    second = make_app(FFMPEG=FFMPEG)                                    # "install ffmpeg, restart"
    settle(second)
    c2 = second.test_client()
    assert listing(c2)[rid]["parts"][0]["play_status"] == "ready"                   # (listing also logs in)
    assert c2.get(f"/api/play/{rid}").data[:4] == b"fLaC"


@needs_ffmpeg
def test_database_from_before_phase_3_5_is_migrated_and_backfilled(make_app, tmp_path):
    data = tmp_path / "data"
    (data / "audio").mkdir(parents=True)
    alac = make_m4a(tmp_path, "alac", "old.m4a")
    (data / "audio" / "old1.m4a").write_bytes(alac)
    conn = sqlite3.connect(data / "riffbox.db")
    conn.executescript("""
      CREATE TABLE recordings (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
        orig_filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        duration_s REAL, peaks TEXT, recorded_at TEXT NOT NULL, uploaded_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'inbox', tempo TEXT, bpm INTEGER, key_root TEXT, key_mode TEXT,
        notes TEXT NOT NULL DEFAULT '', rating TEXT, used_in TEXT, last_played_at TEXT, deleted_at TEXT);
    """)
    conn.execute("INSERT INTO recordings (title, filename, orig_filename, mime, size, sha256,"
                 " recorded_at, uploaded_at) VALUES ('Old memo','old1.m4a','Old.m4a','audio/mp4',?,"
                 "'abc','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", (len(alac),))
    conn.commit()
    conn.close()

    app = make_app()                                                    # starts on the old database
    settle(app)
    c = app.test_client()
    row = listing(c)[1]
    assert row["title"] == "Old memo"                                   # existing data intact
    assert (row["parts"][0]["codec"], row["parts"][0]["play_status"]) == ("alac", "ready")      # examined and converted
    assert c.get("/api/play/1").data[:4] == b"fLaC"


def test_play_endpoint_requires_a_session_and_404s_cleanly(make_app):
    app = make_app()
    c = app.test_client()
    assert c.get("/api/play/1").status_code == 401
    c.post("/api/login", json={"passphrase": PASS})
    assert c.get("/api/play/999").status_code == 404
