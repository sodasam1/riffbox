"""Numbered database migrations. Standard library only.

The database carries its own version number (SQLite's built-in `PRAGMA user_version`). The list STEPS holds every change ever
made to the database's layout, in order, each with its number. On start-up the app runs only the steps after the number the
database has, each one inside a transaction together with the new version number, so a step either happens completely and is
recorded, or does not happen at all. A step is never edited after it has been released; a new change is a new step at the end.

Databases made before this existed have no number (0). Steps 1 and 2 describe the two layout changes that were made the old way
(by looking at which columns were missing); they only add what is missing, so running them on a database that already has
everything is harmless, and afterwards it is numbered 2 like a new one.

Before the first pending step is applied to a database that holds recordings, a copy of the database is kept in
`<data folder>/before-migration/` (the three newest are kept). Rolling back to an older version of the app is still possible:
every step so far only adds tables, columns and rows, and an older version of the app ignores what it does not know. A database
numbered higher than this version knows is opened anyway (with a warning in the log) for the same reason.
"""
import logging
import sqlite3
import time
from pathlib import Path

from . import groups

log = logging.getLogger("riffbox")
KEEP_COPIES = 3
PLAYBACK_COLUMNS = ("codec", "play_status", "play_filename", "play_error")


def step_playback_copy_columns(conn):
    """Phase 3.5: the columns for the FLAC play copy."""
    have = {r[1] for r in conn.execute("PRAGMA table_info(recordings)")}
    for col in PLAYBACK_COLUMNS:
        if col not in have:
            conn.execute(f"ALTER TABLE recordings ADD COLUMN {col} TEXT")


def step_groups(conn):
    """Groups: every recording belongs to an idea (see groups.py)."""
    groups.migrate(conn)


STEPS = [
    (1, "playback copy columns", step_playback_copy_columns),
    (2, "groups: ideas made of recordings", step_groups),
]


def current_version(conn):
    return conn.execute("PRAGMA user_version").fetchone()[0]


def latest_version(steps=None):
    return (steps or STEPS)[-1][0]


def _has_data(conn):
    try:
        return conn.execute("SELECT 1 FROM recordings LIMIT 1").fetchone() is not None
    except sqlite3.Error:
        return False


def _keep_copy(conn, data_dir, version):
    """A consistent copy of the database as it is now (the app is the only writer, and it is starting)."""
    folder = Path(data_dir) / "before-migration"
    folder.mkdir(exist_ok=True)
    now = time.time()
    target = folder / f"riffbox-v{version}-{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}-{int(now * 1000) % 1000:03d}.db"
    dest = sqlite3.connect(target)
    try:
        conn.backup(dest)
    finally:
        dest.close()
    for old in sorted(folder.glob("riffbox-v*.db"))[:-KEEP_COPIES]:
        old.unlink(missing_ok=True)
    return target


def run(conn, data_dir=None, steps=None):
    """Bring the database up to date. Returns the list of step numbers that were applied (empty if it was current)."""
    steps = steps if steps is not None else STEPS
    have = current_version(conn)
    top = latest_version(steps)
    if have > top:
        log.warning("riffbox: the database is numbered %s but this version of the app only knows up to %s; opening it as it is", have, top)
        return []
    pending = [s for s in steps if s[0] > have]
    if not pending:
        return []
    if data_dir is not None and _has_data(conn):
        kept = _keep_copy(conn, data_dir, have)
        log.info("riffbox: kept a copy of the database before migrating: %s", kept)
    applied = []
    previous = conn.isolation_level
    conn.isolation_level = None                    # we start and end each transaction ourselves
    try:
        for number, name, step in pending:
            conn.execute("BEGIN IMMEDIATE")
            try:
                step(conn)
                conn.execute(f"PRAGMA user_version = {int(number)}")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                log.error("riffbox: migration %s (%s) failed and was undone; the database is still at version %s", number, name, number - 1)
                raise
            applied.append(number)
            log.info("riffbox: applied database migration %s (%s)", number, name)
    finally:
        conn.isolation_level = previous
    return applied
