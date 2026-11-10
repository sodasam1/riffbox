"""A randomised workout of every way to change ideas, checking after each step that the database still holds together."""
import random
import sqlite3

import pytest

from conftest import make_wav, upload


def check(db_path):
    """Everything that must be true of the library at any moment."""
    c = sqlite3.connect(db_path)
    c.row_factory = sqlite3.Row
    recs = c.execute("SELECT * FROM recordings").fetchall()
    grp = {g["id"]: g for g in c.execute("SELECT * FROM idea_groups")}
    assert all(r["group_id"] in grp for r in recs), "a recording points at a missing idea"
    by = {}
    for r in recs:
        by.setdefault(r["group_id"], []).append(r)
    assert set(by) == set(grp), "an idea has no recordings, or a recording has no idea"
    for gid, parts in by.items():
        g = grp[gid]
        assert g["part_count"] == len(parts)
        assert sorted(p["position"] for p in parts) == list(range(len(parts))), f"positions of idea {gid} are not 0..n-1"
        assert g["size"] == sum(p["size"] for p in parts)
        assert g["uploaded_at"] == max(p["uploaded_at"] for p in parts)
        assert g["recorded_at"] == (g["recorded_override"] or min(p["recorded_at"] for p in parts))
        assert {bool(p["deleted_at"]) for p in parts} == {bool(g["deleted_at"])}, f"idea {gid} and its parts disagree about the Trash"
        if len(parts) == 1:                                    # the old columns stay in step for a single idea
            p = parts[0]
            for col in ("title", "status", "bpm", "key_root", "key_mode", "notes", "rating", "used_in"):
                assert p[col] == g[col], f"single idea {gid}: {col} differs between idea and recording"
            assert g["unresolved"] is None
        if g["rating"] != "check":
            assert not g["used_in"]
    tags = {t[0] for t in c.execute("SELECT name FROM tags")}
    assert all(t["tag"] in tags for t in c.execute("SELECT tag FROM group_tags"))
    assert not c.execute("SELECT 1 FROM group_tags WHERE group_id NOT IN (SELECT id FROM idea_groups)").fetchone()
    live_sha = [r["sha256"] for r in recs if not r["deleted_at"]]
    assert len(live_sha) == len(set(live_sha)), "the same audio is live twice"
    c.close()


@pytest.mark.parametrize("seed", range(25))
def test_random_changes_never_break_the_library(authed, seed):
    rnd = random.Random(seed)
    db = authed.application.config["DB_PATH"]
    n = 0

    def new():
        nonlocal n
        n += 1
        r = upload(authed, make_wav(freq_seed=seed * 100 + n), f"n{n}.wav", title=f"t{n}")
        assert r.status_code == 201
        return r.get_json()["group_id"]

    for _ in range(5):
        new()
    for _step in range(70):
        live = [g for g in authed.get("/api/groups?rating=heart,check,x,none").get_json()["groups"]]
        trash = authed.get("/api/trash").get_json()["groups"]
        op = rnd.choice(["upload", "group", "group", "add", "remove", "ungroup", "patch", "patch", "trash", "restore", "bulk", "mark", "labels"])
        multi = [g for g in live if len(g["parts"]) > 1]
        if op == "upload":
            new()
        elif op == "group" and len(live) >= 2:
            ids = [g["id"] for g in rnd.sample(live, rnd.randint(2, min(4, len(live))))]
            authed.post("/api/groups", json={"ids": ids})
        elif op == "add" and multi and len(live) >= 2:
            t = rnd.choice(multi)
            others = [g["id"] for g in live if g["id"] != t["id"]]
            authed.post(f"/api/groups/{t['id']}/parts", json={"ids": rnd.sample(others, rnd.randint(1, min(2, len(others))))})
        elif op == "remove" and multi:
            g = rnd.choice(multi)
            authed.delete(f"/api/groups/{g['id']}/parts/{rnd.choice(g['parts'])['id']}")
        elif op == "ungroup" and multi:
            authed.post(f"/api/groups/{rnd.choice(multi)['id']}/ungroup")
        elif op == "patch" and live:
            g = rnd.choice(live)
            body = rnd.choice([{"bpm": rnd.randint(60, 180)}, {"key_root": "C", "key_mode": "major"}, {"notes": "hello"}, {"tags": ["keys", "bass"]},
                               {"status": "tagged"}, {"status": "inbox"}, {"resolved": ["bpm", "key"]}, {"title": f"renamed {rnd.randint(0, 9)}"},
                               {"recorded_at": "2026-02-02T12:00:00Z"}, {"recorded_at": None}])
            authed.patch(f"/api/groups/{g['id']}", json=body)
        elif op == "mark" and live:
            g = rnd.choice(live)
            authed.patch(f"/api/groups/{g['id']}", json={"rating": rnd.choice(["heart", "check", "x", None]), "used_in": rnd.choice([None, "song"])})
        elif op == "labels" and multi:
            g = rnd.choice(multi)
            parts = list(g["parts"])
            rnd.shuffle(parts)
            authed.patch(f"/api/groups/{g['id']}", json={"parts": [{"id": p["id"], "title": f"p{p['id']}"} for p in parts]})
        elif op == "trash" and live:
            authed.delete(f"/api/groups/{rnd.choice(live)['id']}")
        elif op == "restore" and trash:
            authed.post(f"/api/groups/{rnd.choice(trash)['id']}/restore")
        elif op == "bulk" and live:
            ids = [g["id"] for g in rnd.sample(live, rnd.randint(1, min(3, len(live))))]
            authed.post("/api/bulk", json={"ids": ids, "changes": rnd.choice([{"add_tags": ["bass"]}, {"remove_tags": ["bass"]}, {"rating": "heart"},
                                                                              {"status": "inbox"}, {"trash": True}])})
        try:
            check(db)
        except AssertionError as exc:
            raise AssertionError(f"step {_step}, after {op}: {exc}") from exc
