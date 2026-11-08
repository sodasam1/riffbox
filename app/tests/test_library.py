"""Phase 5: filtering, searching and sorting the library, against a small seeded collection."""
import io
import sqlite3

import pytest

from conftest import PASS, TOKEN, make_wav
from riffbox.intake import Invalid
from riffbox.library import build_query, parse_filters

# title, recorded_at, tags, tempo, bpm, key_root, key_mode, notes, status
SEED = [
    ("Funky bass riff", "2026-03-01T10:00:00Z", ["bass", "rhythmic idea"], "fast", 118, "D", "minor", "hummed over Dm", "tagged"),
    ("Dreamy keys", "2026-03-05T10:00:00Z", ["keys", "harmony"], "slow", 70, "C", "major", "pad with 100% reverb", "tagged"),
    ("Drum loop", "2026-02-20T10:00:00Z", ["drums", "rhythmic idea"], "medium", 100, None, None, "snare_roll idea", "tagged"),
    ("Vocal hook", "2026-03-10T10:00:00Z", ["vocal", "melody"], "medium", None, "D", "major", "", "tagged"),
    ("Full demo", "2026-01-15T10:00:00Z", ["full song", "bass", "drums", "keys"], "fast", 140, "Eb", "minor", "everything", "tagged"),
    ("Guitar lick", "2026-03-12T10:00:00Z", ["guitar", "melody"], "fast", 130, "E", "minor", "", "tagged"),
    ("Untagged scrap", "2026-03-15T10:00:00Z", [], None, None, None, None, "", "inbox"),
    ("Café melody", "2026-02-01T10:00:00Z", ["melody"], None, None, None, None, "Bass line maybe", "tagged"),
    ("Deleted bass", "2026-02-10T10:00:00Z", ["bass"], "fast", 120, None, None, "", "tagged"),
]


@pytest.fixture
def lib(app, client):
    """Seeded library; returns a function get(**query) -> list of titles, in the order returned."""
    ids = {}
    for i, (title, rec_at, tags, tempo, bpm, root, mode, notes, status) in enumerate(SEED):
        r = client.post("/api/upload", data={"file": (io.BytesIO(make_wav(freq_seed=i + 1)), f"m{i}.wav"),
                                              "title": title, "recorded_at": rec_at},
                        headers={"Authorization": f"Bearer {TOKEN}"}, content_type="multipart/form-data")
        ids[title] = r.get_json()["id"]
    client.post("/api/login", json={"passphrase": PASS})
    for (title, _r, tags, tempo, bpm, root, mode, notes, status) in SEED:
        r = client.patch(f"/api/recordings/{ids[title]}", json={
            "tags": tags, "tempo": tempo, "bpm": bpm, "key_root": root, "key_mode": mode,
            "notes": notes, "status": status})
        assert r.status_code == 200, r.get_json()
    with sqlite3.connect(app.config["DB_PATH"]) as conn:        # distinct upload times; one deleted
        for n, (title, *_rest) in enumerate(SEED):
            conn.execute("UPDATE recordings SET uploaded_at = ? WHERE id = ?",
                         (f"2026-04-{n + 1:02d}T00:00:00Z", ids[title]))
        conn.execute("UPDATE recordings SET deleted_at = '2026-05-01T00:00:00Z' WHERE id = ?", (ids["Deleted bass"],))

    def get(expect=200, **q):
        r = client.get("/api/recordings", query_string=q)
        assert r.status_code == expect, r.get_json()
        return [x["title"] for x in r.get_json()["recordings"]] if expect == 200 else r.get_json()

    get.client, get.ids = client, ids
    return get


def names(titles):
    return sorted(titles)


# ---- basics -----------------------------------------------------------------------------------
def test_no_filters_returns_everything_not_deleted_newest_recorded_first(lib):
    assert lib() == ["Untagged scrap", "Guitar lick", "Vocal hook", "Dreamy keys", "Funky bass riff",
                     "Drum loop", "Café melody", "Full demo"]


def test_count_and_total(lib):
    body = lib.client.get("/api/recordings?status=tagged&tags=bass").get_json()
    assert (body["count"], body["total"]) == (2, 7)          # Funky + Full demo of 7 tagged (deleted excluded)
    body = lib.client.get("/api/recordings?status=inbox").get_json()
    assert (body["count"], body["total"]) == (1, 1)


def test_status(lib):
    assert lib(status="inbox") == ["Untagged scrap"]
    assert "Untagged scrap" not in lib(status="tagged") and len(lib(status="tagged")) == 7


# ---- tags -------------------------------------------------------------------------------------
def test_tags_all(lib):
    assert lib(tags="bass,drums") == ["Full demo"]
    assert lib(tags="bass,rhythmic idea") == ["Funky bass riff"]
    assert names(lib(tags="melody")) == ["Café melody", "Guitar lick", "Vocal hook"]


def test_tags_any(lib):
    assert names(lib(tags="bass,drums", match="any")) == ["Drum loop", "Full demo", "Funky bass riff"]
    assert names(lib(tags="vocal,guitar", match="any")) == ["Guitar lick", "Vocal hook"]


def test_tag_names_are_normalised_and_spaces_after_commas_are_fine(lib):
    assert lib(tags="  Bass , DRUMS ") == ["Full demo"]
    assert lib(tags="bass,bass") == lib(tags="bass")           # repeats do not make it stricter


def test_unknown_tag(lib):
    assert lib(tags="nonexistent") == []
    assert lib(tags="bass,nonexistent") == []                  # all: nothing has both
    assert names(lib(tags="bass,nonexistent", match="any")) == ["Full demo", "Funky bass riff"]


# ---- tempo and key ----------------------------------------------------------------------------
def test_tempo(lib):
    assert names(lib(tempo="fast")) == ["Full demo", "Funky bass riff", "Guitar lick"]
    assert names(lib(tempo="slow,medium")) == ["Dreamy keys", "Drum loop", "Vocal hook"]


def test_key(lib):
    assert names(lib(key_root="D")) == ["Funky bass riff", "Vocal hook"]
    assert lib(key_root="D", key_mode="minor") == ["Funky bass riff"]
    assert names(lib(key_mode="minor")) == ["Full demo", "Funky bass riff", "Guitar lick"]
    assert lib(key_root="F#") == []


def test_filters_combine_with_and_between_kinds(lib):
    assert names(lib(tags="bass,melody", match="any", tempo="fast")) == ["Full demo", "Funky bass riff", "Guitar lick"]
    assert lib(tags="bass,melody", match="any", tempo="fast", key_root="E") == ["Guitar lick"]
    assert lib(tags="rhythmic idea", tempo="fast", key_mode="minor", q="riff") == ["Funky bass riff"]


# ---- BPM range --------------------------------------------------------------------------------
def test_bpm_min_only(lib):
    assert names(lib(bpm_min="118")) == ["Full demo", "Funky bass riff", "Guitar lick"]     # 118 itself is included


def test_bpm_max_only(lib):
    assert names(lib(bpm_max="100")) == ["Dreamy keys", "Drum loop"]                          # 100 itself is included


def test_bpm_range_is_inclusive_at_both_ends(lib):
    assert names(lib(bpm_min="100", bpm_max="118")) == ["Drum loop", "Funky bass riff"]
    assert lib(bpm_min="118", bpm_max="118") == ["Funky bass riff"]
    assert lib(bpm_min="119", bpm_max="129") == []


def test_recordings_with_no_bpm_never_match_a_bpm_filter(lib):
    wide = lib(bpm_min="20", bpm_max="400")
    assert "Vocal hook" not in wide and "Café melody" not in wide and "Untagged scrap" not in wide
    assert len(wide) == 5
    assert len(lib()) == 8                                       # ...but they are all there with no filter


def test_bpm_range_combines_with_other_filters(lib):
    assert lib(bpm_min="120", tags="melody") == ["Guitar lick"]
    assert lib(bpm_min="100", key_mode="minor", status="tagged", sort="bpm") == ["Full demo", "Guitar lick", "Funky bass riff"]
    assert lib(bpm_max="120", q="loop") == ["Drum loop"]


def test_blank_bpm_values_mean_no_limit(lib):
    assert len(lib(bpm_min="", bpm_max="")) == 8


@pytest.mark.parametrize("query", [
    {"bpm_min": "abc"}, {"bpm_max": "12.5"}, {"bpm_min": "19"}, {"bpm_max": "401"}, {"bpm_min": "-5"},
    {"bpm_min": "120", "bpm_max": "100"}, {"bpm_min": "1e2"}, {"bpm_max": "100; DROP TABLE recordings"},
])
def test_bad_bpm_values_are_rejected(lib, query):
    assert "error" in lib(expect=400, **query)
    assert len(lib()) == 8


# ---- search -----------------------------------------------------------------------------------
def test_search_matches_title_notes_and_tag_names(lib):
    assert names(lib(q="bass")) == ["Café melody", "Full demo", "Funky bass riff"]   # notes, tag, title
    assert lib(q="reverb") == ["Dreamy keys"]                                         # notes only
    assert names(lib(q="rhythmic")) == ["Drum loop", "Funky bass riff"]               # tag name only
    assert lib(q="untagged") == ["Untagged scrap"]                                    # title only


def test_search_words_must_all_match_and_ignore_case(lib):
    assert lib(q="bass riff") == ["Funky bass riff"]
    assert lib(q="BASS RIFF") == ["Funky bass riff"]
    assert lib(q="bass zebra") == []
    assert lib(q="   ") == lib()


def test_search_treats_percent_and_underscore_literally(lib):
    assert lib(q="100%") == ["Dreamy keys"]                    # not a wildcard that matches everything
    assert lib(q="snare_roll") == ["Drum loop"]
    assert lib(q="snare-roll") == []
    assert lib(q="_") == ["Drum loop"]                         # only the title/notes/tags that contain "_"
    assert lib(q="%") == ["Dreamy keys"]


def test_search_with_other_filters(lib):
    assert lib(q="bass", tempo="fast", status="tagged") == ["Funky bass riff", "Full demo"]   # newest recorded first
    assert lib(q="melody", tags="guitar") == ["Guitar lick"]


# ---- sorting ----------------------------------------------------------------------------------
def test_sort_recorded(lib):
    asc = lib(sort="recorded", order="asc")
    assert asc[0] == "Full demo" and asc[-1] == "Untagged scrap"
    assert asc == list(reversed(lib(sort="recorded", order="desc")))


def test_sort_uploaded(lib):
    # uploaded_at was set to one day per seed row, in seed order (the deleted one is excluded)
    order = [s[0] for s in SEED if s[0] != "Deleted bass"]
    assert lib(sort="uploaded", order="asc") == order
    assert lib(sort="uploaded", order="desc") == list(reversed(order))


def test_sort_title_ignores_case_and_defaults_to_a_to_z(lib):
    assert lib(sort="title") == ["Café melody", "Dreamy keys", "Drum loop", "Full demo", "Funky bass riff",
                                 "Guitar lick", "Untagged scrap", "Vocal hook"]
    assert lib(sort="title", order="desc")[0] == "Vocal hook"


def test_sort_bpm_puts_missing_values_last_both_ways(lib):
    desc = lib(sort="bpm", status="tagged")
    assert desc[:5] == ["Full demo", "Guitar lick", "Funky bass riff", "Drum loop", "Dreamy keys"]
    assert set(desc[5:]) == {"Vocal hook", "Café melody"}
    asc = lib(sort="bpm", order="asc", status="tagged")
    assert asc[:5] == ["Dreamy keys", "Drum loop", "Funky bass riff", "Guitar lick", "Full demo"]
    assert set(asc[5:]) == {"Vocal hook", "Café melody"}


def test_ties_break_by_newest_upload_first(app, lib):
    with sqlite3.connect(app.config["DB_PATH"]) as conn:
        conn.execute("UPDATE recordings SET recorded_at = '2026-01-01T00:00:00Z'")
    ids = [x["id"] for x in lib.client.get("/api/recordings").get_json()["recordings"]]
    assert ids == sorted(ids, reverse=True)


# ---- validation -------------------------------------------------------------------------------
@pytest.mark.parametrize("query", [
    {"tempo": "ludicrous"}, {"tempo": "fast,ludicrous"}, {"key_root": "H"}, {"key_mode": "dorian"},
    {"sort": "popularity"}, {"order": "sideways"}, {"match": "some"}, {"status": "done"},
    {"q": "x" * 201}, {"tags": "<script>"}, {"tags": ",".join(f"t{i}" for i in range(31))},
])
def test_bad_values_are_rejected(lib, query):
    assert "error" in lib(expect=400, **query)


# ---- safety -----------------------------------------------------------------------------------
@pytest.mark.parametrize("q", ["'; DROP TABLE recordings; --", "\" OR 1=1 --", "x') UNION SELECT * FROM tags --",
                               "\\", "%' ESCAPE '"])
def test_search_text_is_never_run_as_sql(lib, q):
    lib(q=q)                                                  # no error, and ...
    assert len(lib()) == 8                                    # ... the table is intact


def test_sort_cannot_be_used_to_inject_sql(lib):
    lib(expect=400, sort="title; DROP TABLE recordings")
    lib(expect=400, order="asc; DROP TABLE recordings")
    assert len(lib()) == 8


def test_built_sql_contains_none_of_the_request_text():
    f = parse_filters({"q": "zzz'; drop table x; --", "tags": "bass", "tempo": "fast", "key_root": "D"})
    sql, params = build_query(f)
    assert "zzz" not in sql and "drop" not in sql.lower()
    assert any("zzz" in str(p) for p in params)


# ---- access -----------------------------------------------------------------------------------
def test_requires_a_session_and_the_token_cannot_read(client):
    assert client.get("/api/recordings?q=bass").status_code == 401
    assert client.get("/api/recordings", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_parse_filters_defaults():
    f = parse_filters({})
    assert (f["status"], f["terms"], f["tags"], f["match"], f["sort"], f["order"]) == (None, [], [], "all", "recorded", "desc")
    with pytest.raises(Invalid):
        parse_filters({"tags": "bad<tag"})
