"""Phase 8: delete only moves a recording to the Trash; restore brings it back; nothing leaves the disk."""
from conftest import make_wav, upload


def make(authed, seed=0, title="t"):
    return upload(authed, make_wav(freq_seed=seed), f"{seed}.wav", title=title).get_json()["id"]


def titles(authed, query=""):
    return [r["title"] for r in authed.get("/api/groups" + query).get_json()["groups"]]


def test_delete_hides_everywhere_but_keeps_the_file(authed, app):
    keep, gone = make(authed, 1, "keep"), make(authed, 2, "gone")
    authed.patch(f"/api/recordings/{gone}", json={"status": "tagged", "tags": ["bass"]})
    on_disk = len(list(app.config["AUDIO_DIR"].glob("*.wav")))
    assert authed.delete(f"/api/recordings/{gone}").status_code == 200
    assert titles(authed) == ["keep"]
    assert authed.get("/api/groups?status=tagged").get_json()["total"] == 0
    assert authed.get("/api/groups?tags=bass").get_json()["count"] == 0
    for url in (f"/api/audio/{gone}", f"/api/play/{gone}", f"/api/recordings/{gone}/analysis"):
        assert authed.get(url).status_code == 404
    assert authed.patch(f"/api/recordings/{gone}", json={"title": "x"}).status_code == 404
    assert authed.delete(f"/api/recordings/{gone}").status_code == 404           # already in the Trash
    assert len(list(app.config["AUDIO_DIR"].glob("*.wav"))) == on_disk            # nothing removed from disk
    assert keep


def test_trash_lists_deleted_ones_and_restore_returns_them_intact(authed):
    rid = make(authed, 3, "precious")
    authed.patch(f"/api/recordings/{rid}", json={"status": "tagged", "tags": ["keys"], "notes": "n", "rating": "heart", "bpm": 90})
    authed.delete(f"/api/recordings/{rid}")
    body = authed.get("/api/groups").get_json()
    assert body["trashed"] == 1 and body["groups"] == []
    trash = authed.get("/api/trash").get_json()["groups"]
    assert [r["title"] for r in trash] == ["precious"] and trash[0]["deleted_at"]
    r = authed.post(f"/api/recordings/{rid}/restore")
    assert r.status_code == 200
    back = r.get_json()["recording"]
    assert (back["status"], back["tags"], back["notes"], back["rating"], back["bpm"]) == ("tagged", ["keys"], "n", "heart", 90)
    assert authed.get("/api/trash").get_json()["groups"] == []
    assert authed.get(f"/api/audio/{rid}").status_code == 200
    assert authed.post(f"/api/recordings/{rid}/restore").status_code == 404      # not in the Trash any more


def test_restore_is_refused_when_the_same_audio_was_uploaded_again(authed):
    first = make(authed, 4, "original")
    authed.delete(f"/api/recordings/{first}")
    again = make(authed, 4, "uploaded again")
    assert again != first                                       # a trashed file does not count as a duplicate
    r = authed.post(f"/api/recordings/{first}/restore")
    assert r.status_code == 409 and "uploaded again" in r.get_json()["error"]


def test_trash_needs_a_login_and_the_upload_token_cannot_use_it(client):
    from conftest import TOKEN
    auth = {"Authorization": f"Bearer {TOKEN}"}
    for method, url in (("get", "/api/trash"), ("delete", "/api/recordings/1"), ("post", "/api/recordings/1/restore")):
        assert getattr(client, method)(url).status_code == 401
        assert getattr(client, method)(url, headers=auth).status_code == 401
