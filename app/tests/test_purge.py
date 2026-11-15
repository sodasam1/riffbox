"""Delete for good from the Trash: only trashed ideas, files removed after the database change, backups untouched."""
import sqlite3
from pathlib import Path

import pytest

from conftest import TOKEN, make_wav, upload
from riffbox import backup as backups


@pytest.fixture
def client(authed):
    """A logged-in client (these changes need a login)."""
    return authed


def add(client, n, title=None):
    return upload(client, make_wav(freq_seed=n), f"m{n}.wav", title=title or f"Idea {n}").get_json()["id"]


def rows(app, sql):
    db = sqlite3.connect(Path(app.config["DATA_DIR"]) / "riffbox.db")
    try:
        return db.execute(sql).fetchall()
    finally:
        db.close()


def files(app):
    return sorted(p.name for p in (Path(app.config["DATA_DIR"]) / "audio").iterdir())


@pytest.fixture
def three(client):
    ids = [add(client, i) for i in range(3)]
    for rid in ids:
        client.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass"]})
    return ids


def test_one_trashed_idea_is_removed_with_its_audio_and_tags_and_nothing_else(app, client, three):
    keep, victim, other = three
    gid = client.get("/api/groups?status=tagged").get_json()["groups"][0]["id"]
    client.delete(f"/api/recordings/{victim}")
    before = files(app)
    # a play copy file belonging to the victim must go too
    fname = rows(app, f"SELECT filename FROM recordings WHERE id={victim}")[0][0]
    (Path(app.config["DATA_DIR"]) / "audio" / "victim-play.flac").write_bytes(b"flac")
    db = sqlite3.connect(Path(app.config["DATA_DIR"]) / "riffbox.db")
    db.execute("UPDATE recordings SET play_status='ready', play_filename='victim-play.flac' WHERE id=?", (victim,))
    db.commit(); db.close()
    group_id = rows(app, f"SELECT group_id FROM recordings WHERE id={victim}")[0][0]
    r = client.delete(f"/api/trash/{group_id}")
    assert r.status_code == 200
    body = r.get_json()
    assert body["purged"] == 1 and body["files_removed"] == 2 and body["bytes_freed"] > 0 and body["files_failed"] == 0
    after = files(app)
    assert fname not in after and "victim-play.flac" not in after and len(after) == len(before) - 1      # (the play copy was added after `before` was taken)
    assert rows(app, f"SELECT COUNT(*) FROM recordings WHERE id={victim}") == [(0,)]
    assert rows(app, f"SELECT COUNT(*) FROM recording_tags WHERE recording_id={victim}") == [(0,)]
    assert rows(app, f"SELECT COUNT(*) FROM idea_groups WHERE id={group_id}") == [(0,)]
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(2,)]                      # the other two are untouched
    assert client.get("/api/trash").get_json()["groups"] == []


def test_an_idea_that_is_not_in_the_trash_cannot_be_deleted_for_good(app, client, three):
    gid = rows(app, f"SELECT group_id FROM recordings WHERE id={three[0]}")[0][0]
    before = files(app)
    assert client.delete(f"/api/trash/{gid}").status_code == 404
    assert client.delete("/api/trash/99999").status_code == 404
    assert files(app) == before and rows(app, "SELECT COUNT(*) FROM recordings") == [(3,)]


def test_emptying_the_trash_needs_the_confirm_marker_and_removes_only_trashed_ideas(app, client, three):
    client.delete(f"/api/recordings/{three[0]}")
    client.delete(f"/api/recordings/{three[1]}")
    assert client.delete("/api/trash").status_code == 400                               # no marker: nothing happens
    assert client.delete("/api/trash?confirm=yes").status_code == 400
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(3,)]
    r = client.delete("/api/trash?confirm=empty-trash")
    assert r.status_code == 200 and r.get_json()["purged"] == 2 and r.get_json()["files_removed"] == 2
    assert rows(app, "SELECT id FROM recordings") == [(three[2],)]
    assert len(files(app)) == 1
    again = client.delete("/api/trash?confirm=empty-trash")                             # an empty Trash is not an error
    assert again.status_code == 200 and again.get_json()["purged"] == 0


def test_every_part_of_a_group_is_removed(app, client):
    ids = [add(client, i) for i in range(3)]
    gids = [rows(app, f"SELECT group_id FROM recordings WHERE id={i}")[0][0] for i in ids[:2]]
    made = client.post("/api/groups", json={"ids": gids})
    assert made.status_code in (200, 201), made.get_json()
    gid = made.get_json()["group"]["id"]
    client.delete(f"/api/groups/{gid}")
    r = client.delete(f"/api/trash/{gid}")
    assert r.get_json()["purged"] == 1 and r.get_json()["files_removed"] == 2             # both parts' audio files
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(1,)]
    assert rows(app, f"SELECT COUNT(*) FROM idea_groups WHERE id={gid}") == [(0,)]


def test_the_same_audio_can_be_uploaded_again_after_it_was_deleted_for_good(app, client):
    rid = add(client, 7, "Once")
    client.delete(f"/api/recordings/{rid}")
    gid = rows(app, f"SELECT group_id FROM recordings WHERE id={rid}")[0][0]
    assert client.delete(f"/api/trash/{gid}").status_code == 200
    again = upload(client, make_wav(freq_seed=7), "m7.wav", title="Back again")
    assert again.status_code == 201                                                     # no "already have this" refusal


def test_a_file_that_cannot_be_removed_is_reported_and_the_database_stays_consistent(app, client, monkeypatch):
    rid = add(client, 1)
    client.delete(f"/api/recordings/{rid}")
    real = Path.unlink

    def refuse(self, *a, **kw):
        if self.parent.name == "audio":
            raise PermissionError("denied")
        return real(self, *a, **kw)
    monkeypatch.setattr(Path, "unlink", refuse)
    r = client.delete("/api/trash?confirm=empty-trash")
    assert r.status_code == 200 and r.get_json()["files_failed"] == 1 and r.get_json()["purged"] == 1
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(0,)]                       # the rows are gone either way


def test_a_backup_keeps_its_own_copy(app, client, tmp_path):
    rid = add(client, 2)
    dest = tmp_path / "bk"
    backups.backup(app.config["DATA_DIR"], dest)
    saved = sorted(p.name for p in (dest / "audio").iterdir())
    client.delete(f"/api/recordings/{rid}")
    client.delete("/api/trash?confirm=empty-trash")
    assert sorted(p.name for p in (dest / "audio").iterdir()) == saved and len(saved) == 1


def test_needs_a_login_and_the_phone_token_cannot_use_it(app, client, three):
    client.delete(f"/api/recordings/{three[0]}")
    anon = app.test_client()
    tok = {"Authorization": f"Bearer {TOKEN}"}
    assert anon.delete("/api/trash?confirm=empty-trash").status_code == 401
    assert anon.delete("/api/trash?confirm=empty-trash", headers=tok).status_code == 401
    assert anon.delete("/api/trash/1", headers=tok).status_code == 401
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(3,)]


def test_the_purge_function_itself_refuses_an_idea_that_is_not_in_the_trash(app, client, three):
    """The routes check first, but the function that deletes must hold the rule on its own."""
    from riffbox import groups
    gid = rows(app, f"SELECT group_id FROM recordings WHERE id={three[0]}")[0][0]
    db = sqlite3.connect(Path(app.config["DATA_DIR"]) / "riffbox.db")
    db.row_factory = sqlite3.Row
    try:
        assert groups.purge(db, [gid]) == ([], [], 0)
        db.commit()
    finally:
        db.close()
    assert rows(app, "SELECT COUNT(*) FROM recordings") == [(3,)] and len(files(app)) == 3
