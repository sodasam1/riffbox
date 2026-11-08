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

Quick manual check:

```sh
curl -H 'Authorization: Bearer tok' -F file=@memo.m4a http://127.0.0.1:8100/api/upload
```

Configuration is by environment variables: `RIFFBOX_DATA_DIR`, `RIFFBOX_SECRET`,
`RIFFBOX_PASSPHRASE`, `RIFFBOX_UPLOAD_TOKEN`. The app refuses to start without a secret.
`RIFFBOX_INSECURE_COOKIES=1` is for local http only.

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
