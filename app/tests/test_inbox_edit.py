"""A recording can be edited and partly filled in while it is still in the Inbox; only status moves it out."""
from conftest import make_wav, upload


def inbox(c):
    return c.get("/api/groups?status=inbox").get_json()["groups"]


def test_a_partial_save_leaves_the_recording_in_the_inbox(authed):
    rid = upload(authed, make_wav(), "a.wav", title="raw memo").get_json()["id"]
    r = authed.patch(f"/api/recordings/{rid}", json={"title": "Chorus idea", "tags": ["bass"], "bpm": 96, "notes": "half done"})
    assert r.status_code == 200 and r.get_json()["recording"]["status"] == "inbox"
    row = inbox(authed)[0]
    assert (row["title"], row["tags"], row["bpm"], row["notes"], row["key_root"]) == ("Chorus idea", ["bass"], 96, "half done", None)
    assert authed.get("/api/groups?status=tagged").get_json()["groups"] == []
    # later: fill in more, still without moving it
    authed.patch(f"/api/recordings/{rid}", json={"key_root": "A", "key_mode": "minor", "rating": "heart"})
    row = inbox(authed)[0]
    assert (row["title"], row["key_root"], row["key_mode"], row["rating"], row["tags"]) == ("Chorus idea", "A", "minor", "heart", ["bass"])
    # only an explicit status moves it, and the details come along
    assert authed.patch(f"/api/recordings/{rid}", json={"status": "tagged"}).get_json()["recording"]["status"] == "tagged"
    lib = authed.get("/api/groups?status=tagged").get_json()["groups"][0]
    assert (lib["title"], lib["bpm"], lib["tags"]) == ("Chorus idea", 96, ["bass"]) and inbox(authed) == []
