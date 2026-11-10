"""Groups: one idea made of several recordings. The model, the migration, and every way of making and changing a group."""
import sqlite3

import pytest

from conftest import PASS, TOKEN, make_wav, resync, upload
from riffbox import create_app


def up(c, seed, title, **form):
    j = upload(c, make_wav(freq_seed=seed), f"m{seed}.wav", title=title, **form).get_json()
    return j["id"], j["group_id"]


def listing(c, q=""):
    return c.get("/api/groups" + q).get_json()["groups"]


def one(c, gid):
    return next(g for g in listing(c, "?rating=heart,check,x,none") if g["id"] == gid)


def own_copy(c, rec_id):
    """What the recording itself keeps (its snapshot), straight from the database."""
    conn = sqlite3.connect(c.application.config["DB_PATH"])
    conn.row_factory = sqlite3.Row
    return dict(conn.execute("SELECT * FROM recordings WHERE id = ?", (rec_id,)).fetchone())


@pytest.fixture
def trio(authed):
    """Three tagged ideas (keys, drums, vocal) with disagreeing details, uploaded a minute apart."""
    made = {}
    for i, (title, rec_at, tags, bpm, key) in enumerate([
            ("keys riff", "2026-03-01T10:00:00Z", ["keys"], 120, ("A", "minor")),
            ("drums riff", "2026-03-01T10:05:00Z", ["drums", "rhythmic idea"], 96, ("A", "minor")),
            ("vocal riff", "2026-03-02T09:00:00Z", ["vocal"], None, (None, None))]):
        rid, gid = up(authed, i, title, recorded_at=rec_at)
        authed.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": tags, "bpm": bpm, "key_root": key[0], "key_mode": key[1],
                                                       "notes": f"{title} notes"})
        made[title] = (rid, gid)
    conn = sqlite3.connect(authed.application.config["DB_PATH"])
    for n, (rid, _g) in enumerate(made.values()):                       # distinct upload times
        conn.execute("UPDATE recordings SET uploaded_at = ?, size = ?, duration_s = ? WHERE id = ?",
                     (f"2026-04-0{n + 1}T00:00:00Z", 1000 * (n + 1), 10.0 * (n + 1), rid))
    conn.commit()
    resync(authed.application.config["DB_PATH"])
    return authed, made


def test_every_upload_is_a_single_idea_with_a_group_of_its_own(authed):
    rid, gid = up(authed, 1, "memo")
    g = one(authed, gid)
    assert (g["part_count"], g["title"], g["status"]) == (1, "memo", "inbox")
    assert [p["id"] for p in g["parts"]] == [rid] and g["parts"][0]["title"] == "memo"
    assert (g["recorded_at"], g["uploaded_at"]) == (g["parts"][0]["recorded_at"], g["parts"][0]["uploaded_at"])
    dup = upload(authed, make_wav(freq_seed=1), "again.wav").get_json()
    assert dup["duplicate"] and dup["group_id"] == gid


def test_a_single_ideas_edits_are_copied_onto_its_recording_but_a_groups_are_not(trio):
    c, made = trio
    (k_rid, k_gid), (d_rid, d_gid) = made["keys riff"], made["drums riff"]
    c.patch(f"/api/groups/{k_gid}", json={"title": "Keys v2", "bpm": 125, "tags": ["keys", "harmony"], "rating": "heart"})
    mine = own_copy(c, k_rid)
    assert (mine["title"], mine["bpm"], mine["rating"]) == ("Keys v2", 125, "heart")            # single: the snapshot follows
    gid = c.post("/api/groups", json={"ids": [k_gid, d_gid]}).get_json()["group"]["id"]
    c.patch(f"/api/groups/{gid}", json={"bpm": 111, "notes": "the whole idea", "tags": ["vocal"], "rating": "check"})
    for rid in (k_rid, d_rid):                                                                  # grouped: parts keep what they had
        mine = own_copy(c, rid)
        assert (mine["bpm"], mine["notes"]) != (111, "the whole idea") and mine["rating"] != "check"
    assert own_copy(c, k_rid)["bpm"] == 125 and own_copy(c, d_rid)["bpm"] == 96


def test_making_a_group_fills_in_the_details_from_its_parts(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    s = c.post("/api/groups/suggest", json={"ids": ids}).get_json()
    assert s["title"] == "keys riff" and sorted(s["tags"]) == sorted(["keys", "drums", "vocal", "rhythmic idea"])
    assert s["bpm"] is None and [x["value"] for x in s["conflicts"]["bpm"]] == [120, 96]        # 120 vs 96: the dialog must choose
    assert (s["key_root"], s["key_mode"]) == ("A", "minor") and s["conflicts"]["key"] == []     # the two keys agree; the third has none
    assert s["notes"].startswith("keys riff: keys riff notes") and "vocal riff: vocal riff notes" in s["notes"]
    assert s["status"] == "tagged"
    r = c.post("/api/groups", json={"ids": ids, "title": "Song idea", "bpm": 100, "tags": ["keys", "vocal"]})
    assert r.status_code == 201
    g = r.get_json()["group"]
    assert (g["title"], g["bpm"], g["tags"], g["key_root"], g["part_count"]) == ("Song idea", 100, ["keys", "vocal"], "A", 3)
    assert [p["title"] for p in g["parts"]] == ["keys riff", "drums riff", "vocal riff"]        # earliest recorded first
    assert len(listing(c, "?rating=heart,check,x,none")) == 1                                    # one line for the whole idea


def test_a_groups_dates_length_and_size_come_from_its_parts(trio):
    c, made = trio
    g = c.post("/api/groups", json={"ids": [g for _r, g in made.values()]}).get_json()["group"]
    assert g["recorded_at"] == "2026-03-01T10:00:00Z"            # the earliest recorded
    assert g["uploaded_at"] == "2026-04-03T00:00:00Z"            # the latest upload
    assert g["duration_s"] == 30.0 and g["size"] == 6000         # the longest part; the sum
    for p in g["parts"]:                                         # the recordings keep their own dates
        assert p["recorded_at"] != g["recorded_at"] or p["title"] == "keys riff"
    c.patch(f"/api/groups/{g['id']}", json={"recorded_at": "2026-02-02T12:00:00Z"})
    assert one(c, g["id"])["recorded_at"] == "2026-02-02T12:00:00Z"
    c.patch(f"/api/groups/{g['id']}", json={"recorded_at": None})
    assert one(c, g["id"])["recorded_at"] == "2026-03-01T10:00:00Z"
    assert sorted(x["part_count"] for x in listing(c)) == [3]


def test_status_for_a_mixed_selection_defaults_to_the_inbox(authed):
    _a, ga = up(authed, 1, "in the inbox")
    rb, gb = up(authed, 2, "in the library")
    authed.patch(f"/api/recordings/{rb}", json={"status": "tagged"})
    g = authed.post("/api/groups", json={"ids": [ga, gb]}).get_json()["group"]
    assert g["status"] == "inbox"
    assert authed.post("/api/groups", json={"ids": [ga, gb], "status": "tagged"}).status_code == 409     # they are one group now


def test_only_the_group_has_tags_tempo_and_a_mark_and_parts_keep_a_label(trio):
    c, made = trio
    g = c.post("/api/groups", json={"ids": [g for _r, g in made.values()], "bpm": 100}).get_json()["group"]
    assert set(g) >= {"tags", "bpm", "key_root", "notes", "rating"} and set(g["parts"][0]) .isdisjoint({"tags", "bpm", "notes", "rating"})
    renamed = [{"id": g["parts"][2]["id"], "title": "Lead vocal"}, {"id": g["parts"][0]["id"], "title": "Piano"},
               {"id": g["parts"][1]["id"], "title": "Kit"}]
    r = c.patch(f"/api/groups/{g['id']}", json={"parts": renamed, "title": "Same title"})
    assert [p["title"] for p in r.get_json()["group"]["parts"]] == ["Lead vocal", "Piano", "Kit"]      # renamed and reordered
    assert c.patch(f"/api/groups/{g['id']}", json={"parts": renamed[:2]}).status_code == 409            # must name every part
    assert c.patch(f"/api/groups/{g['id']}", json={"parts": [{"id": 1, "title": ""}]}).status_code == 400
    rid = g["parts"][0]["id"]                                                                           # the older request form
    c.patch(f"/api/recordings/{rid}", json={"title": "Keys, again", "notes": "n"})
    after = one(c, g["id"])
    assert after["title"] == "Same title" and after["notes"] == "n" and "Keys, again" in [p["title"] for p in after["parts"]]


def test_adding_removing_and_ungrouping(trio):
    c, made = trio
    (k_rid, k_gid), (d_rid, d_gid), (v_rid, v_gid) = made.values()
    gid = c.post("/api/groups", json={"ids": [k_gid, d_gid], "title": "Pair"}).get_json()["group"]["id"]
    added = c.post(f"/api/groups/{gid}/parts", json={"ids": [v_gid]}).get_json()["group"]
    assert [p["id"] for p in added["parts"]] == [k_rid, d_rid, v_rid] and added["title"] == "Pair"      # the group keeps its details
    r = c.delete(f"/api/groups/{gid}/parts/{d_rid}").get_json()
    freed = r["freed"]
    assert [p["id"] for p in r["group"]["parts"]] == [k_rid, v_rid] and r["group"]["part_count"] == 2
    assert (freed["title"], freed["bpm"], freed["tags"], freed["part_count"]) == ("drums riff", 96, ["drums", "rhythmic idea"], 1)   # its own details
    assert freed["status"] == "tagged"
    assert c.delete(f"/api/groups/{freed['id']}/parts/{d_rid}").status_code == 409                       # a single cannot lose its only part
    u = c.post(f"/api/groups/{gid}/ungroup").get_json()["groups"]
    assert sorted(x["title"] for x in u) == ["keys riff", "vocal riff"]
    assert all(x["part_count"] == 1 for x in u) and len(listing(c)) == 3 and c.get(f"/api/groups/{gid}").status_code in (404, 405)


def test_trash_and_restore_take_the_whole_group(trio):
    c, made = trio
    gids = [g for _r, g in made.values()]
    gid = c.post("/api/groups", json={"ids": gids[:2]}).get_json()["group"]["id"]
    assert c.delete(f"/api/groups/{gid}").status_code == 200
    assert [g["title"] for g in listing(c)] == ["vocal riff"]
    for rid in [r for r, _g in list(made.values())[:2]]:
        assert c.get(f"/api/audio/{rid}").status_code == 404                                              # every part is gone with it
    trash = c.get("/api/trash").get_json()["groups"]
    assert len(trash) == 1 and trash[0]["part_count"] == 2 and trash[0]["deleted_at"]
    assert c.post(f"/api/groups/{gid}/restore").status_code == 200
    assert len(listing(c)) == 2 and c.get(f"/api/audio/{made['keys riff'][0]}").status_code == 200
    assert c.post(f"/api/groups/{gid}/restore").status_code == 404                                        # not in the Trash any more
    c.delete(f"/api/groups/{gid}")
    up(c, 0, "the same keys audio again")                                                                 # uploaded again meanwhile
    r = c.post(f"/api/groups/{gid}/restore")
    assert r.status_code == 409 and "already in your lists" in r.get_json()["error"]


def test_bulk_changes_apply_to_whole_groups_and_ignore_the_parts(trio):
    c, made = trio
    gids = [g for _r, g in made.values()]
    gid = c.post("/api/groups", json={"ids": gids[:2], "title": "Pair"}).get_json()["group"]["id"]
    assert c.post("/api/bulk", json={"ids": [gid, gids[2]], "changes": {"add_tags": ["bass"], "rating": "heart"}}).status_code == 200
    assert {x["title"]: (x["rating"], "bass" in x["tags"]) for x in listing(c)} == {"Pair": ("heart", True), "vocal riff": ("heart", True)}
    assert c.post("/api/bulk", json={"ids": [gid], "changes": {"trash": True}}).status_code == 200
    assert [g["title"] for g in listing(c)] == ["vocal riff"] and c.get("/api/trash").get_json()["groups"][0]["part_count"] == 2


def test_search_looks_at_part_titles_and_the_other_filters_at_the_group(trio):
    c, made = trio
    gid = c.post("/api/groups", json={"ids": [g for _r, g in made.values()], "title": "Song", "bpm": 100, "tags": ["keys"]}).get_json()["group"]["id"]
    assert [g["id"] for g in listing(c, "?q=drums")] == [gid]                 # a part's title matches
    assert [g["id"] for g in listing(c, "?q=Song")] == [gid] and listing(c, "?q=zzz") == []
    assert [g["id"] for g in listing(c, "?bpm_min=90&bpm_max=110")] == [gid] and listing(c, "?bpm_min=120") == []
    assert [g["id"] for g in listing(c, "?tags=keys")] == [gid] and listing(c, "?tags=drums") == []       # the group's tags, not a part's


def test_playing_any_part_counts_for_the_group_and_resurface_returns_the_whole_group(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    gid = c.post("/api/groups", json={"ids": ids, "title": "Song", "bpm": 100, "rating": "heart"}).get_json()["group"]["id"]
    body = c.get("/api/resurface").get_json()
    assert [g["id"] for g in body["groups"]] == [gid] and body["groups"][0]["part_count"] == 3 and body["hearts"] == 1
    c.post(f"/api/recordings/{made['drums riff'][0]}/played")
    assert one(c, gid)["last_played_at"] and c.get("/api/resurface").get_json()["groups"] == []          # one listen is enough


def test_bad_group_requests_are_refused_and_change_nothing(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    before = listing(c)
    for body in ({"ids": [ids[0]]}, {"ids": []}, {"ids": "x"}, {"ids": [ids[0], 9999]}, {"ids": ids, "tags": ["nope"]},
                 {"ids": ids, "bpm": 5}, {"ids": ids, "used_in": "song"}, {"ids": [True, False]}):
        assert c.post("/api/groups", json=body).status_code in (400, 409), body
    assert listing(c) == before
    assert c.post("/api/groups/suggest", json={"ids": [9999]}).status_code == 409
    assert c.post(f"/api/groups/{ids[0]}/parts", json={"ids": [9999]}).status_code == 409


def test_the_group_endpoints_need_a_login_and_the_token_is_not_enough(client):
    for method, url in (("post", "/api/groups"), ("post", "/api/groups/suggest"), ("patch", "/api/groups/1"), ("post", "/api/groups/1/ungroup"),
                        ("post", "/api/groups/1/parts"), ("delete", "/api/groups/1/parts/1"), ("delete", "/api/groups/1"), ("post", "/api/groups/1/restore")):
        for headers in ({}, {"Authorization": f"Bearer {TOKEN}"}):
            assert getattr(client, method)(url, json={}, headers=headers).status_code == 401, (method, url)


# ---- migration -------------------------------------------------------------------------------------------------
OLD_SCHEMA = """
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL UNIQUE, orig_filename TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, duration_s REAL, peaks TEXT, recorded_at TEXT NOT NULL, uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inbox', tempo TEXT, bpm INTEGER, key_root TEXT, key_mode TEXT, notes TEXT NOT NULL DEFAULT '',
  rating TEXT, used_in TEXT, last_played_at TEXT, deleted_at TEXT, codec TEXT, play_status TEXT, play_filename TEXT, play_error TEXT);
CREATE TABLE tags (name TEXT PRIMARY KEY);
CREATE TABLE recording_tags (recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  tag TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE ON UPDATE CASCADE, PRIMARY KEY (recording_id, tag));
INSERT INTO tags(name) VALUES ('bass'),('drums'),('keys'),('guitar'),('harmony'),('vocal'),('melody'),('rhythmic idea'),('full song');
"""


def test_an_existing_library_gets_one_group_per_recording_and_nothing_changes(tmp_path):
    data = tmp_path / "data"
    (data / "audio").mkdir(parents=True)
    conn = sqlite3.connect(data / "riffbox.db")
    conn.executescript(OLD_SCHEMA)
    rows = [  # id, title, status, rating, used_in, bpm, recorded, uploaded, deleted, tags, notes
        (1, "Inbox idea", "inbox", None, None, None, "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", None, [], ""),
        (2, "Tagged hearted", "tagged", "heart", None, 90, "2026-01-02T10:00:00Z", "2026-01-02T10:00:00Z", None, ["bass", "keys"], "n2"),
        (3, "Song idea", "tagged", "check", "Summer", 120, "2025-12-25T12:00:00Z", "2026-01-03T10:00:00Z", None, ["vocal"], "n3"),
        (5, "In the trash", "tagged", None, None, None, "2026-01-05T10:00:00Z", "2026-01-05T10:00:00Z", "2026-02-01T00:00:00Z", ["drums"], ""),
    ]
    for rid, title, status, rating, used, bpm, rec, upl, deleted, tags, notes in rows:
        conn.execute("INSERT INTO recordings (id, title, filename, orig_filename, mime, size, sha256, recorded_at, uploaded_at, status,"
                     " rating, used_in, bpm, deleted_at, notes, duration_s) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (rid, title, f"f{rid}.wav", f"{title}.wav", "audio/wav", 100 * rid, f"sha{rid}", rec, upl, status, rating, used, bpm, deleted, notes, rid))
        for t in tags:
            conn.execute("INSERT INTO recording_tags VALUES (?, ?)", (rid, t))
    conn.commit()
    conn.close()
    cfg = {"TESTING": True, "DATA_DIR": str(data), "SECRET_KEY": "k", "PASSPHRASE": PASS, "UPLOAD_TOKEN": TOKEN,
           "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    for _ in range(2):                                                       # starting twice must not change anything again
        app = create_app(cfg)
        try:
            c = app.test_client()
            c.post("/api/login", json={"passphrase": PASS})
            live = {g["title"]: g for g in listing(c, "?rating=heart,check,x,none")}
            assert set(live) == {"Inbox idea", "Tagged hearted", "Song idea"}
            assert sorted(g["id"] for g in live.values()) == [1, 2, 3]            # a group has its recording's number
            g = live["Song idea"]
            assert (g["status"], g["rating"], g["used_in"], g["bpm"], g["tags"], g["notes"], g["part_count"]) == ("tagged", "check", "Summer", 120, ["vocal"], "n3", 1)
            assert (g["recorded_at"], g["uploaded_at"], g["duration_s"], g["size"]) == ("2025-12-25T12:00:00Z", "2026-01-03T10:00:00Z", 3.0, 300)
            assert live["Tagged hearted"]["tags"] == ["bass", "keys"] and live["Inbox idea"]["status"] == "inbox"
            assert [t["title"] for t in c.get("/api/trash").get_json()["groups"]] == ["In the trash"]
            assert c.get("/api/groups?status=inbox").get_json()["total"] == 1
        finally:
            app.extensions["riffbox"].stop()
    check = sqlite3.connect(data / "riffbox.db")
    assert check.execute("SELECT COUNT(*) FROM idea_groups").fetchone()[0] == 4          # one per recording, the trashed one included
    assert check.execute("SELECT COUNT(*) FROM recordings WHERE group_id IS NULL").fetchone()[0] == 0
    assert check.execute("SELECT title, bpm FROM recordings WHERE id = 2").fetchone() == ("Tagged hearted", 90)    # the old columns are untouched


def test_grouping_in_one_step_keeps_clashing_tempos_and_keys_to_be_picked_later(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    r = c.post("/api/groups", json={"ids": ids})                       # nothing but the ideas: no dialog, no choices
    assert r.status_code == 201
    g = r.get_json()["group"]
    assert g["bpm"] is None and sorted(x["value"] for x in g["unresolved"]["bpm"]) == [96, 120]
    assert "key" not in g["unresolved"]                                  # only one of them had a key: nothing to settle
    assert g["status"] == "tagged"                                       # stays where the ideas already were (any in the Inbox would pull it there)
    # picking one clears the flag; the other answer is gone with it
    p = c.patch(f"/api/groups/{g['id']}", json={"bpm": 96}).get_json()["group"]
    assert p["bpm"] == 96 and p["unresolved"] is None


def test_a_flag_can_be_waived_and_a_clash_is_not_invented_when_values_are_given(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    g = c.post("/api/groups", json={"ids": ids, "bpm": 100}).get_json()["group"]      # chosen up front: nothing to settle
    assert g["bpm"] == 100 and g["unresolved"] is None
    c.post(f"/api/groups/{g['id']}/ungroup")
    ids2 = [x["id"] for x in listing(c)]
    h = c.post("/api/groups", json={"ids": ids2}).get_json()["group"]
    assert h["unresolved"]
    w = c.patch(f"/api/groups/{h['id']}", json={"resolved": ["bpm", "key"]}).get_json()["group"]    # "leave it empty"
    assert w["bpm"] is None and w["unresolved"] is None
    assert c.patch(f"/api/groups/{h['id']}", json={"resolved": ["nope"]}).status_code == 400


def test_taking_parts_out_until_one_is_left_drops_the_flag(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    g = c.post("/api/groups", json={"ids": ids[:2]}).get_json()["group"]
    assert g["unresolved"]
    rec = g["parts"][0]["id"]
    after = c.delete(f"/api/groups/{g['id']}/parts/{rec}").get_json()["group"]
    assert after["unresolved"] is None


def test_the_library_can_be_filtered_to_ideas_that_need_a_tempo_or_key_choice(trio):
    c, made = trio
    ids = [g for _r, g in made.values()]
    flagged = c.post("/api/groups", json={"ids": ids[:2]}).get_json()["group"]
    assert flagged["unresolved"]
    body = c.get("/api/groups?status=tagged").get_json()
    assert body["needs"] == 1 and len(body["groups"]) == 2                      # the flagged idea and the third, single one
    only = c.get("/api/groups?status=tagged&unresolved=1").get_json()
    assert [g["id"] for g in only["groups"]] == [flagged["id"]] and only["needs"] == 1
    c.patch(f"/api/groups/{flagged['id']}", json={"bpm": 90})
    assert c.get("/api/groups?status=tagged&unresolved=1").get_json()["groups"] == []
    assert c.get("/api/groups?status=tagged").get_json()["needs"] == 0


def test_a_groups_download_is_a_zip_of_every_part_in_order(trio):
    import io
    import zipfile
    c, made = trio
    ids = [g for _r, g in made.values()]
    g = c.post("/api/groups", json={"ids": ids, "title": "Verse / idea"}).get_json()["group"]
    c.patch(f"/api/groups/{g['id']}", json={"parts": [{"id": g["parts"][2]["id"], "title": "Voice"}, {"id": g["parts"][0]["id"], "title": "Piano"},
                                                   {"id": g["parts"][1]["id"], "title": "Piano"}]})
    r = c.get(f"/api/groups/{g['id']}/download")
    assert r.status_code == 200 and r.mimetype == "application/zip" and r.headers["Cache-Control"] == "no-store"
    assert 'filename="Verse _ idea.zip"' in r.headers["Content-Disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.data))
    names = z.namelist()
    assert len(names) == 3 and all(n.startswith("Verse _ idea/") for n in names)
    assert names[0].endswith("01 Voice.wav") and names[1].endswith("02 Piano.wav") and names[2].endswith("03 Piano.wav")      # the same name twice stays distinct
    for part, name in zip(g["parts"][2:] + g["parts"][:2], names):
        assert z.read(name) == c.get(f"/api/audio/{part['id']}").data                                       # byte for byte the originals
    assert z.testzip() is None


def test_a_groups_download_needs_a_login_a_live_idea_and_its_files(trio, client):
    c, made = trio
    gid = [g for _r, g in made.values()][0]
    assert client.application.test_client().get(f"/api/groups/{gid}/download").status_code == 401
    assert c.get("/api/groups/9999/download").status_code == 404
    c.delete(f"/api/groups/{gid}")
    assert c.get(f"/api/groups/{gid}/download").status_code == 404
