"""deploy/practice_restore.py: a one-command rehearsal of a restore on the owner's own computer."""
import hashlib
import importlib.util
import sqlite3
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import backup as backups
from riffbox import create_app

SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "practice_restore.py"


@pytest.fixture(scope="module")
def pr():
    spec = importlib.util.spec_from_file_location("practice_restore", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def backup_folder(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "live"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
                      "SESSION_COOKIE_SECURE": False, "FFMPEG": ""})
    c = app.test_client()
    c.post("/api/login", json={"passphrase": PASS})
    for i, t in enumerate(["First riff", "Café — second", "Gone one"]):
        rid = upload(c, make_wav(freq_seed=i), f"m{i}.wav", title=t).get_json()["id"]
        c.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass"], "bpm": 100 + i, "notes": f"n{i}", "rating": "heart"})
    c.delete("/api/recordings/3")
    app.extensions["riffbox"].stop()
    dest = tmp_path / "pulled" / "riffbox-backup"
    backups.backup(app.config["DATA_DIR"], dest)
    return dest


def tree_hash(folder):
    h = hashlib.sha256()
    for p in sorted(Path(folder).rglob("*")):
        h.update(str(p.relative_to(folder)).encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


def test_a_good_backup_passes_every_check_and_the_source_is_untouched(pr, backup_folder, capsys):
    before = tree_hash(backup_folder)
    assert pr.main([str(backup_folder)]) == 0
    out = capsys.readouterr().out
    assert "ALL CHECKS PASSED" in out and "Found a backup with 3 recordings" in out and "FAIL" not in out
    assert tree_hash(backup_folder) == before                                   # never writes to what you give it


def test_damaged_audio_makes_it_fail_loudly(pr, backup_folder, capsys):
    victim = sorted((backup_folder / "audio").iterdir())[0]
    victim.write_bytes(victim.read_bytes() + b"x")
    assert pr.main([str(backup_folder)]) == 1
    out = capsys.readouterr().out
    assert "SOME CHECKS FAILED" in out and "FAIL" in out and "checksum" in out


def test_missing_audio_makes_it_fail(pr, backup_folder, capsys):
    sorted((backup_folder / "audio").iterdir())[0].unlink()
    assert pr.main([str(backup_folder)]) == 1
    assert "SOME CHECKS FAILED" in capsys.readouterr().out


def test_a_folder_with_nothing_usable_exits_2(pr, tmp_path, capsys):
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "readme.txt").write_text("not a backup")
    assert pr.main([str(tmp_path / "x")]) == 2
    assert "Nothing usable" in capsys.readouterr().out


def test_the_practice_library_is_deleted_unless_kept(pr, backup_folder, capsys):
    import tempfile
    before = set(Path(tempfile.gettempdir()).glob("riffbox-practice-*"))
    assert pr.main([str(backup_folder)]) == 0
    assert set(Path(tempfile.gettempdir()).glob("riffbox-practice-*")) == before
    capsys.readouterr()
    assert pr.main([str(backup_folder), "--keep"]) == 0
    kept = set(Path(tempfile.gettempdir()).glob("riffbox-practice-*")) - before
    assert len(kept) == 1 and "Practice library kept" in capsys.readouterr().out
    import shutil
    shutil.rmtree(next(iter(kept)), ignore_errors=True)


def test_compare_databases_notices_a_changed_note_and_a_missing_row(pr, backup_folder, tmp_path):
    src = sorted((backup_folder / "db").glob("riffbox-*.db"))[-1]
    same = tmp_path / "same.db"
    same.write_bytes(src.read_bytes())
    assert pr.compare_databases(src, same) == []
    edited = tmp_path / "edited.db"
    edited.write_bytes(src.read_bytes())
    conn = sqlite3.connect(edited)
    conn.execute("UPDATE recordings SET notes = 'changed' WHERE id = 1")
    conn.commit()
    conn.close()
    assert any("recordings" in p and "differs" in p for p in pr.compare_databases(src, edited))
    conn = sqlite3.connect(edited)
    conn.execute("DELETE FROM recordings WHERE id = 2")
    conn.commit()
    conn.close()
    assert any("rows in the source" in p for p in pr.compare_databases(src, edited))
