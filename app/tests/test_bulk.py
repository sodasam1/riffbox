"""Bulk changes from the Library's Select mode: all or nothing, same rules as changing one recording."""
import sqlite3

import pytest

from conftest import TOKEN, make_wav, upload


@pytest.fixture
def three(authed):
    ids = []
    for i, t in enumerate(["one", "two", "three"]):
        rid = upload(authed, make_wav(freq_seed=i), f"{i}.wav", title=t).get_json()["id"]
        authed.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["bass"] if i else ["keys"]})
        ids.append(rid)
    return authed, ids


def rows(c):
    return {r["title"]: r for r in c.get("/api/groups?rating=heart,check,x,none").get_json()["groups"]}


def bulk(c, ids, **changes):
    return c.post("/api/bulk", json={"ids": ids, "changes": changes})


def test_add_and_remove_tags_on_many_at_once(three):
    c, ids = three
    assert bulk(c, ids, add_tags=["drums", "Rhythmic  Idea"]).get_json() == {"updated": 3}
    r = rows(c)
    assert all({"drums", "rhythmic idea"} <= set(x["tags"]) for x in r.values())
    assert "keys" in r["one"]["tags"] and "bass" in r["two"]["tags"]                # the tags they had are kept
    assert bulk(c, ids[:2], remove_tags=["drums", "keys", "not-held"]).status_code == 200
    r = rows(c)
    assert "drums" not in r["one"]["tags"] and "keys" not in r["one"]["tags"] and "drums" in r["three"]["tags"]
    assert bulk(c, ids, add_tags=["bass"]).status_code == 200                      # already held: no error, no duplicate
    assert rows(c)["two"]["tags"].count("bass") == 1


def test_marks_status_and_the_song_box(three):
    c, ids = three
    c.patch(f"/api/recordings/{ids[0]}", json={"rating": "check", "used_in": "Summer"})
    assert bulk(c, ids, rating="check").status_code == 200
    assert rows(c)["one"]["used_in"] == "Summer"                                   # still a check: the song is kept
    assert bulk(c, ids, rating="heart").status_code == 200
    r = rows(c)
    assert {x["rating"] for x in r.values()} == {"heart"} and r["one"]["used_in"] is None
    assert bulk(c, ids, rating=None).status_code == 200 and {x["rating"] for x in rows(c).values()} == {None}
    assert bulk(c, ids[:2], status="inbox").status_code == 200
    assert [x["title"] for x in c.get("/api/groups?status=inbox").get_json()["groups"]] == ["two", "one"]


def test_trash_many_and_they_can_be_restored(three):
    c, ids = three
    assert bulk(c, ids[:2], trash=True).get_json() == {"updated": 2}
    assert list(rows(c)) == ["three"]
    assert {x["title"] for x in c.get("/api/trash").get_json()["groups"]} == {"one", "two"}
    assert c.post(f"/api/recordings/{ids[0]}/restore").status_code == 200


def test_it_is_all_or_nothing(three):
    c, ids = three
    before = rows(c)
    assert bulk(c, [*ids, 9999], add_tags=["drums"]).status_code == 400              # one is missing: nothing changes
    assert rows(c) == before
    c.delete(f"/api/recordings/{ids[0]}")
    assert bulk(c, ids, rating="heart").status_code == 400                           # one is in the Trash
    assert {x["rating"] for x in rows(c).values()} == {None}
    tags = [f"t{i}" for i in range(30)]
    for t in tags:
        c.post("/api/tags", json={"name": t})
    c.patch(f"/api/recordings/{ids[1]}", json={"tags": tags})
    r = bulk(c, ids[1:], add_tags=["drums"])                                         # would be a 31st tag on one of them
    assert r.status_code == 400 and "30 tags" in r.get_json()["error"]
    assert "drums" not in rows(c)["three"]["tags"]


@pytest.mark.parametrize("body", [
    {}, {"ids": [], "changes": {"rating": "heart"}}, {"ids": "1", "changes": {"rating": "heart"}},
    {"ids": [True], "changes": {"rating": "heart"}}, {"ids": [1.5], "changes": {"rating": "heart"}},
    {"ids": [1], "changes": {}}, {"ids": [1], "changes": {"title": "x"}}, {"ids": [1], "changes": {"rating": "love"}},
    {"ids": [1], "changes": {"status": "gone"}}, {"ids": [1], "changes": {"add_tags": []}},
    {"ids": [1], "changes": {"add_tags": ["nope-not-created"]}}, {"ids": [1], "changes": {"remove_tags": "bass"}},
    {"ids": [1], "changes": {"trash": False}}, {"ids": [1], "changes": {"trash": True, "rating": "heart"}},
    {"ids": list(range(1, 502)), "changes": {"rating": "heart"}},
])
def test_bad_requests_are_refused_cleanly(three, body):
    assert three[0].post("/api/bulk", json=body).status_code == 400


def test_login_is_required_and_the_upload_token_is_not_enough(client):
    for headers in ({}, {"Authorization": f"Bearer {TOKEN}"}):
        assert client.post("/api/bulk", json={"ids": [1], "changes": {"rating": "heart"}}, headers=headers).status_code == 401


def test_a_failure_part_way_leaves_nothing_changed(three, monkeypatch):
    c, ids = three
    db = sqlite3.connect(c.application.config["DB_PATH"])
    db.execute("CREATE TRIGGER boom BEFORE INSERT ON recording_tags BEGIN SELECT RAISE(ABORT, 'boom'); END")
    db.commit()
    c.application.config["PROPAGATE_EXCEPTIONS"] = False
    r = bulk(c, ids, rating="heart", add_tags=["drums"])
    assert r.status_code == 500
    assert {x["rating"] for x in rows(c).values()} == {None}                          # the mark change was rolled back too
