"""A full restore from an export: the data comes back identical, including what the owner typed."""
import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"


@pytest.fixture
def source(tmp_path):
    cfg = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
           "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    app = create_app(cfg)
    c = app.test_client()
    c.post("/api/login", json={"passphrase": PASS})
    for i, t in enumerate(["First riff", "Café — second", "Gone one"]):
        rid = upload(c, make_wav(freq_seed=i), f"m{i}.wav", title=t).get_json()["id"]
        c.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass", "keys"], "bpm": 100 + i, "notes": f"n{i}\nline",
                                                "rating": "heart", "key_root": "A", "key_mode": "minor"})
    c.delete("/api/recordings/3")
    app.extensions["riffbox"].stop()
    return cfg, tmp_path


def run(*args):
    return subprocess.run([sys.executable, "-I", str(DEPLOY / "restore.py"), *map(str, args)], capture_output=True, text=True)


def listing(cfg):
    app = create_app(cfg)
    try:
        c = app.test_client()
        c.post("/api/login", json={"passphrase": PASS})
        live = c.get("/api/groups?rating=heart,check,x,none").get_json()["groups"]
        trash = c.get("/api/trash").get_json()["groups"]
        audio = {r["title"]: hashlib.sha256(c.get(f"/api/audio/{r['id']}").data).hexdigest() for r in live}
        return [(r["title"], r["tags"], r["bpm"], r["notes"], r["rating"], r["key_root"], r["key_mode"], r["status"]) for r in live], \
               [r["title"] for r in trash], audio
    finally:
        app.extensions["riffbox"].stop()


def export_zip(cfg, tmp, name, *flags):
    out = tmp / name
    r = subprocess.run([sys.executable, "-I", str(DEPLOY / "export.py"), cfg["DATA_DIR"], str(out), *flags], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    zpath = tmp / (name + ".zip")
    with zipfile.ZipFile(zpath, "w") as z:                                    # zipped with a top folder, like the page's download
        for p in out.rglob("*"):
            if p.is_file():
                z.write(p, f"riffbox-export-x/{p.relative_to(out).as_posix()}")
    return out, zpath


def test_a_full_export_restores_everything_from_the_zip_or_the_folder(source):
    cfg, tmp = source
    folder, zpath = export_zip(cfg, tmp, "full", "--include-trash")
    before = listing(cfg)
    for src, name in ((zpath, "from-zip"), (folder, "from-folder")):
        r = run(src, tmp / name)
        assert r.returncode == 0 and "restored 3 audio" in r.stdout and not r.stderr, r.stderr
        assert listing({**cfg, "DATA_DIR": str(tmp / name)}) == before


def test_an_export_without_the_trash_restores_the_rest_and_says_what_is_missing(source):
    cfg, tmp = source
    folder, zpath = export_zip(cfg, tmp, "notrash")
    r = run(zpath, tmp / "r1")
    assert "restored 2 audio" in r.stdout and "recording 3 (Gone one) [in the Trash]" in r.stderr and r.returncode == 0
    live, trash, _ = listing({**cfg, "DATA_DIR": str(tmp / "r1")})
    assert len(live) == 2 and trash == ["Gone one"]                         # the entry is there but has no audio: it was warned about
    r = run(zpath, tmp / "r2", "--drop-missing-trash")
    assert "removed 1 Trash entry" in r.stdout and listing({**cfg, "DATA_DIR": str(tmp / "r2")})[1] == []


def test_a_damaged_audio_file_is_reported_and_a_nonempty_target_is_refused(source):
    cfg, tmp = source
    folder, _ = export_zip(cfg, tmp, "bad", "--include-trash")
    victim = next(p for p in (folder / "recordings").glob("*.wav"))
    victim.write_bytes(victim.read_bytes() + b"x")
    r = run(folder, tmp / "bad-restore")
    assert r.returncode == 1 and "does not match its recorded checksum" in r.stderr
    assert run(folder, tmp / "bad-restore").returncode != 0                       # the folder now has files: refused
    assert run(tmp, tmp / "x").returncode != 0                                    # not an export
