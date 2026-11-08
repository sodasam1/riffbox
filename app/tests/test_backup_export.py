"""Phase 8: backup, restore drill and export. The scripts are run exactly as the owner will run them."""
import csv
import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"


def script(name):
    return [sys.executable, "-I", str(DEPLOY / name)]


@pytest.fixture
def populated(tmp_path):
    cfg = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS,
           "SECRET_KEY": "k", "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    app = create_app(cfg)
    c = app.test_client()
    c.post("/api/login", json={"passphrase": PASS})
    titles = ['Riff, "quoted" / odd: name?', "Été — accents", "same title", "same title", "gone"]
    for i, t in enumerate(titles):
        rid = upload(c, make_wav(freq_seed=i), f"m{i}.wav", title=t).get_json()["id"]
        c.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass", "keys"], "bpm": 100 + i,
                                                "notes": f"note {i}\nsecond line", "rating": "heart",
                                                "key_root": "A", "key_mode": "minor"})
    c.delete("/api/recordings/5")
    app.extensions["riffbox"].stop()
    return cfg, tmp_path


def test_backup_then_restore_drill_runs_the_app_from_the_backup(populated):
    cfg, tmp = populated
    dest = tmp / "bk"
    r = subprocess.run(script("backup.py") + [cfg["DATA_DIR"], str(dest)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "5 new audio" in r.stdout
    assert subprocess.run(script("backup.py") + [cfg["DATA_DIR"], str(dest)], capture_output=True, text=True,
                          check=True).stdout.count("0 new audio") == 1          # second run copies nothing

    # the drill: a brand-new data folder holding only what the backup holds
    restored = tmp / "restored"
    (restored / "audio").mkdir(parents=True)
    dbs = sorted((dest / "db").glob("riffbox-*.db"))
    (restored / "riffbox.db").write_bytes(dbs[-1].read_bytes())
    for f in (dest / "audio").iterdir():
        (restored / "audio" / f.name).write_bytes(f.read_bytes())
    app = create_app({**cfg, "DATA_DIR": str(restored)})
    try:
        c = app.test_client()
        c.post("/api/login", json={"passphrase": PASS})
        body = c.get("/api/recordings").get_json()
        assert body["total"] == 4 and body["trashed"] == 1
        first = next(x for x in body["recordings"] if x["title"].startswith("Riff"))
        assert first["tags"] == ["bass", "keys"] and first["notes"] == "note 0\nsecond line"
        assert hashlib.sha256(c.get(f"/api/audio/{first['id']}").data).hexdigest() == hashlib.sha256(make_wav(freq_seed=0)).hexdigest()
        assert [x["title"] for x in c.get("/api/trash").get_json()["recordings"]] == ["gone"]
    finally:
        app.extensions["riffbox"].stop()


def test_backup_keeps_only_the_newest_database_copies_and_reports_missing_audio(populated):
    cfg, tmp = populated
    spec = importlib.util.spec_from_file_location("bk", DEPLOY / "backup.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    import datetime as dt
    base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    for i in range(5):
        mod.backup(cfg["DATA_DIR"], tmp / "bk", keep=3, now=base + dt.timedelta(days=i))
    assert [p.name for p in sorted((tmp / "bk" / "db").glob("*.db"))] == [
        "riffbox-20260103-000000.db", "riffbox-20260104-000000.db", "riffbox-20260105-000000.db"]
    next(Path(cfg["DATA_DIR"], "audio").glob("*.wav")).unlink()
    r = subprocess.run(script("backup.py") + [cfg["DATA_DIR"], str(tmp / "bk")], capture_output=True, text=True)
    assert r.returncode == 1 and "missing" in r.stderr


def test_export_makes_readable_self_describing_files(populated):
    cfg, tmp = populated
    out = tmp / "export"
    r = subprocess.run(script("export.py") + [cfg["DATA_DIR"], str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    names = sorted(p.name for p in (out / "recordings").iterdir())
    assert len(names) == 8                                      # 4 live recordings, each audio + note; the trashed one is left out
    assert not any(ch in n for n in names for ch in '<>:"/\\|?*')
    assert any(n.endswith("[1].wav") and n.startswith("2026-") and "Riff, _quoted_ _ odd_ name" in n for n in names)
    note = next((out / "recordings").glob("* [[]2].md")).read_text(encoding="utf-8")
    assert note.startswith('---\ntitle: "Été — accents"\n')
    assert 'tags: ["bass", "keys"]' in note and "bpm: 101" in note and 'key: "A minor"' in note and "mark: heart" in note
    assert "![[" in note and note.rstrip().endswith("note 1\nsecond line")
    rows = list(csv.DictReader(open(out / "index.csv", encoding="utf-8-sig", newline="")))
    assert [x["id"] for x in rows] == ["1", "2", "3", "4"] and rows[0]["tags"] == "bass; keys"
    assert rows[0]["notes"] == "note 0\nsecond line"
    page = (out / "index.html").read_text(encoding="utf-8")
    assert "Riff, &quot;quoted&quot;" in page and 'src="recordings/' in page and "<audio" in page
    for line in (out / "manifest-sha256.txt").read_text().splitlines():            # every checksum is true
        digest, path = line.split("  ", 1)
        assert hashlib.sha256((out / path).read_bytes()).hexdigest() == digest
    assert (out / "riffbox.db").is_file() and (out / "README.txt").is_file()
    again = subprocess.run(script("export.py") + [cfg["DATA_DIR"], str(out)], capture_output=True, text=True)
    assert again.returncode != 0 and "not empty" in again.stderr                    # never writes into an existing folder
    with_trash = subprocess.run(script("export.py") + [cfg["DATA_DIR"], str(tmp / "e2"), "--include-trash"], capture_output=True, text=True)
    assert with_trash.returncode == 0 and len(list((tmp / "e2" / "recordings").glob("*.md"))) == 5


def test_export_flags_a_damaged_or_missing_audio_file(populated):
    cfg, tmp = populated
    import sqlite3
    name = dict(sqlite3.connect(Path(cfg["DATA_DIR"]) / "riffbox.db").execute("SELECT id, filename FROM recordings"))
    damaged, missing = (Path(cfg["DATA_DIR"], "audio", name[i]) for i in (1, 2))
    damaged.write_bytes(damaged.read_bytes() + b"x")
    missing.unlink()
    r = subprocess.run(script("export.py") + [cfg["DATA_DIR"], str(tmp / "out")], capture_output=True, text=True)
    assert r.returncode == 1 and "checksum differs" in r.stderr and "missing audio" in r.stderr
