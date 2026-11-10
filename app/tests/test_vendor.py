"""The vendored copy of Flask, waitress and their helpers really is enough, and has not been altered."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENDOR, APP = ROOT / "vendor", ROOT / "app"


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV")}
    env.update(extra)
    return env


def test_the_vendored_files_match_their_recorded_checksums():
    r = subprocess.run([sys.executable, str(ROOT / "deploy" / "verify_vendor.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_every_package_has_its_licence_and_the_versions_are_pinned_alike():
    lock = dict(line.split("==") for line in (VENDOR / "requirements.lock").read_text().split())
    assert len(lock) == 8 and (APP / "requirements.txt").read_text() == (VENDOR / "requirements.lock").read_text()
    for name in ("flask", "werkzeug", "jinja2", "markupsafe", "itsdangerous", "click", "blinker", "waitress"):
        info = next(VENDOR.glob(f"{name}-*.dist-info"))
        assert any(info.rglob("LICENSE*")) and (info / "METADATA").is_file(), name
        assert (VENDOR / name / "__init__.py").is_file()
        assert not list((VENDOR / name).rglob("*.so"))                                  # pure Python only: works on any machine


def test_the_app_runs_with_only_python_and_the_vendored_packages(tmp_path):
    """A fresh interpreter with the site packages switched off (-S): nothing but the standard library and vendor/."""
    code = f"""
import sys, io, json
sys.path[:0] = [{str(VENDOR)!r}, {str(APP)!r}]
import flask, werkzeug, jinja2, markupsafe, itsdangerous, click, blinker, waitress
for m in (flask, werkzeug, jinja2, markupsafe, itsdangerous, click, blinker, waitress):
    assert m.__file__.startswith({str(VENDOR)!r}), m.__file__
from riffbox import create_app
app = create_app({{"TESTING": True, "DATA_DIR": {str(tmp_path / "data")!r}, "UPLOAD_TOKEN": "t", "PASSPHRASE": "p", "SECRET_KEY": "k",
                  "SESSION_COOKIE_SECURE": False, "FFMPEG": ""}})
c = app.test_client()
assert c.get("/health").get_json()["status"] == "ok"
assert c.post("/api/login", json={{"passphrase": "p"}}).status_code == 200
r = c.post("/api/upload", data={{"file": (io.BytesIO(b"RIFF" + bytes(60)), "a.wav"), "title": "Vendored"}}, headers={{"Authorization": "Bearer t"}},
           content_type="multipart/form-data")
assert r.status_code == 201, r.data
body = c.get("/api/groups", headers={{"Accept-Encoding": "gzip"}})
assert body.headers["Content-Encoding"] == "gzip" or len(body.data) < 600
assert c.get("/").status_code == 200 and c.get("/static/app.js").status_code == 200
app.extensions["riffbox"].stop()
print("vendored-ok", markupsafe.__file__.split("/")[-2])
"""
    r = subprocess.run([sys.executable, "-S", "-c", code], capture_output=True, text=True, env=clean_env())
    assert r.returncode == 0 and "vendored-ok" in r.stdout, r.stdout + r.stderr


def test_the_service_starts_from_the_vendored_waitress(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = clean_env(PYTHONPATH=str(VENDOR), RIFFBOX_DATA_DIR=str(tmp_path / "d"), RIFFBOX_SECRET="s", RIFFBOX_PASSPHRASE="p",
                    RIFFBOX_UPLOAD_TOKEN="t", RIFFBOX_FFMPEG="", RIFFBOX_STATIC_DIR=str(ROOT / "static"))
    proc = subprocess.Popen([sys.executable, "-S", "-m", "waitress", f"--listen=127.0.0.1:{port}", "wsgi:app"], cwd=APP, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        body = None
        for _ in range(60):
            try:
                body = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2))
                break
            except OSError:
                time.sleep(0.2)
        assert body == {"status": "ok"}
    finally:
        proc.terminate()
        proc.wait(timeout=10)
