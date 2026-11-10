import riffbox
from conftest import PASS, TOKEN, make_wav, upload


def bad(client, who=None, **kw):
    headers = {"X-Forwarded-For": who} if who else {}
    return client.post("/api/login", json={"passphrase": "wrong"}, headers=headers, **kw)


def good(client, who=None, **kw):
    headers = {"X-Forwarded-For": who} if who else {}
    return client.post("/api/login", json={"passphrase": PASS}, headers=headers, **kw)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def with_clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(riffbox, "_now", clock)
    return clock


# ---- upload token is add-only ------------------------------------------------
def test_token_cannot_list_library(client):
    upload(client, make_wav())
    r = client.get("/api/groups", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 401


def test_token_can_still_upload(client):
    assert upload(client, make_wav()).status_code == 201


# ---- login throttling --------------------------------------------------------
def test_sixth_attempt_is_locked_out_with_retry_after(client, monkeypatch):
    with_clock(monkeypatch)
    for _ in range(5):
        assert bad(client, "1.1.1.1").status_code == 401
    r = bad(client, "1.1.1.1")
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    assert r.get_json()["error"] == "too many attempts"


def test_correct_passphrase_is_refused_while_locked(client, monkeypatch):
    with_clock(monkeypatch)
    for _ in range(5):
        bad(client, "1.1.1.1")
    assert good(client, "1.1.1.1").status_code == 429
    assert client.get("/api/session").status_code == 401   # and no session was created


def test_lockout_expires_after_window(client, monkeypatch):
    clock = with_clock(monkeypatch)
    for _ in range(5):
        bad(client, "1.1.1.1")
    assert good(client, "1.1.1.1").status_code == 429
    clock.t += riffbox.LOGIN_WINDOW + 1
    assert good(client, "1.1.1.1").status_code == 200


def test_other_clients_are_unaffected(client, monkeypatch):
    with_clock(monkeypatch)
    for _ in range(5):
        bad(client, "1.1.1.1")
    assert bad(client, "1.1.1.1").status_code == 429
    assert good(client, "2.2.2.2").status_code == 200


def test_success_clears_that_clients_failures(client, monkeypatch):
    with_clock(monkeypatch)
    for _ in range(4):
        bad(client, "1.1.1.1")
    assert good(client, "1.1.1.1").status_code == 200
    for _ in range(4):                       # a fresh budget of failures
        assert bad(client, "1.1.1.1").status_code == 401


def test_global_cap_stops_distributed_guessing(client, monkeypatch):
    with_clock(monkeypatch)
    for i in range(riffbox.LOGIN_GLOBAL_MAX):
        assert bad(client, f"10.0.{i // 250}.{i % 250}").status_code == 401
    assert good(client, "9.9.9.9").status_code == 429


def test_forwarded_header_ignored_for_non_loopback_peers(client, monkeypatch):
    """A direct (non-relayd) peer can't dodge the limit by inventing X-Forwarded-For values."""
    with_clock(monkeypatch)
    env = {"REMOTE_ADDR": "203.0.113.5"}
    for i in range(5):
        assert bad(client, f"7.7.7.{i}", environ_overrides=env).status_code == 401
    assert bad(client, "7.7.7.99", environ_overrides=env).status_code == 429


def test_uses_last_forwarded_address(client, monkeypatch):
    with_clock(monkeypatch)
    for _ in range(5):
        bad(client, "spoofed, 5.5.5.5")
    assert bad(client, "other-spoof, 5.5.5.5").status_code == 429
