"""Phase 4: intake form rules, tags, PATCH, and inbox/tagged filtering."""
import io

import pytest

from conftest import PASS, TOKEN, make_wav
from riffbox.intake import Invalid, normalize_tag, parse_instant, validate_patch

SEEDED = ["bass", "drums", "keys", "guitar", "harmony", "vocal", "melody", "rhythmic idea", "full song"]
KNOWN = set(SEEDED)


# ---- pure rules --------------------------------------------------------------------------------
@pytest.mark.parametrize("raw,expected", [
    ("Bass", "bass"), ("  Rhythmic   IDEA ", "rhythmic idea"), ("lo-fi", "lo-fi"),
    ("808s & clicks", "808s & clicks"), ("piano/keys", "piano/keys"), ("Café", "café"),
    ("a\nb", "a b"),                      # a newline is just whitespace, like a space
])
def test_normalize_tag_accepts(raw, expected):
    assert normalize_tag(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "x" * 31, "<script>", "a\x07b", "a\x00b", "-leading", None, 5, ["a"]])
def test_normalize_tag_rejects(raw):
    with pytest.raises(Invalid):
        normalize_tag(raw)


def check(body, known=KNOWN):
    return validate_patch(body, known, "Idea, default")


def test_empty_body_is_valid_and_changes_nothing():
    assert check({}) == ({}, None)


def test_every_field_round_trips():
    cols, tags = check({"title": " Riff ", "tempo": "fast", "bpm": 120, "key_root": "Eb", "key_mode": "minor",
                        "notes": " hummed ", "status": "tagged", "tags": ["Bass", "drums", "bass"]})
    assert cols == {"title": "Riff", "tempo": "fast", "bpm": 120, "key_root": "Eb", "key_mode": "minor",
                    "notes": "hummed", "status": "tagged"}
    assert tags == ["bass", "drums"]                      # normalised and de-duplicated, order kept


def test_null_clears_optional_fields():
    cols, _ = check({"tempo": None, "bpm": None, "key_root": None, "key_mode": None})
    assert cols == {"tempo": None, "bpm": None, "key_root": None, "key_mode": None}


def test_blank_title_falls_back_to_default():
    assert check({"title": "   "})[0] == {"title": "Idea, default"}


@pytest.mark.parametrize("body", [
    {"tempo": "ludicrous"}, {"bpm": 19}, {"bpm": 401}, {"bpm": 120.5}, {"bpm": "120"}, {"bpm": True},
    {"key_root": "H"}, {"key_root": "c"}, {"key_mode": "dorian"}, {"status": "done"}, {"status": None},
    {"title": 5}, {"title": "t" * 201}, {"notes": ["x"]}, {"notes": "n" * 5001},
    {"tags": "bass"}, {"tags": ["nonexistent"]}, {"tags": [None]}, {"tags": ["bass"] * 2 + [f"t{i}" for i in range(31)]},
    {"id": 4}, {"sha256": "x"}, {"filename": "../x"}, {"last_played_at": "2026-01-01T00:00:00Z"}, {"play_status": "ready"},
])
def test_rejects_bad_values_and_unknown_fields(body):
    with pytest.raises(Invalid):
        check(body)


# ---- HTTP --------------------------------------------------------------------------------------
def upload(client, seed=0, name="memo.wav"):
    r = client.post("/api/upload", data={"file": (io.BytesIO(make_wav(freq_seed=seed)), name)},
                    headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
    return r.get_json()["id"]


@pytest.fixture
def c(client):
    assert client.post("/api/login", json={"passphrase": PASS}).status_code == 200
    return client


def ids(resp):
    return [r["id"] for r in resp.get_json()["recordings"]]


def test_seeded_tags_in_order(c):
    assert c.get("/api/tags").get_json() == {"tags": SEEDED}


def test_create_tag_normalises_is_idempotent_and_keeps_order(c):
    r = c.post("/api/tags", json={"name": "  Beat   Box "})
    assert (r.status_code, r.get_json()) == (201, {"name": "beat box", "created": True})
    r = c.post("/api/tags", json={"name": "BEAT BOX"})
    assert (r.status_code, r.get_json()) == (200, {"name": "beat box", "created": False})
    assert c.get("/api/tags").get_json()["tags"] == SEEDED + ["beat box"]


@pytest.mark.parametrize("body", [{}, {"name": ""}, {"name": "x" * 31}, {"name": 3}, "text", [1]])
def test_create_tag_rejects_bad_input(c, body):
    assert c.post("/api/tags", json=body).status_code == 400


def test_tag_count_is_capped(c, app):
    from riffbox.intake import MAX_TAGS_TOTAL
    have = len(c.get("/api/tags").get_json()["tags"])
    for i in range(MAX_TAGS_TOTAL - have):
        assert c.post("/api/tags", json={"name": f"tag {i}"}).status_code == 201
    assert c.post("/api/tags", json={"name": "one too many"}).status_code == 400


def test_new_upload_starts_in_inbox_with_no_tags(c, client):
    rid = upload(client)
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert (rec["id"], rec["status"], rec["tags"]) == (rid, "inbox", [])


def test_patch_full_round_trip_and_leaves_inbox(c, client):
    rid = upload(client)
    r = c.patch(f"/api/recordings/{rid}", json={
        "title": "Funky bass riff", "tags": ["rhythmic idea", "bass"], "tempo": "fast", "bpm": 118,
        "key_root": "D", "key_mode": "minor", "notes": "hummed over Dm", "status": "tagged"})
    assert r.status_code == 200
    rec = r.get_json()["recording"]
    assert rec["title"] == "Funky bass riff" and rec["status"] == "tagged"
    assert rec["tags"] == ["bass", "rhythmic idea"]                       # global tag order, not request order
    assert (rec["tempo"], rec["bpm"], rec["key_root"], rec["key_mode"]) == ("fast", 118, "D", "minor")
    assert rec["notes"] == "hummed over Dm"
    assert c.get("/api/recordings").get_json()["recordings"][0] == rec     # list agrees with PATCH answer
    assert ids(c.get("/api/recordings?status=inbox")) == []
    assert ids(c.get("/api/recordings?status=tagged")) == [rid]


def test_saving_an_empty_form_is_allowed(c, client):
    rid = upload(client)
    r = c.patch(f"/api/recordings/{rid}", json={"status": "tagged"})        # nothing else filled in
    assert r.status_code == 200 and r.get_json()["recording"]["status"] == "tagged"
    assert c.patch(f"/api/recordings/{rid}", json={}).status_code == 200    # and a no-op is fine


def test_partial_patch_leaves_other_fields_alone(c, client):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"tempo": "slow", "tags": ["keys"], "notes": "n"})
    rec = c.patch(f"/api/recordings/{rid}", json={"bpm": 90}).get_json()["recording"]
    assert (rec["tempo"], rec["tags"], rec["notes"], rec["bpm"]) == ("slow", ["keys"], "n", 90)


def test_clearing_fields_and_tags(c, client):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"tempo": "slow", "bpm": 80, "tags": ["keys", "bass"]})
    rec = c.patch(f"/api/recordings/{rid}", json={"tempo": None, "bpm": None, "tags": []}).get_json()["recording"]
    assert (rec["tempo"], rec["bpm"], rec["tags"]) == (None, None, [])


def test_blank_title_resets_to_default(c, client):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"title": "Custom"})
    rec = c.patch(f"/api/recordings/{rid}", json={"title": ""}).get_json()["recording"]
    assert rec["title"].startswith("Idea, ")


def test_can_move_back_to_inbox(c, client):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"status": "tagged"})
    c.patch(f"/api/recordings/{rid}", json={"status": "inbox"})
    assert ids(c.get("/api/recordings?status=inbox")) == [rid]


def test_failed_patch_changes_nothing(c, client):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"tempo": "slow", "tags": ["keys"]})
    r = c.patch(f"/api/recordings/{rid}", json={"tempo": "fast", "tags": ["nonexistent"]})
    assert r.status_code == 400 and "nonexistent" in r.get_json()["error"]
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert (rec["tempo"], rec["tags"]) == ("slow", ["keys"])               # all-or-nothing


def test_patch_error_cases(c, client):
    rid = upload(client)
    assert c.patch("/api/recordings/9999", json={"notes": "x"}).status_code == 404
    assert c.patch(f"/api/recordings/{rid}", data="not json", content_type="text/plain").status_code == 400
    assert c.patch(f"/api/recordings/{rid}", json=["list"]).status_code == 400
    assert c.patch(f"/api/recordings/{rid}", json={"rating": "love"}).status_code == 400     # not one of the three marks
    assert c.patch(f"/api/recordings/{rid}", json={"sha256": "x"}).status_code == 400


def test_list_status_filter_validates(c):
    assert c.get("/api/recordings?status=nonsense").status_code == 400


def test_auth_required_and_token_is_add_only(client):
    rid = upload(client)
    tok = {"Authorization": f"Bearer {TOKEN}"}
    assert client.patch(f"/api/recordings/{rid}", json={"notes": "x"}).status_code == 401
    assert client.patch(f"/api/recordings/{rid}", json={"notes": "x"}, headers=tok).status_code == 401
    assert client.get("/api/tags").status_code == 401
    assert client.get("/api/tags", headers=tok).status_code == 401
    assert client.post("/api/tags", json={"name": "x"}, headers=tok).status_code == 401


def test_deleted_recordings_are_not_editable(c, client, app):
    import sqlite3
    rid = upload(client)
    with sqlite3.connect(app.config["DB_PATH"]) as conn:
        conn.execute("UPDATE recordings SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?", (rid,))
    assert c.patch(f"/api/recordings/{rid}", json={"notes": "x"}).status_code == 404


def test_tags_survive_per_recording_independently(c, client):
    a, b = upload(client, 1), upload(client, 2)
    c.patch(f"/api/recordings/{a}", json={"tags": ["bass"]})
    c.patch(f"/api/recordings/{b}", json={"tags": ["drums", "bass"]})
    by_id = {r["id"]: r["tags"] for r in c.get("/api/recordings").get_json()["recordings"]}
    assert by_id == {a: ["bass"], b: ["bass", "drums"]}


# ---- date recorded: always stored, next to the date uploaded; blank means "same as uploaded" --------------
def test_parse_instant_accepts_timestamps_and_normalises_to_utc():
    assert parse_instant("2026-03-01T12:00:00Z") == "2026-03-01T12:00:00Z"
    assert parse_instant("2026-03-01T12:00:00+13:00") == "2026-02-28T23:00:00Z"      # local noon in Auckland
    assert parse_instant("2026-03-01T12:00:00.123Z") == "2026-03-01T12:00:00Z"
    assert parse_instant("2026-03-01T12:00:00") == "2026-03-01T12:00:00Z"             # no zone given: taken as UTC
    assert parse_instant("1950-01-02T00:00:00Z").startswith("1950")


def test_parse_instant_rejects_nonsense():
    import datetime as dt
    soon = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for bad in ["yesterday", "", "2026-02-30T12:00:00Z", "1949-12-31T00:00:00Z", soon, 5, None, ["2026-03-01"], "9" * 50]:
        with pytest.raises(Invalid):
            parse_instant(bad)


def test_recorded_at_in_a_patch_body():
    cols, _ = validate_patch({"recorded_at": "2026-03-01T12:00:00Z"}, KNOWN, "t", "2026-03-09T08:00:00Z")
    assert cols == {"recorded_at": "2026-03-01T12:00:00Z"}
    for blank in (None, ""):                                      # blank: the date recorded is the date uploaded
        cols, _ = validate_patch({"recorded_at": blank}, KNOWN, "t", "2026-03-09T08:00:00Z")
        assert cols == {"recorded_at": "2026-03-09T08:00:00Z"}
    with pytest.raises(Invalid):
        validate_patch({"recorded_at": None}, KNOWN, "t")          # nothing to fall back to


def test_upload_fills_both_dates_with_the_upload_time(c, client):
    upload(client)
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert rec["recorded_at"] == rec["uploaded_at"] and rec["uploaded_at"].endswith("Z")


def test_entering_a_date_recorded_stores_both_and_clearing_goes_back(c, client):
    rid = upload(client)
    first = c.get("/api/recordings").get_json()["recordings"][0]
    rec = c.patch(f"/api/recordings/{rid}", json={"recorded_at": "2025-12-25T12:00:00Z"}).get_json()["recording"]
    assert rec["recorded_at"] == "2025-12-25T12:00:00Z"
    assert rec["uploaded_at"] == first["uploaded_at"]               # the upload date is kept separately, untouched
    again = c.get("/api/recordings").get_json()["recordings"][0]
    assert (again["recorded_at"], again["uploaded_at"]) == ("2025-12-25T12:00:00Z", first["uploaded_at"])
    for blank in ("", None):
        c.patch(f"/api/recordings/{rid}", json={"recorded_at": "2025-12-25T12:00:00Z"})
        cleared = c.patch(f"/api/recordings/{rid}", json={"recorded_at": blank}).get_json()["recording"]
        assert cleared["recorded_at"] == cleared["uploaded_at"] == first["uploaded_at"]


@pytest.mark.parametrize("value", ["not a date", "2026-02-30T12:00:00Z", "1900-01-01T00:00:00Z", "2999-01-01T00:00:00Z", 5])
def test_a_bad_date_recorded_is_rejected_and_nothing_else_changes(c, client, value):
    rid = upload(client)
    c.patch(f"/api/recordings/{rid}", json={"recorded_at": "2025-12-25T12:00:00Z", "notes": "n"})
    r = c.patch(f"/api/recordings/{rid}", json={"recorded_at": value, "notes": "changed"})
    assert r.status_code == 400
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert (rec["recorded_at"], rec["notes"]) == ("2025-12-25T12:00:00Z", "n")


def test_recorded_sort_follows_the_date_recorded(c, client):
    def up(seed, when):
        r = client.post("/api/upload", data={"file": (io.BytesIO(make_wav(freq_seed=seed)), f"s{seed}.wav"),
                                              "recorded_at": when, "title": f"t{seed}"},
                        headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
        return r.get_json()["id"]
    up(1, "2026-03-10T10:00:00Z")
    b = up(2, "2026-03-01T10:00:00Z")
    up(3, "2026-01-01T10:00:00Z")
    def order(**q):
        return [x["title"] for x in c.get("/api/recordings", query_string=q).get_json()["recordings"]]
    assert order(sort="recorded") == ["t1", "t2", "t3"]
    c.patch(f"/api/recordings/{b}", json={"recorded_at": "2026-03-20T12:00:00Z"})     # the owner says b is the newest
    assert order(sort="recorded") == ["t2", "t1", "t3"]
    assert order(sort="recorded", order="asc") == ["t3", "t1", "t2"]
    assert order(sort="uploaded").count("t1") == 1                                      # the upload date is a separate sort


# ---- ratings: heart / check / x, "used in" for a check, and filtering by mark ----------------------------
def test_rating_and_used_in_rules():
    for r in ("heart", "check", "x", None):
        assert check({"rating": r})[0] == {"rating": r}
    for bad in ("love", "HEART", "", 1, True, ["heart"]):
        with pytest.raises(Invalid):
            check({"rating": bad})
    assert check({"used_in": "  Song A  "})[0] == {"used_in": "Song A"}
    assert check({"used_in": "   "})[0] == {"used_in": None}
    assert check({"used_in": None})[0] == {"used_in": None}
    for bad in (5, ["x"], "s" * 201):
        with pytest.raises(Invalid):
            check({"used_in": bad})


def test_a_new_recording_has_no_mark(c, client):
    upload(client)
    rec = c.get("/api/recordings").get_json()["recordings"][0]
    assert (rec["rating"], rec["used_in"]) == (None, None)


def test_marking_round_trip(c, client):
    rid = upload(client)
    for mark in ("heart", "check", "x"):
        assert c.patch(f"/api/recordings/{rid}", json={"rating": mark}).get_json()["recording"]["rating"] == mark
    assert c.get("/api/recordings").get_json()["recordings"][0]["rating"] == "x"
    assert c.patch(f"/api/recordings/{rid}", json={"rating": None}).get_json()["recording"]["rating"] is None


def test_used_in_belongs_to_a_check(c, client):
    rid = upload(client)
    both = c.patch(f"/api/recordings/{rid}", json={"rating": "check", "used_in": "Song A"}).get_json()["recording"]
    assert (both["rating"], both["used_in"]) == ("check", "Song A")
    # editing only the song name keeps the check
    assert c.patch(f"/api/recordings/{rid}", json={"used_in": "Song B"}).get_json()["recording"]["used_in"] == "Song B"
    # a song name without a check is refused, and nothing changes
    c.patch(f"/api/recordings/{rid}", json={"rating": "heart"})
    r = c.patch(f"/api/recordings/{rid}", json={"used_in": "Song C", "notes": "changed"})
    assert r.status_code == 400 and "only applies" in r.get_json()["error"]
    assert c.get("/api/recordings").get_json()["recordings"][0]["notes"] == ""


def test_moving_away_from_check_clears_the_song_name(c, client):
    rid = upload(client)
    for away in ("heart", "x", None):
        c.patch(f"/api/recordings/{rid}", json={"rating": "check", "used_in": "Song A"})
        rec = c.patch(f"/api/recordings/{rid}", json={"rating": away}).get_json()["recording"]
        assert (rec["rating"], rec["used_in"]) == (away, None), away
    # ...unless a (blank) song name is sent with it
    rec = c.patch(f"/api/recordings/{rid}", json={"rating": "check", "used_in": ""}).get_json()["recording"]
    assert (rec["rating"], rec["used_in"]) == ("check", None)


def test_ratings_need_a_session_and_the_token_cannot_set_them(c, client):
    rid = upload(client)
    tok = {"Authorization": f"Bearer {TOKEN}"}
    fresh = client.application.test_client()
    assert fresh.patch(f"/api/recordings/{rid}", json={"rating": "heart"}).status_code == 401
    assert fresh.patch(f"/api/recordings/{rid}", json={"rating": "heart"}, headers=tok).status_code == 401
