# Riffbox

A private, single-user web app for musical voice-memo ideas: upload now, tag later,
browse like a DAW sample library. Runs on your own OpenBSD server (Tech Independence
setup). Python + Flask + SQLite, plain HTML/JS frontend, no build step.

Status: see `PHASES.md`. Build and test one phase at a time.

## Run locally (development)

```sh
cd app
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m pytest -q          # tests
export RIFFBOX_DATA_DIR=/tmp/riffbox-data RIFFBOX_SECRET=dev RIFFBOX_UPLOAD_TOKEN=tok \
       RIFFBOX_PASSPHRASE=pw RIFFBOX_INSECURE_COOKIES=1
.venv/bin/waitress-serve --listen=127.0.0.1:8100 wsgi:app
```

Browser test (needs Node + Playwright; serves the app under `/ideas` like production):

```sh
RIFFBOX_PY=app/.venv/bin/python node tests/e2e/phase3.cjs
```

Quick manual check:

```sh
curl -H 'Authorization: Bearer tok' -F file=@memo.m4a http://127.0.0.1:8100/api/upload
```

Configuration is by environment variables: `RIFFBOX_DATA_DIR`, `RIFFBOX_SECRET`,
`RIFFBOX_PASSPHRASE`, `RIFFBOX_UPLOAD_TOKEN`. The app refuses to start without a secret.
`RIFFBOX_INSECURE_COOKIES=1` is for local http only.

## Apple Lossless memos (phase 3.5)

Voice Memos set to *Lossless* records Apple Lossless (ALAC), which Safari plays but Chrome, Edge and
Firefox do not. With `ffmpeg` installed the server keeps the original untouched and makes a lossless
FLAC play copy in the background (`/api/play/<id>`; Download still returns the original). Without
ffmpeg everything still works; ALAC memos just have no browser-friendly copy. Setup:
`deploy/PHASE3_5.md`. The codec is read from the MP4 file itself (`app/riffbox/media.py`), so no
tool is needed to detect it.

## Security notes

- Logins are throttled: 5 wrong passphrases per client (30 from anyone) within 15 minutes returns
  HTTP 429 until the oldest failure ages out. The counters live in memory and reset when the service
  restarts. Client identity comes from relayd's `X-Forwarded-For`, trusted only for loopback peers.
  Still use a long random passphrase.
- The upload token can only upload. It cannot list or download recordings.
- `.gitattributes` forces LF line endings so Windows checkouts don't break `deploy/rc.d/riffbox`.

## Planned features (not built yet)

- **iOS Shortcut** for one-tap upload from the Voice Memos share sheet, using the
  upload-only token.
- **Record-and-send Shortcut** (Action Button / Back Tap / Lock Screen) that records and
  uploads directly, skipping the Voice Memos app.
- **Weekly email digest** of a few forgotten hearted ideas, sent through the server's
  existing `smtpd` and smtp2go relay.
- Shuffle button and a "not played in 30+ days" list.
- Possible later: waveform thumbnails in the list, export-all zip.

## Layout

```
app/        Flask app (riffbox/), tests/, wsgi.py
static/     frontend (later phases)
deploy/     rc.d script, relayd/cert diff, deploy.sh, backup.sh (Phase 2+)
```
