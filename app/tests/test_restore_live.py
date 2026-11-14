"""Restore from inside the app: a backup folder, an unzipped export or an export zip, into an EMPTY library only."""
import hashlib
import time
import zipfile
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import backup as backups
from riffbox import create_app


def cfg_for(tmp_path, name, restore_dir=""):
    return {"TESTING": True, "DATA_DIR": str(tmp_path / name), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
            "SESSION_COOKIE_SECURE": False, "FFMPEG": "", "RESTORE_DIR": str(restore_dir)}


def logged_in(app):
    c = app.test_client()
    assert c.post("/api/login", json={"passphrase": PASS}).status_code == 200
    return c


@pytest.fixture
def old(tmp_path):
    """A library with three recordings (one in the Trash), tags, notes and marks; returns (app, client, wav bytes by title)."""
    app = create_app(cfg_for(tmp_path, "old"))
    c = logged_in(app)
    wavs = {}
    for i, t in enumerate(["First riff", "Café — second", "Gone one"]):
        wavs[t] = make_wav(freq_seed=i)
        rid = upload(c, wavs[t], f"m{i}.wav", title=t).get_json()["id"]
        c.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass", "keys"], "bpm": 100 + i, "notes": f"n{i}\nline",
                                                "rating": "heart", "key_root": "A", "key_mode": "minor"})
    c.delete("/api/recordings/3")
    app.extensions["riffbox"].stop()
    return app, c, wavs


def new_app(tmp_path, drop):
    drop.mkdir(exist_ok=True)
    return create_app(cfg_for(tmp_path, "new", drop))


def wait_done(c, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        d = c.get("/api/restore").get_json()
        if not d["job"]["running"] and d["job"]["finished_at"]:
            return d["job"]
        time.sleep(0.05)
    raise AssertionError("restore did not finish")


def titles_and_audio(app, c):
    import sqlite3
    db = sqlite3.connect(Path(app.config["DATA_DIR"]) / "riffbox.db")
    db.row_factory = sqlite3.Row
    rows = db.execute("SELECT id, title, notes, bpm, filename, sha256, deleted_at FROM recordings ORDER BY id").fetchall()
    out = [(r["id"], r["title"], r["notes"], r["bpm"], r["sha256"], r["deleted_at"] is not None,
            hashlib.sha256((Path(app.config["DATA_DIR"]) / "audio" / r["filename"]).read_bytes()).hexdigest()) for r in rows]
    db.close()
    return out


def test_restore_from_a_backup_folder_brings_everything_back(tmp_path, old):
    oldapp, oc, wavs = old
    drop = tmp_path / "drop"
    backups.backup(oldapp.config["DATA_DIR"], drop / "my-backup")                      # the folder the owner pulled and uploads again
    app = new_app(tmp_path, drop)
    c = logged_in(app)
    st = c.get("/api/restore").get_json()
    assert st["available"] and st["library_empty"] and st["found"]["layout"] == "backup" and st["found"]["recordings"] == 3
    assert c.post("/api/restore").status_code == 202
    job = wait_done(c)
    assert job["ok"] and "Restored 3" in job["message"], job
    assert titles_and_audio(app, c) == titles_and_audio(oldapp, oc)                    # identical rows, notes, checksums and audio bytes
    d = c.get("/api/data").get_json()
    assert d["recordings"] == 2 and d["trashed"] == 1                                  # the Trash came back as the Trash
    assert c.get("/api/audio/1").data == wavs["First riff"]                           # playable through the normal route
    assert c.get("/api/restore").get_json()["library_empty"] is False                  # and now restoring is switched off


def test_restore_refuses_when_the_library_has_recordings(tmp_path, old):
    oldapp, _, _ = old
    drop = tmp_path / "drop"
    backups.backup(oldapp.config["DATA_DIR"], drop / "b")
    app = new_app(tmp_path, drop)
    c = logged_in(app)
    upload(c, make_wav(freq_seed=77), "mine.wav", title="Already here")
    before = titles_and_audio(app, c)
    r = c.post("/api/restore")
    assert r.status_code == 409 and "empty" in r.get_json()["error"]
    assert titles_and_audio(app, c) == before                                          # nothing was touched
    assert c.get("/api/restore").get_json()["library_empty"] is False


def test_restore_from_an_unzipped_export_and_from_the_zip(tmp_path, old):
    oldapp, oc, _ = old
    z = oc.get("/api/export.zip?trash=1")
    assert z.status_code == 200
    for variant in ("zip", "folder"):
        drop = tmp_path / f"drop-{variant}"
        drop.mkdir()
        zpath = drop / "riffbox-export-20261114.zip"
        zpath.write_bytes(z.data)
        if variant == "folder":
            with zipfile.ZipFile(zpath) as zf:
                zf.extractall(drop)
            zpath.unlink()
        cfg = cfg_for(tmp_path, f"new-{variant}", drop)
        app = create_app(cfg)
        c = logged_in(app)
        assert c.get("/api/restore").get_json()["found"]["layout"] == ("zip" if variant == "zip" else "export")
        assert c.post("/api/restore").status_code == 202
        job = wait_done(c)
        assert job["ok"] and "Restored 3" in job["message"], (variant, job)
        assert [(t[1], t[2], t[3], t[6]) for t in titles_and_audio(app, c)] == [(t[1], t[2], t[3], t[6]) for t in titles_and_audio(oldapp, oc)]


def test_missing_and_damaged_audio_are_reported_not_hidden(tmp_path, old):
    oldapp, _, _ = old
    drop = tmp_path / "drop"
    dest = drop / "b"
    backups.backup(oldapp.config["DATA_DIR"], dest)
    files = sorted((dest / "audio").iterdir())
    files[0].unlink()                                                                    # one audio file is missing
    files[1].write_bytes(files[1].read_bytes() + b"x")                                   # one is damaged
    app = new_app(tmp_path, drop)
    c = logged_in(app)
    assert c.post("/api/restore").status_code == 202
    job = wait_done(c)
    assert job["ok"] is False and len(job["missing"]) == 1 and len(job["damaged"]) == 1
    assert "Restored 2" in job["message"]


def test_nothing_usable_in_the_folder(tmp_path):
    drop = tmp_path / "drop"
    drop.mkdir()
    (drop / "random.txt").write_text("not a backup")
    c = logged_in(new_app(tmp_path, drop))
    st = c.get("/api/restore").get_json()
    assert st["available"] and st["found"] is None
    r = c.post("/api/restore")
    assert r.status_code == 409 and "no backup or export" in r.get_json()["error"]


def test_missing_drop_folder_means_not_available(tmp_path):
    app = create_app(cfg_for(tmp_path, "d", tmp_path / "does-not-exist"))
    c = logged_in(app)
    assert c.get("/api/restore").get_json()["available"] is False


def test_restore_needs_a_login_and_the_phone_token_cannot_use_it(tmp_path):
    app = new_app(tmp_path, tmp_path / "drop")
    anon = app.test_client()
    assert anon.get("/api/restore").status_code == 401
    assert anon.post("/api/restore").status_code == 401
    tok = {"Authorization": f"Bearer {TOKEN}"}
    assert anon.get("/api/restore", headers=tok).status_code == 401
    assert anon.post("/api/restore", headers=tok).status_code == 401


def test_a_failed_restore_leaves_the_library_empty_and_can_be_retried(tmp_path, old, monkeypatch):
    oldapp, _, _ = old
    drop = tmp_path / "drop"
    backups.backup(oldapp.config["DATA_DIR"], drop / "b")
    app = new_app(tmp_path, drop)
    c = logged_in(app)
    import riffbox.restorer as r
    real = r.shutil.copy2
    calls = {"n": 0}

    def flaky(src, dst, *a, **kw):                  # the third file copied fails, as a full disk would
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("disk full")
        return real(src, dst, *a, **kw)
    monkeypatch.setattr(r.shutil, "copy2", flaky)
    assert c.post("/api/restore").status_code == 202
    job = wait_done(c)
    assert job["ok"] is False and "disk full" in job["message"] and "not changed" in job["message"]
    assert c.get("/api/restore").get_json()["library_empty"] is True              # the database was never replaced
    monkeypatch.undo()
    assert c.post("/api/restore").status_code == 202                              # simply run it again
    assert "Restored 3" in wait_done(c)["message"]


def test_the_restore_function_itself_refuses_a_library_that_has_recordings(tmp_path, old):
    """The API checks first, but the function that does the work must hold the rule on its own."""
    import sqlite3
    from riffbox import migrations, restorer
    oldapp, _, _ = old
    backups.backup(oldapp.config["DATA_DIR"], tmp_path / "drop" / "b")
    live = sqlite3.connect(Path(oldapp.config["DATA_DIR"]) / "riffbox.db")           # a library that already has recordings
    try:
        with pytest.raises(ValueError, match="empty"):
            restorer.restore_into_live(tmp_path / "drop", oldapp.config["DATA_DIR"], live, migrations.run, tmp_path / "scratch")
    finally:
        live.close()
