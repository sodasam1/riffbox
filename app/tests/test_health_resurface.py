"""Backup-page status line (thresholds with made-up numbers, then end to end) and the Resurface list."""
import datetime as dt
import sqlite3
import time

import pytest

import riffbox
from conftest import PASS, TOKEN, make_wav, upload
from riffbox import create_app
from riffbox.health import GB, assess, fmt_bytes, fmt_span

BASE = dict(disk_total=25 * GB, disk_free=15 * GB, audio_bytes=3 * GB, original_bytes=3 * GB, recent_bytes=0,
            history_days=0, backup=None, backup_same_disk=False, backup_age_days=None, recordings=10)
GOOD_BACKUP = {"copies": 3, "audio_missing": 0, "audio_total": 10}


def levels(**kw):
    r = assess(**{**BASE, **kw})
    return r["level"], [i["level"] for i in r["items"]]


def test_formatting():
    assert fmt_bytes(0) == "0 KB" and fmt_bytes(1536) == "2 KB" and fmt_bytes(5 * 1024 ** 2) == "5 MB" and fmt_bytes(3 * GB) == "3.0 GB"
    assert fmt_span(10) == "about 10 days" and fmt_span(90) == "about 3 months" and fmt_span(400) == "about a year" \
        and fmt_span(1825) == "about 5 years"


def test_a_healthy_disk_with_a_fresh_backup_says_everything_is_fine():
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0.2, "recent_bytes": GB, "history_days": 60})
    assert r["level"] == "ok" and r["headline"] == "Everything looks fine."
    assert "15.0 GB free of 25.0 GB" in r["summary"] and "growing by about" in r["summary"] and "room for" in r["summary"]


@pytest.mark.parametrize("free,expected", [(2.5 * GB, "ok"), (2.5 * GB - 1, "warn"), (1.25 * GB, "warn"), (1.25 * GB - 1, "bad"),
                                           (0.9 * GB, "bad")])
def test_free_space_thresholds(free, expected):
    assert levels(disk_free=free, backup=GOOD_BACKUP, backup_age_days=0)[0] == expected


def test_the_forecast_warns_and_counts_a_same_disk_backup_twice():
    # 3 GB added over 30 days = 100 MB a day; 15 GB free = 150 days left -> warn
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 3 * GB, "history_days": 30})
    assert r["level"] == "warn" and "fills in about 5 months" in r["headline"]
    # the same growth with the backup on the same disk uses the space twice -> 75 days left
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 3 * GB, "history_days": 30,
                  "backup_same_disk": True})
    assert "fills in about 2 months" in r["headline"] and "count twice" in r["summary"]
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 15 * GB, "history_days": 30})
    assert r["level"] == "bad"


def test_no_forecast_from_too_little_history():
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 3 * GB, "history_days": 5})
    assert r["level"] == "ok" and "too little history" in r["summary"] and "room for" not in r["summary"]


def test_flac_copies_make_the_forecast_faster():
    plain = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 3 * GB, "history_days": 30})
    doubled = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "recent_bytes": 3 * GB, "history_days": 30,
                        "audio_bytes": 6 * GB})
    assert "5 months" in plain["headline"] and "about 2 months" in doubled["headline"]


def test_backup_warnings():
    assert levels()[1] == ["warn"]                                                                   # not set up
    assert levels(backup={"copies": 0, "audio_missing": 10, "audio_total": 10})[1][0] == "warn"      # none yet
    assert levels(backup=GOOD_BACKUP, backup_age_days=2)[0] == "ok"
    assert levels(backup=GOOD_BACKUP, backup_age_days=4)[0] == "warn"
    assert levels(backup=GOOD_BACKUP, backup_age_days=15)[0] == "bad"
    r = assess(**{**BASE, "backup": {**GOOD_BACKUP, "audio_missing": 2}, "backup_age_days": 0})
    assert r["level"] == "warn" and "2 of 10 audio files are not backed up" in r["headline"]
    r = assess(**{**BASE, "backup": GOOD_BACKUP, "backup_age_days": 0, "backup_same_disk": True})
    assert r["level"] == "ok" and any("same disk" in i["text"] for i in r["items"])


# ---- end to end ---------------------------------------------------------------------------------------
@pytest.fixture
def lib(tmp_path):
    made = []

    def build(**extra):
        app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "PASSPHRASE": PASS,
                          "SECRET_KEY": "k", "SESSION_COOKIE_SECURE": False, "FFMPEG": "", **extra})
        made.append(app)
        c = app.test_client()
        c.post("/api/login", json={"passphrase": PASS})
        return app, c
    yield build
    for a in made:
        a.extensions["riffbox"].stop()


def test_the_data_endpoint_reports_health_from_the_real_disk(lib, tmp_path):
    app, c = lib(BACKUP_DIR=str(tmp_path / "bk"))
    upload(c, make_wav(), "a.wav")
    h = c.get("/api/data").get_json()["health"]
    assert h["level"] == "warn" and "No backup has been made yet" in h["headline"] and "free of" in h["summary"]
    c.post("/api/backup")
    for _ in range(100):
        j = c.get("/api/data").get_json()["backup"]["job"]
        if not j["running"] and j["finished_at"]:
            break
        time.sleep(0.05)
    h = c.get("/api/data").get_json()["health"]
    assert any("same disk" in i["text"] for i in h["items"])               # the temp backup shares the test disk
    assert h["level"] == "ok", h


def test_a_full_disk_is_reported(lib, monkeypatch):
    app, c = lib()
    monkeypatch.setattr(riffbox, "disk_usage", lambda path: (25 * GB, 300 * 1024 ** 2))
    h = c.get("/api/data").get_json()["health"]
    assert h["level"] == "bad" and "Disk almost full" in h["headline"]


def test_growth_is_forecast_from_upload_history(lib):
    app, c = lib()
    upload(c, make_wav(), "a.wav")
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%SZ")
    sqlite3.connect(app.config["DB_PATH"]).execute("UPDATE recordings SET uploaded_at = ?", (old,)).connection.commit()
    h = c.get("/api/data").get_json()["health"]
    assert "growing by about" in h["summary"] and "room for" in h["summary"]


# ---- Resurface -------------------------------------------------------------------------------------------
def mk(c, seed, title, rating="heart", status="tagged"):
    rid = upload(c, make_wav(freq_seed=seed), f"{seed}.wav", title=title).get_json()["id"]
    c.patch(f"/api/recordings/{rid}", json={"status": status, "rating": rating})
    return rid


def test_resurface_lists_hearted_ideas_not_played_lately_oldest_first(lib):
    app, c = lib()
    never, old, older, recent = mk(c, 1, "never played"), mk(c, 2, "played 100d ago"), mk(c, 3, "played 200d ago"), mk(c, 4, "played yesterday")
    mk(c, 5, "check", rating="check")
    mk(c, 6, "x", rating="x")
    mk(c, 7, "unmarked", rating=None)
    mk(c, 8, "inbox heart", status="inbox")
    gone = mk(c, 9, "trashed heart")
    c.delete(f"/api/recordings/{gone}")
    db = sqlite3.connect(app.config["DB_PATH"])
    now = dt.datetime.now(dt.timezone.utc)
    for rid, ago in ((old, 100), (older, 200), (recent, 1)):
        db.execute("UPDATE recordings SET last_played_at = ? WHERE id = ?",
                   ((now - dt.timedelta(days=ago)).strftime("%Y-%m-%dT%H:%M:%SZ"), rid))
    db.commit()
    body = c.get("/api/resurface").get_json()
    assert [r["title"] for r in body["recordings"]] == ["never played", "played 200d ago", "played 100d ago"]
    assert body["hearts"] == 4 and body["days"] == 30                       # never, 100d, 200d, yesterday (Library hearts only)
    assert [r["title"] for r in c.get("/api/resurface?days=150").get_json()["recordings"]] == ["never played", "played 200d ago"]
    assert len(c.get("/api/resurface?days=0").get_json()["recordings"]) == 4         # 0 = every hearted idea
    assert c.get("/api/resurface?days=x").status_code == 400 and c.get("/api/resurface?days=-1").status_code == 400
    assert never


def test_resurface_needs_a_login_and_the_token_is_not_enough(lib):
    app, _ = lib()
    anon = app.test_client()
    assert anon.get("/api/resurface").status_code == 401
    assert anon.get("/api/resurface", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_listening_removes_an_idea_from_the_resurface_list(lib):
    _, c = lib()
    rid = mk(c, 1, "heart")
    assert len(c.get("/api/resurface").get_json()["recordings"]) == 1
    c.post(f"/api/recordings/{rid}/played")
    assert c.get("/api/resurface").get_json()["recordings"] == [] and c.get("/api/resurface?days=0").get_json()["hearts"] == 1
