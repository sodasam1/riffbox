"""The "Backup and export" page's server side: overview, zip download, database download, Back up now."""
import hashlib
import io
import time
import zipfile

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app


@pytest.fixture
def lib(tmp_path):
    def build(**extra):
        app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS,
                          "SECRET_KEY": "k", "SESSION_COOKIE_SECURE": False, "FFMPEG": "", **extra})
        c = app.test_client()
        c.post("/api/login", json={"passphrase": PASS})
        for i, t in enumerate(["First riff", "Second, with \"quotes\"", "trashed one"]):
            rid = upload(c, make_wav(freq_seed=i), f"m{i}.wav", title=t).get_json()["id"]
            c.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass"], "notes": f"note {i}"})
        c.delete("/api/recordings/3")
        return app, c
    apps = []

    def factory(**extra):
        app, c = build(**extra)
        apps.append(app)
        return app, c
    yield factory
    for a in apps:
        a.extensions["riffbox"].stop()


def test_everything_needs_a_login_and_the_upload_token_is_not_enough(lib):
    app, c = lib()
    anon = app.test_client()
    for method, url in (("get", "/api/data"), ("get", "/api/export.zip"), ("get", "/api/export/database"), ("post", "/api/backup")):
        assert getattr(anon, method)(url).status_code == 401
        assert getattr(anon, method)(url, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_overview_counts_library_trash_and_audio_size(lib):
    _, c = lib()
    body = c.get("/api/data").get_json()
    assert (body["recordings"], body["trashed"], body["backup"]) == (2, 1, None)
    assert body["audio_bytes"] == 3 * len(make_wav())


def test_zip_download_is_a_complete_valid_export(lib):
    _, c = lib()
    r = c.get("/api/export.zip")
    assert r.status_code == 200 and r.mimetype == "application/zip"
    assert "riffbox-export-" in r.headers["Content-Disposition"] and r.headers["Cache-Control"] == "no-store"
    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert z.testzip() is None
    names = z.namelist()
    root = names[0].split("/")[0]
    assert all(n.startswith(root + "/") for n in names)
    rel = {n[len(root) + 1:] for n in names}
    assert {"README.txt", "index.html", "index.csv", "riffbox.db", "manifest-sha256.txt"} <= rel
    assert len([n for n in rel if n.endswith(".md")]) == 2 and not any("PROBLEMS" in n for n in rel)       # trash left out
    for line in z.read(f"{root}/manifest-sha256.txt").decode().splitlines():
        digest, name = line.split("  ", 1)
        assert hashlib.sha256(z.read(f"{root}/{name}")).hexdigest() == digest, name
    note = next(z.read(n).decode() for n in names if n.endswith(".md") and "First riff" in n)
    assert 'title: "First riff"' in note and note.rstrip().endswith("note 0")
    assert any(hashlib.sha256(z.read(n)).hexdigest() == hashlib.sha256(make_wav(freq_seed=0)).hexdigest()
               for n in names if n.endswith(".wav"))                       # the audio is the original, byte for byte
    assert len([n for n in names if n.endswith(".wav")]) == 2
    assert len(c.get("/api/export.zip?trash=1").data) > len(r.data)
    assert len([n for n in zipfile.ZipFile(io.BytesIO(c.get("/api/export.zip?trash=1").data)).namelist() if n.endswith(".md")]) == 3


def test_zip_matches_the_command_line_export_and_flags_damage(lib, tmp_path):
    import subprocess
    import sys
    from pathlib import Path
    app, c = lib()
    data = Path(app.config["DATA_DIR"])
    cli = tmp_path / "cli"
    subprocess.run([sys.executable, "-I", str(Path(__file__).resolve().parents[2] / "deploy" / "export.py"), str(data), str(cli)],
                   check=True, capture_output=True)
    z = zipfile.ZipFile(io.BytesIO(c.get("/api/export.zip").data))
    root = z.namelist()[0].split("/")[0]
    web = {n[len(root) + 1:]: z.read(n) for n in z.namelist()}
    disk = {p.relative_to(cli).as_posix(): p.read_bytes() for p in cli.rglob("*") if p.is_file()}
    assert web.keys() == disk.keys()
    assert all(web[k] == disk[k] for k in web)
    victim = next((data / "audio").glob("*.wav"))
    victim.write_bytes(victim.read_bytes() + b"x")
    z = zipfile.ZipFile(io.BytesIO(c.get("/api/export.zip").data))
    assert any(n.endswith("PROBLEMS.txt") and b"checksum differs" in z.read(n) for n in z.namelist())


def test_database_download_is_a_consistent_sqlite_file(lib, tmp_path):
    import sqlite3
    _, c = lib()
    r = c.get("/api/export/database")
    assert r.status_code == 200 and "riffbox-" in r.headers["Content-Disposition"]
    p = tmp_path / "dl.db"
    p.write_bytes(r.data)
    assert sqlite3.connect(p).execute("SELECT COUNT(*) FROM recordings").fetchone()[0] == 3


def test_back_up_now_is_off_until_a_folder_is_configured(lib):
    _, c = lib()
    assert c.post("/api/backup").status_code == 404


def test_back_up_now_runs_in_the_background_and_reports(lib, tmp_path):
    dest = tmp_path / "bk"
    _, c = lib(BACKUP_DIR=str(dest))
    first = c.get("/api/data").get_json()["backup"]
    assert (first["copies"], first["latest"], first["audio_missing"], first["audio_total"]) == (0, None, 3, 3)
    assert c.post("/api/backup").status_code in (202, 409)
    for _ in range(100):
        job = c.get("/api/data").get_json()["backup"]["job"]
        if not job["running"] and job["finished_at"]:
            break
        time.sleep(0.05)
    after = c.get("/api/data").get_json()["backup"]
    assert after["job"]["ok"] is True and "3 new audio" in after["job"]["message"]
    assert (after["copies"], after["audio_missing"]) == (1, 0) and after["latest"]
    assert len(list((dest / "audio").iterdir())) == 3


def test_a_failing_backup_is_reported_not_raised(lib, tmp_path):
    blocker = tmp_path / "file-not-folder"
    blocker.write_text("x")
    _, c = lib(BACKUP_DIR=str(blocker / "sub"))
    c.post("/api/backup")
    for _ in range(100):
        job = c.get("/api/data").get_json()["backup"]["job"]
        if not job["running"] and job["finished_at"]:
            break
        time.sleep(0.05)
    assert job["ok"] is False and "failed" in job["message"]


def test_leftover_export_folders_in_the_scratch_area_do_not_stop_start_up(tmp_path):
    data = tmp_path / "data"
    (data / "tmp" / "export-abc").mkdir(parents=True)
    (data / "tmp" / "export-abc" / "riffbox.db").write_bytes(b"x")
    app = create_app({"TESTING": True, "DATA_DIR": str(data), "SECRET_KEY": "k", "PASSPHRASE": "p", "FFMPEG": ""})
    try:
        assert not (data / "tmp" / "export-abc").exists()
    finally:
        app.extensions["riffbox"].stop()
