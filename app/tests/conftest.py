import io
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from riffbox import create_app  # noqa: E402

TOKEN = "test-upload-token"
PASS = "correct horse"


def make_wav(seconds=1.0, rate=8000, freq_seed=0):
    """Tiny valid WAV; freq_seed varies the bytes so sha256 differs."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(seconds * rate)
        w.writeframes(bytes(((i + freq_seed) % 251) for i in range(n * 2)))
    return buf.getvalue()


@pytest.fixture
def app(tmp_path):
    return create_app({
        "TESTING": True,
        "DATA_DIR": str(tmp_path / "data"),
        "UPLOAD_TOKEN": TOKEN,
        "PASSPHRASE": PASS,
        "SECRET_KEY": "test-secret",
        "SESSION_COOKIE_SECURE": False,
    })


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def authed(client):
    assert client.post("/api/login", json={"passphrase": PASS}).status_code == 200
    return client


def upload(client, data, name="New Recording 12.m4a", token=TOKEN, **form):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(
        "/api/upload",
        data={"file": (io.BytesIO(data), name), **form},
        headers=headers,
        content_type="multipart/form-data",
    )


@pytest.fixture
def prefixed_app(tmp_path):
    return create_app({
        "TESTING": True,
        "DATA_DIR": str(tmp_path / "data"),
        "UPLOAD_TOKEN": TOKEN,
        "PASSPHRASE": PASS,
        "SECRET_KEY": "test-secret",
        "SESSION_COOKIE_SECURE": False,
        "BASE_PATH": "/ideas",
    })


def resync(db_path):
    """Tests that edit the recordings table directly call this afterwards, so the groups (which the lists read) follow."""
    import sqlite3

    from riffbox import groups
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("UPDATE idea_groups SET title = (SELECT r.title FROM recordings r WHERE r.group_id = idea_groups.id),"
                     " deleted_at = (SELECT r.deleted_at FROM recordings r WHERE r.group_id = idea_groups.id) WHERE part_count = 1")
        for (gid,) in conn.execute("SELECT id FROM idea_groups").fetchall():
            groups.refresh(conn, gid)
