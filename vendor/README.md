# vendor/: Flask, waitress and their helpers, kept with the code

Riffbox's only third-party code is Flask and waitress and the small pure-Python packages they need. They are the part of this
project most likely to change under you (new major versions, an operating system package being dropped). This folder keeps the
exact versions the app was tested with, so the app can be started with nothing but Python and this repository.

| Package | Version | Why it is here |
|---|---|---|
| Flask | 3.1.3 | the web framework |
| Werkzeug | 3.1.9 | Flask's request, response and routing parts (reads file uploads) |
| Jinja2 | 3.1.6 | Flask's templates (Riffbox does not use templates, but Flask imports it) |
| MarkupSafe | 3.0.4 | Jinja2's text escaping (the optional C speed-up is left out; the pure Python version is used) |
| itsdangerous | 2.2.0 | the signed login cookie |
| click | 8.5.1 | Flask's command line (imported, not used by the service) |
| blinker | 1.9.0 | Flask's signals |
| waitress | 3.0.2 | the web server the service runs |

`requirements.lock` lists the same versions. Each package's `*.dist-info` folder (its description and licence, all BSD or similar: keep them with the code) is here too, which also lets Python report the package versions.
`MANIFEST-sha256.txt` records a checksum of every file; `python3 deploy/verify_vendor.py` confirms nothing has changed or gone missing.

## Using it
Nothing changes for the running service: it keeps using the packages installed on the server (`pkg_add py3-flask py3-waitress`).
To run from this folder instead:
- **To try it, or in an emergency:** `sh deploy/run-vendored.sh` (puts `vendor/` first on Python's path and starts waitress).
- **To make the service always use it:** change `daemon` in `/etc/rc.d/riffbox` to
  `/usr/bin/env PYTHONPATH=/usr/local/riffbox/vendor /usr/local/bin/python3` and deploy the `vendor/` folder with the code
  (the routine deploy already uploads the whole repository). Not done by default.
- A test (`app/tests/test_vendor.py`) starts the app with only this folder and Python's standard library, so a broken copy is noticed.

## Updating it (rarely, on purpose)
1. In a scratch folder: `python3 -m venv v && v/bin/pip install -r requirements.txt` (with the new versions pinned there), run the
   test suite against it, then copy each package folder and its `*.dist-info` folder (without the `RECORD` file) from `v/lib/python3.*/site-packages/` over the ones here (leave out
   `__pycache__` and compiled `.so` files), update the table above and `requirements.lock`, and replace the `*.dist-info` folders.
2. `python3 deploy/verify_vendor.py --write` to record the new checksums; commit.
3. Remove files that no longer exist upstream; the verifier reports anything not recorded or missing.
