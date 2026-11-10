"""The export and the restore with ideas made of several recordings."""
import csv
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
def library(tmp_path):
    cfg = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
           "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    app = create_app(cfg)
    c = app.test_client()
    c.post("/api/login", json={"passphrase": PASS})
    ids = {}
    for i, (t, bpm) in enumerate([("Keys part", 120), ("Drums part", 96), ("Vocal part", None), ("Lone idea", 100)]):
        j = upload(c, make_wav(freq_seed=i), f"{t}.wav", title=t, recorded_at=f"2026-03-0{i + 1}T10:00:00Z").get_json()
        ids[t] = (j["id"], j["group_id"])
        c.patch(f"/api/groups/{j['group_id']}", json={"status": "tagged", "tags": ["keys"], "bpm": bpm, "notes": f"{t} notes"})
    made = c.post("/api/groups", json={"ids": [ids["Keys part"][1], ids["Drums part"][1], ids["Vocal part"][1]], "title": "Verse: \"idea\" 1/2"})
    assert made.status_code == 201 and made.get_json()["group"]["unresolved"]
    c.patch(f"/api/groups/{made.get_json()['group']['id']}", json={"tags": ["keys", "drums"], "notes": "the whole idea", "rating": "heart",
                                                                  "parts": [{"id": p["id"], "title": t} for p, t in zip(made.get_json()["group"]["parts"], ["Piano", "Kit", "Voice"])]})
    app.extensions["riffbox"].stop()
    return cfg, tmp_path, made.get_json()["group"]


def export(cfg, tmp, name, *flags):
    out = tmp / name
    r = subprocess.run([sys.executable, "-I", str(DEPLOY / "export.py"), cfg["DATA_DIR"], str(out), *flags], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return out


def test_an_idea_of_several_recordings_exports_as_one_note_and_named_parts(library):
    cfg, tmp, group = library
    out = export(cfg, tmp, "x")
    names = sorted(p.name for p in (out / "recordings").iterdir())
    notes = [n for n in names if n.endswith(".md")]
    assert len(notes) == 2                                                   # the idea and the lone recording, not one per part
    idea_note = next(n for n in notes if "[idea " in n)
    assert idea_note.startswith("2026-03-01 Verse_ _idea_ 1_2 [idea ")        # characters that file systems dislike are replaced
    audio = [n for n in names if not n.endswith(".md")]
    assert len(audio) == 4
    parts = sorted(n for n in audio if " - part " in n)
    assert [n.split(" - ")[1].split(" [")[0] for n in parts] == ["part 1 Piano", "part 2 Kit", "part 3 Voice"]
    text = (out / "recordings" / idea_note).read_text(encoding="utf-8")
    assert 'title: "Verse: \\"idea\\" 1/2"' in text and 'tags: ["drums", "keys"]' in text and "mark: heart" in text
    assert 'bpm_still_to_choose: ["120 BPM (Keys part)", "96 BPM (Drums part)"]' in text      # the open choice is not lost
    assert text.count("  - label:") == 3 and text.count("![[") == 3 and text.rstrip().endswith("the whole idea")
    rows = list(csv.DictReader(open(out / "index.csv", encoding="utf-8-sig", newline="")))
    assert len(rows) == 4
    idea_rows = [r for r in rows if r["idea_parts"] == "3"]
    assert [r["part_title"] for r in idea_rows] == ["Piano", "Kit", "Voice"] and {r["title"] for r in idea_rows} == {"Verse: \"idea\" 1/2"}
    assert {r["idea_id"] for r in idea_rows} == {str(group["id"])} and [r["part"] for r in idea_rows] == ["1", "2", "3"]
    lone = next(r for r in rows if r["idea_parts"] == "1")
    assert lone["title"] == "Lone idea" and lone["part"] == "" and lone["bpm"] == "100"
    page = (out / "index.html").read_text(encoding="utf-8")
    assert "2 ideas, 4 recordings" in page and page.count("<audio") == 4 and "Piano" in page
    for line in (out / "manifest-sha256.txt").read_text().splitlines():
        digest, path = line.split("  ", 1)
        assert hashlib.sha256((out / path).read_bytes()).hexdigest() == digest


def test_a_single_idea_still_exports_exactly_as_before(library):
    cfg, tmp, _g = library
    out = export(cfg, tmp, "y")
    note = next((out / "recordings").glob("2026-03-04 Lone idea [[]*].md")).read_text(encoding="utf-8")
    assert note.startswith('---\ntitle: "Lone idea"\n') and "bpm: 100" in note and note.rstrip().endswith("Lone idea notes")
    assert "parts:" not in note and "still_to_choose" not in note


def test_restoring_an_export_with_groups_brings_the_ideas_back_whole(library):
    cfg, tmp, group = library
    out = export(cfg, tmp, "z")
    zpath = tmp / "z.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        for p in out.rglob("*"):
            if p.is_file():
                z.write(p, f"riffbox-export/{p.relative_to(out).as_posix()}")
    r = subprocess.run([sys.executable, "-I", str(DEPLOY / "restore.py"), str(zpath), str(tmp / "restored")], capture_output=True, text=True)
    assert r.returncode == 0 and "restored 4 audio" in r.stdout, r.stdout + r.stderr
    app = create_app({**cfg, "DATA_DIR": str(tmp / "restored")})
    try:
        c = app.test_client()
        c.post("/api/login", json={"passphrase": PASS})
        ideas = c.get("/api/groups?rating=heart,check,x,none").get_json()["groups"]
        assert len(ideas) == 2
        g = next(i for i in ideas if len(i["parts"]) == 3)
        assert g["title"] == "Verse: \"idea\" 1/2" and [p["title"] for p in g["parts"]] == ["Piano", "Kit", "Voice"]
        assert g["tags"] == ["drums", "keys"] and g["notes"] == "the whole idea" and g["unresolved"]["bpm"]
        for p in g["parts"]:
            assert hashlib.sha256(c.get(f"/api/audio/{p['id']}").data).hexdigest()
    finally:
        app.extensions["riffbox"].stop()


def test_an_old_database_without_ideas_still_exports(tmp_path):
    """The export script may be run on a database the new app has not opened yet."""
    import sqlite3
    cfg = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS, "SECRET_KEY": "k",
           "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    app = create_app(cfg)
    c = app.test_client()
    c.post("/api/login", json={"passphrase": PASS})
    upload(c, make_wav(freq_seed=1), "a.wav", title="Old style")
    app.extensions["riffbox"].stop()
    conn = sqlite3.connect(tmp_path / "data" / "riffbox.db")
    conn.executescript("DROP TABLE group_tags; DROP TABLE idea_groups;")      # what a pre-groups database looks like to the exporter
    conn.commit()
    conn.close()
    out = export(cfg, tmp_path, "old")
    assert len(list((out / "recordings").glob("*.md"))) == 1 and "Old style" in (out / "index.html").read_text(encoding="utf-8")
