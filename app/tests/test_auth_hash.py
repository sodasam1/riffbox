"""Hashed passphrase login (auth.py, passwords.py): the stored value is only a salted hash, the old plain setting still works for
now, and nothing else about login, the attempt limit or the add-only token changed."""
import logging

import pytest

import riffbox
from riffbox import passwords
from conftest import TOKEN, make_wav

LONG = "correct horse battery staple"


@pytest.fixture(scope="module")
def stored_hash():
    return passwords.hash_passphrase(LONG)


def make_app(tmp_path, **cfg):
    base = {"TESTING": True, "DATA_DIR": str(tmp_path / "data"), "UPLOAD_TOKEN": TOKEN, "SECRET_KEY": "k",
            "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}
    base.update(cfg)
    return riffbox.create_app(base)


def login(client, phrase, who="9.9.9.9"):
    return client.post("/api/login", json={"passphrase": phrase}, headers={"X-Forwarded-For": who})


# ---- the hash itself -------------------------------------------------------------------------------
def test_hash_does_not_contain_the_passphrase(stored_hash):
    assert LONG not in stored_hash and "horse" not in stored_hash


def test_two_hashes_of_one_passphrase_differ(stored_hash):
    assert passwords.hash_passphrase(LONG) != stored_hash          # random salt


def test_verify_right_wrong_and_garbage(stored_hash):
    assert passwords.verify(stored_hash, LONG)
    assert not passwords.verify(stored_hash, LONG + "x")
    assert not passwords.verify(stored_hash, "")
    for junk in ("", None, "plain-text", "scrypt:1:2:3$salt$zz", "$$$"):
        assert passwords.verify(junk, LONG) is False


def test_short_passphrase_refused_when_choosing_not_when_upgrading():
    with pytest.raises(ValueError):
        passwords.hash_passphrase("short")
    assert passwords.verify(passwords.hash_passphrase("short", check_length=False), "short")


def test_method_is_named_in_the_hash_and_pbkdf2_fallback_works():
    h = passwords.hash_passphrase(LONG, method=passwords.PBKDF2)
    assert h.startswith("pbkdf2:sha256:600000$") and passwords.verify(h, LONG)
    assert passwords.default_method() in (passwords.SCRYPT, passwords.PBKDF2)
    if passwords.default_method() == passwords.SCRYPT:
        assert passwords.hash_passphrase(LONG).startswith("scrypt:65536:8:2$")


# ---- login through the app -----------------------------------------------------------------------
def test_login_with_hash(tmp_path, stored_hash):
    c = make_app(tmp_path, PASSPHRASE_HASH=stored_hash).test_client()
    assert login(c, "wrong").status_code == 401
    assert login(c, LONG).status_code == 200
    assert c.get("/api/session").status_code == 200


def test_hash_wins_over_the_old_plain_setting(tmp_path, stored_hash):
    c = make_app(tmp_path, PASSPHRASE_HASH=stored_hash, PASSPHRASE="old-plain-one").test_client()
    assert login(c, "old-plain-one").status_code == 401
    assert login(c, LONG).status_code == 200


def test_plain_setting_still_works_but_warns(tmp_path, caplog):
    with caplog.at_level(logging.WARNING):
        c = make_app(tmp_path, PASSPHRASE="plain pass").test_client()
    assert "plain text" in caplog.text
    assert login(c, "plain pass").status_code == 200


def test_no_passphrase_configured_means_nobody_logs_in(tmp_path):
    c = make_app(tmp_path).test_client()
    assert login(c, "").status_code == 401
    assert login(c, "anything").status_code == 401


def test_a_damaged_hash_in_the_config_fails_closed(tmp_path):
    c = make_app(tmp_path, PASSPHRASE_HASH="scrypt:not:a:hash$x$y").test_client()
    assert login(c, LONG).status_code == 401


def test_attempt_limit_still_applies_with_a_hash(tmp_path, stored_hash):
    c = make_app(tmp_path, PASSPHRASE_HASH=stored_hash).test_client()
    for _ in range(5):
        assert login(c, "wrong", "3.3.3.3").status_code == 401
    assert login(c, LONG, "3.3.3.3").status_code == 429


def test_phone_token_is_still_add_only_with_a_hash(tmp_path, stored_hash):
    c = make_app(tmp_path, PASSPHRASE_HASH=stored_hash).test_client()
    h = {"Authorization": f"Bearer {TOKEN}"}
    r = c.post("/api/upload", data={"file": (__import__("io").BytesIO(make_wav()), "m.wav")}, headers=h)
    assert r.status_code in (200, 201)
    assert c.get("/api/groups", headers=h).status_code == 401           # cannot read the library
    assert c.post("/api/upload", data={}, headers={"Authorization": "Bearer nope"}).status_code == 401


# ---- the command-line tool used by install.sh ----------------------------------------------------
def test_upgrade_conf_replaces_only_the_plain_line(tmp_path):
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("hp", Path(__file__).resolve().parents[2] / "deploy" / "hash_passphrase.py")
    hp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hp)
    conf = tmp_path / "riffbox.conf"
    conf.write_text("RIFFBOX_SECRET=abc\nRIFFBOX_PASSPHRASE='my old pass'\nRIFFBOX_UPLOAD_TOKEN=tok\n")
    conf.chmod(0o640)
    hp.upgrade_conf(conf)
    text = conf.read_text()
    assert "my old pass" not in text and "RIFFBOX_PASSPHRASE=" not in text
    assert "RIFFBOX_SECRET=abc" in text and "RIFFBOX_UPLOAD_TOKEN=tok" in text
    h = next(l for l in text.splitlines() if l.startswith("RIFFBOX_PASSPHRASE_HASH=")).partition("=")[2]
    assert passwords.verify(h, "my old pass")
    assert oct(conf.stat().st_mode & 0o777) == "0o640"
    before = text
    hp.upgrade_conf(conf)                                                 # second run: nothing left to do
    assert conf.read_text() == before
