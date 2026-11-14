"""Numbered database migrations: each step runs once, in order, all or nothing; databases from before numbering are adopted."""
import logging
import sqlite3

import pytest

from conftest import PASS, TOKEN
from riffbox import create_app, migrations
from test_groups import OLD_SCHEMA


def cfg(tmp_path):
    return {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "SECRET_KEY": "k", "PASSPHRASE": PASS, "UPLOAD_TOKEN": TOKEN,
            "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}


def version(tmp_path):
    c = sqlite3.connect(tmp_path / "data" / "riffbox.db")
    try:
        return c.execute("PRAGMA user_version").fetchone()[0]
    finally:
        c.close()


def old_db(tmp_path, rows=2):
    data = tmp_path / "data"
    (data / "audio").mkdir(parents=True)
    c = sqlite3.connect(data / "riffbox.db")
    c.executescript(OLD_SCHEMA)
    for i in range(1, rows + 1):
        c.execute("INSERT INTO recordings (id, title, filename, orig_filename, mime, size, sha256, recorded_at, uploaded_at, status) "
                  "VALUES (?,?,?,?,?,?,?,?,?, 'tagged')", (i, f"Old {i}", f"f{i}.wav", f"o{i}.wav", "audio/wav", 10, f"sha{i}",
                                                          "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
    c.commit()
    c.close()


def test_a_new_database_is_numbered_with_the_latest_version_and_needs_no_copy(tmp_path):
    app = create_app(cfg(tmp_path))
    app.extensions["riffbox"].stop()
    assert version(tmp_path) == migrations.latest_version() == 2
    assert not (tmp_path / "data" / "before-migration").exists()               # nothing to protect in an empty database


def test_a_database_from_before_numbering_is_adopted_kept_and_numbered(tmp_path):
    old_db(tmp_path, rows=3)
    assert version(tmp_path) == 0
    app = create_app(cfg(tmp_path))
    app.extensions["riffbox"].stop()
    assert version(tmp_path) == 2
    copies = list((tmp_path / "data" / "before-migration").glob("riffbox-v0-*.db"))
    assert len(copies) == 1
    kept = sqlite3.connect(copies[0])
    assert kept.execute("SELECT COUNT(*) FROM recordings").fetchone()[0] == 3 and kept.execute("PRAGMA user_version").fetchone()[0] == 0
    assert "group_id" not in {r[1] for r in kept.execute("PRAGMA table_info(recordings)")}          # the copy is the database as it was
    c = sqlite3.connect(tmp_path / "data" / "riffbox.db")
    assert c.execute("SELECT COUNT(*) FROM idea_groups").fetchone()[0] == 3


def test_a_database_that_already_has_the_groups_layout_but_no_number_is_just_numbered(tmp_path):
    app = create_app(cfg(tmp_path))
    app.extensions["riffbox"].stop()
    c = sqlite3.connect(tmp_path / "data" / "riffbox.db")
    c.execute("PRAGMA user_version = 0")                                         # what the live database looks like at the first start of this version
    c.commit()
    c.close()
    app = create_app(cfg(tmp_path))
    app.extensions["riffbox"].stop()
    assert version(tmp_path) == 2


def test_each_step_runs_once_and_only_new_steps_run_later(tmp_path):
    ran = []
    steps = [(1, "a", lambda c: ran.append(1)), (2, "b", lambda c: ran.append(2))]
    conn = sqlite3.connect(":memory:")
    assert migrations.run(conn, steps=steps) == [1, 2] and ran == [1, 2]
    assert migrations.run(conn, steps=steps) == [] and ran == [1, 2]            # a second start changes nothing
    steps.append((3, "c", lambda c: ran.append(3)))
    assert migrations.run(conn, steps=steps) == [3] and ran == [1, 2, 3]
    assert migrations.current_version(conn) == 3


def test_a_failing_step_is_undone_completely_and_not_numbered(tmp_path):
    def broken(c):
        c.execute("CREATE TABLE half_done (x)")
        raise RuntimeError("boom")
    steps = [(1, "ok", lambda c: c.execute("CREATE TABLE fine (x)")), (2, "broken", broken), (3, "never", lambda c: c.execute("CREATE TABLE never (x)"))]
    conn = sqlite3.connect(":memory:")
    with pytest.raises(RuntimeError):
        migrations.run(conn, steps=steps)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {"fine"}                                                    # step 1 stays; step 2 left no trace; step 3 never ran
    assert migrations.current_version(conn) == 1


def test_a_database_numbered_higher_than_the_app_knows_is_opened_with_a_warning(tmp_path, caplog):
    app = create_app(cfg(tmp_path))
    app.extensions["riffbox"].stop()
    c = sqlite3.connect(tmp_path / "data" / "riffbox.db")
    c.execute("PRAGMA user_version = 9")
    c.commit()
    c.close()
    with caplog.at_level(logging.WARNING, logger="riffbox"):
        app = create_app(cfg(tmp_path))
        app.extensions["riffbox"].stop()
    assert version(tmp_path) == 9 and any("only knows up to 2" in r.message for r in caplog.records)


def test_only_the_newest_copies_are_kept(tmp_path):
    data = tmp_path / "data"
    old_db(tmp_path)
    conn = sqlite3.connect(data / "riffbox.db")
    for n in range(6):
        migrations._keep_copy(conn, data, n)
    assert len(list((data / "before-migration").glob("riffbox-v*.db"))) == migrations.KEEP_COPIES
