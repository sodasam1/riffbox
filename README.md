# Riffbox

A private, single-user web app for musical voice-memo ideas: upload now, tag later, browse like a DAW sample library.
It runs on your own OpenBSD server (the Tech Independence setup) at `https://sanjaysubramanian.com/ideas/`.
Python + Flask + SQLite and a plain HTML/CSS/JS page: no build step, no npm, no outside services.

**Where to look**

| For | Read |
|---|---|
| What is built and how far each phase got | `PHASES.md` |
| The current plan, principles and open items | `docs/PLAN.md` (the original plan is kept in `docs/archive/`) |
| Speed, interface and upkeep work planned for later | `docs/PLAN-performance-ux-sustainability.md` |
| Putting it on the server, routine deploys | `deploy/PHASE2.md` (and `deploy/PHASE3_5.md` for `ffmpeg`) |
| Backups, the restore drill, exports | `deploy/PHASE8.md` |
| First deploy of groups (migration rehearsal, rollback) | `deploy/GROUPS.md` |
| Uploading from the iPhone | `deploy/SHORTCUT.md` |
| Removing everything Riffbox added to the server | `deploy/UNINSTALL.md` |
| A plain-language tour, inside the app | the **How this works** page (Menu), served only to a logged-in session |

## What it does

- **Capture:** upload in the browser (button, or drop files anywhere on the page) or from the iPhone with the Outbox
  Shortcuts. Duplicates are recognised by checksum. New recordings land in the **Inbox**.
- **Organize:** an optional intake form (title, tags, marks, BPM with tap tempo, key, date recorded, notes), a keyboard
  **triage** mode for the Inbox, and ♥ / ✓ / ✗ marks (✓ can name the song it became).
- **Groups:** recordings that only make sense together (keys, drums and a vocal memo of one idea) can be made into one idea:
  Select, tick, **Group…** (one click; a tempo or key the parts disagree on is kept and flagged to pick later), or upload
  several files as one idea. The idea shows as one row that opens to its parts; its tags, tempo, key, notes and marks belong to
  the group, and arrow keys, playback, Random, Resurface, search and the export all understand it. Details and quirks: the
  Quickstart on the **How this works** page; first deploy: `deploy/GROUPS.md`.
- **Find and listen:** a Library with search, tag, BPM, key and mark filters; a table with click-to-sort headings, Cozy or
  Compact rows, Select mode with bulk actions, **Random**, and **Resurface** (hearted ideas you have not played lately).
  A player with a waveform, scrubbing, speed, A-B loop and Download. Style (standard or minimal) and colours (auto, light or dark) are separate choices in the Menu.
- **Protect:** a Trash instead of deletion, a backup script and **Back up now** button (a nightly schedule is optional and not set up by default), a **Backup and export** page, and an export to plain files
  that needs none of this code. Originals are never changed or removed by the app.
- **Apple Lossless (ALAC) memos:** Safari plays them, Chrome, Edge and Firefox do not. With `ffmpeg` installed the server
  also keeps a lossless FLAC play copy (Download still returns the original). `ffmpeg` also measures each recording's
  length and waveform shortly after upload. Without it everything works; there is just no waveform, length or play copy.
  The ALAC check itself reads the MP4 directly (`app/riffbox/media.py`).

## Run locally (development)

```sh
cd app
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m pytest -q          # server tests
export RIFFBOX_DATA_DIR=/tmp/riffbox-data RIFFBOX_SECRET=dev RIFFBOX_UPLOAD_TOKEN=tok \
       RIFFBOX_PASSPHRASE=pw RIFFBOX_INSECURE_COOKIES=1
.venv/bin/waitress-serve --listen=127.0.0.1:8100 wsgi:app
```

Browser tests (Node + Playwright with Chromium; each script starts its own server under `/ideas`, as in production):

```sh
RIFFBOX_PY=app/.venv/bin/python node tests/e2e/phase3.cjs        # one script
for t in tests/e2e/*.cjs; do RIFFBOX_PY=app/.venv/bin/python node $t; done    # all of them
```

Measurements of load time, payload size and interaction speed (see `docs/PLAN-performance-ux-sustainability.md`):

```sh
RIFFBOX_PY=app/.venv/bin/python node tests/perf/measure.cjs
```

Quick manual check of the upload endpoint: `curl -H 'Authorization: Bearer tok' -F file=@memo.m4a http://127.0.0.1:8100/api/upload`

## Configuration

Environment variables; on the server they live in `/etc/riffbox.conf` (`deploy/riffbox.conf.example`), which the app
reads at start-up (`RIFFBOX_CONFIG` names another file). Real environment variables win over the file.

| Variable | Meaning |
|---|---|
| `RIFFBOX_SECRET` | signs the login cookie; the app will not start without it |
| `RIFFBOX_PASSPHRASE` | what you type to log in |
| `RIFFBOX_UPLOAD_TOKEN` | lets the phone Shortcut add recordings (and nothing else) |
| `RIFFBOX_DATA_DIR` | database and audio (default `/var/riffbox`) |
| `RIFFBOX_BASE_PATH` | the URL prefix, e.g. `/ideas` (empty at the root) |
| `RIFFBOX_STATIC_DIR` | where the page files are |
| `RIFFBOX_FFMPEG` | path to `ffmpeg`; empty switches it off (found automatically if installed) |
| `RIFFBOX_BACKUP_DIR` | the folder behind the "Back up now" button; empty switches the button off |
| `RIFFBOX_INSECURE_COOKIES=1` | local plain-http testing only |

## Layout

```
app/riffbox/   the server: __init__.py (routes), intake.py (validation), library.py (list queries), media.py (ffmpeg,
               codec), exporter.py and backup.py (shared with deploy/), health.py, throttle.py, config.py, schema.sql,
               about.html (the private How this works page)
app/tests/     server tests (pytest);  app/wsgi.py  the production entry point
static/        the page: index.html, app.js, style.css, theme.js
tests/e2e/     browser tests (Playwright);  tests/perf/  measurements
deploy/        rc.d script, config example, optional deploy.sh / deploy.ps1, backup.py, export.py, and the runbooks above
docs/          the plan, the later-work plan, and docs/archive/ (the original plan)
```

## Security notes

- Logins are throttled: 5 wrong passphrases per client (30 from anyone) within 15 minutes returns HTTP 429 until the
  oldest failure ages out. The counters live in memory and reset when the service restarts. The client address comes from
  relayd's `X-Forwarded-For`, trusted only for loopback peers. Still use a long random passphrase.
- The login cookie is signed, HTTP-only, `SameSite=Lax` and scoped to the app's path.
- The upload token can only add recordings (and check that it works). It cannot list, download, change or export anything.
- All recordings, exports and the How this works page need a login session; the public page files contain no data and no server details.
- `.gitattributes` forces LF line endings so Windows checkouts don't break `deploy/rc.d/riffbox`.

## Planned features (not built yet)

- **Backups you do not have to remember:** the backup folder and nightly schedule (`deploy/PHASE8.md`), a practice restore with
  `deploy/restore.py`, and a routine for copying an export or the backup folder off the server. The code exists; the schedule does not.
- **Speed, interface feel and upkeep** (decided: eventually, not now). Measured and written up in
  `docs/PLAN-performance-ux-sustainability.md`:
  - compress responses and cache the page files for a long time (about 264 KB per load becomes about 42 KB);
  - fix the three slow interactions (opening the Library, Select mode, Select all take 660 to 880 ms against a 200 ms
    target) by no longer rebuilding every row on each change;
  - load the Library list only when its tab opens, and start the list request together with the session check;
  - one set of theme variables instead of a long override list; a smaller `app.js`; shared helpers for the browser tests;
  - run browser tests in WebKit and Firefox as well; numbered database migrations; a monthly self-test; a yearly-care
    checklist; pin and vendor Flask and waitress.
- **Interface clean-up:** an idle player that stays slim, one row-actions menu, collapsible filter groups, a two-step edit
  form, orange only for primary actions.
- **Candidate features:** an off-server copy reminder and a Verify-library button; timestamped markers on the waveform; the memo's creation date passed from the Shortcut as the date recorded; a
  home-screen icon.
- **Record-and-send Shortcut** (Action Button / Back Tap / Lock Screen) that records and uploads directly, skipping the
  Voice Memos app. If Shortcut uploads ever misbehave: a base64 upload variant, a Record button in the page, or email-in.
- **Weekly email digest** of a few forgotten hearted ideas, through the server's existing `smtpd` and smtp2go relay.
- **Waveform thumbnails** in the list.
- **A standard-library-only server** (no Flask or waitress): the hard part is reading file uploads (Python removed `cgi` in
  3.13); sending the file as a plain request body would avoid needing it. The test suite is the specification.
- **Serve the page from `htdocs` instead of the app (the owner's preferred direction).** Today the Python app serves
  `static/` along with the API and relayd sends everything under `/ideas` to the app. The plan lets httpd serve the page like
  the rest of the site:
  - put the page files in `/var/www/htdocs/ideas/` (uploaded with FreeFileSync) and keep the URL
    `https://sanjaysubramanian.com/ideas/`;
  - narrow the relayd rule from `path "/ideas/*"` to `path "/ideas/api/*"` so only the API goes to the app (the page uses
    relative URLs, so it needs no change);
  - trade-offs accepted: two upload destinations; the page and the API can get out of step if only one is uploaded, so every
    deploy must do both; the page files would no longer be removed by the Riffbox-only uninstall (`deploy/UNINSTALL.md`
    would gain a step to delete `htdocs/ideas`);
  - do it as its own phase, with a deploy gate that checks the page loads from httpd and that the old and new routes don't
    both answer.
