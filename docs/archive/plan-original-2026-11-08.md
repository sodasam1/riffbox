<!-- ARCHIVE. This is the original plan document, saved unchanged on 8 Nov 2026 before it was updated to match what was
     actually built. It is kept as a record of the starting intentions: it describes Cloudflare-free hosting on a
     subdomain (ideas.<domain>) and a Phase 0-8 plan that changed in places. Current state: see PHASES.md and the
     app's "How this works" page. -->

# Riffbox: voice-memo idea vault, self-hosted on your Tech Independence server

## Context

Musical ideas get stuck in Voice Memos because every later step is manual and retrieval is poor. Goal: a private web app where capture is low-friction, tagging is deferred to a triage pass, and retrieval works like a DAW sample browser.

Decisions so far:
- **No Cloudflare, no third-party services.** The app runs on your own server built by sive.rs/ti and `ti.sh`.
- Python backend, SQLite database, audio stored as plain files on the server.
- Upload via **web uploader only** for now. iOS Shortcut, record-direct, and the email digest go in the README under "Planned features".
- Manual tagging only. Obsidian is out.
- Built in tested phases, each usable on its own.

## What the guide and `ti.sh` establish

Confirmed from the two files you attached:
- **OpenBSD 7.9**, Vultr `vc2-1c-1gb` (**1 vCPU, 1 GB RAM, 25 GB SSD**). Memory and disk are tight, so the app stays small and audio is never transcoded.
- **Your login user** has `permit nopass` in `/etc/doas.conf`. So `ssh you@host doas rcctl restart riffbox` works non-interactively, which makes a one-command `deploy.sh` possible. `PasswordAuthentication no` and root login are disabled, so deploys use your SSH key.
- **Web stack:** `httpd` serves `/var/www/htdocs`, `relayd` terminates TLS, `acme-client` issues certs. A **`pf` firewall** is enabled from the bundled `pf.conf`.
- **Cert renewal:** a root cron job runs `/usr/local/sbin/cert-renew`, which runs `acme-client $domain`, then restarts relayd and dovecot. It names only `$domain`, so a new `ideas.` subdomain needs its cert handling extended (details in Phase 0 and 2).
- **Existing pattern to copy:** Radicale (Python) is installed and served at `dav.<domain>`, so there is already a Python-app-behind-relayd-on-a-subdomain example.
- **Packages:** `ti.sh` installs only curl, rsync, radicale, links, mutt and dovecot. **Python comes in as Radicale's dependency. Flask and a WSGI server are not installed.** `pkg_add` as root through `doas` is the install route.
- **Encrypted storage** at `/mnt` is mounted by hand with `m` (passphrase required, so it is gone after any reboot). **Riffbox must not keep live data there.** Audio goes on the main disk, and `/mnt` can hold manual backup mirrors.
- **Existing backup pattern:** `radbak` is a root cron job copying Radicale's data to your home directory. Riffbox backup can follow the same shape.
- **Email:** local `smtpd` relays through smtp2go. That makes the planned weekly digest feasible with no new service.
- **DNS:** Vultr hosts it. `ti.sh` creates the domain via the API with "A, CNAME and MX". Whether a wildcard record exists for `ideas.<domain>` is unknown, so I'd add a record in the Vultr dashboard rather than use the API key stored in `/root/my/vultr`.
- **Re-running `ti.sh` is safe for our changes.** Config files are only copied while `/root/my/webok` is absent. But "Trouble? Start over" destroys the server. So **every server change Riffbox needs is kept as a reviewable diff in the repo**, making a rebuild reproducible.

Still unseen: the real contents of `relayd.conf`, `httpd.conf`, `acme-client.conf` and `pf.conf`. They come from `ti.tar`, not the script. Phase 0 asks for them.

### What "Wrangler CLI" was
Cloudflare's deploy tool. Irrelevant now. Your deploy is `rsync` plus a service restart, as in the guide.

## Architecture

| Piece | Choice | Why |
|---|---|---|
| Backend | Python 3 + Flask (`pkg_add py3-flask`, name and availability confirmed in Phase 0) behind a small WSGI server (gunicorn or waitress, 1 worker) | Small and readable. Python is already on the box |
| Database | SQLite (stdlib) | One file, trivial backup |
| Audio | `/var/riffbox/audio/`, owned by a dedicated `_riffbox` user | Privilege-separated, OpenBSD style. Not on `/mnt` |
| Frontend | Plain HTML/CSS/JS, **no build step, no npm**, wavesurfer.js vendored as one file | Fits the guide's "bicycle, not jumbo jet" approach |
| Front door | New `relayd` host/protocol for `ideas.<domain>` forwarding to `127.0.0.1:<port>`, modeled on the `dav.` entry. Vultr DNS record for `ideas`. Cert extended to cover `ideas.<domain>`, plus a matching change to `cert-renew` | Mirrors the existing setup |
| Firewall | Likely no `pf` change since traffic enters on 443 and the app listens on loopback. To confirm from `pf.conf` | Don't open new ports |
| Process | `rc.d` script via `rcctl enable riffbox` | Starts on boot, restarts on failure |
| Auth | Single-user passphrase, signed HttpOnly cookie, secret in a root-only config file | No accounts |
| Upload size | Check relayd timeouts and Flask limits with a large test file | Common trap behind a proxy |

Disagreement worth noting: on iPhone, the web uploader means Voice Memos → Share → Save to Files → pick in Safari. That is still the weakest friction point, so the Shortcut should be the first post-core feature.

## Data model (SQLite)

`recordings`: id, title (default "Idea, Nov 8 3:42pm"), filename, orig_filename, mime, size, sha256 (dedupe), duration_s, peaks (JSON, about 200 values), recorded_at, uploaded_at, status (`inbox`|`tagged`), tempo (`slow`|`medium`|`fast`|null), bpm, key_root, key_mode, notes, rating (`heart`|`check`|`x`|null), used_in, last_played_at, deleted_at.
`tags(name)`, `recording_tags(recording_id, tag)`. Seeded: bass, drums, keys, guitar, harmony, vocal, melody, rhythmic idea, full song. User-extendable.

## Phased build with test gates

Each phase ends in a **test gate** and, where noted, a **deploy gate**. Do not move on until it passes.

### Phase 0: Read four config files (no code, nothing changed on the server)
You paste the output of read-only commands, run on the server as your user:
```bash
cat /etc/relayd.conf /etc/httpd.conf /etc/acme-client.conf /etc/pf.conf
python3 --version; pkg_info | grep -iE 'python|flask|gunicorn|waitress|sqlite'
pkg_info -Q flask | head; pkg_info -Q gunicorn | head
nslookup ideas.<your-domain>
df -h /var; doas crontab -l
```
Please redact only secrets, if any appear. The configs should not hold any.
- **Gate:** I can write the exact `relayd` / cert / `cert-renew` diff and confirm the Flask package name.

### Phase 1: Core skeleton, local only
- Flask app, schema, `/health`, `POST /api/upload` (multipart, dedupe by sha256, lands in `inbox`), `GET /api/audio/<id>` with **Range/206 support**.
- Tests (`unittest`/pytest): upload stores file and row, re-upload deduped, unauthenticated returns 401, Range returns the exact bytes and `Content-Range`.
- **Gate:** all tests pass here. `curl` upload and `curl -H 'Range: bytes=0-99'` behave correctly.

### Phase 2: First deploy ("hello world")
- `rc.d` script, config file, the relayd/cert/`cert-renew` diff for you to review, a Vultr dashboard DNS step, and `deploy.sh` (`rsync` then `ssh you@host doas rcctl restart riffbox`).
- **Deploy gate:** `curl https://ideas.<domain>/health` works from your laptop, the cert is valid, and a large `curl` upload succeeds. This isolates server problems before any UI exists. Rollback: revert the relayd diff and `rcctl disable riffbox`.

### Phase 3: Minimal UI, upload and list
- Login page, drag-and-drop and file-picker uploader (multi-file, progress), plain list with `<audio>` player.
- **Gate (local):** Playwright test with WAV/MP3 files (headless Chromium lacks AAC): login, upload, see item, play.
- **Deploy gate:** upload a real `.m4a` from your phone and play it in Safari (first real iPhone check).

### Phase 4: Inbox and the intake form
- Inbox with count badge. Optional fields: instruments (tags), tempo, BPM, key, notes, title. An empty form can be saved.
- **Gate:** PATCH and tag round-trip tests. Playwright: tag an item and see it leave the Inbox.

### Phase 5: Library browser (DAW sample-viewer look)
- Sidebar tag filters (AND/OR), key/tempo filters, search, sortable table (title, date recorded), arrow-key selection with auto-preview, space to play/pause.
- **Gate:** filter-query unit tests on seeded data. Playwright filter checks.
- **Deploy gate:** works with a few dozen real recordings.

### Phase 6: Player polish
- Bottom transport bar with scrubbable waveform (peaks computed in browser and saved), speed control, A/B loop, original-file download.
- **Gate:** scrubbing check on iPhone Safari.

### Phase 7: Ratings and triage
- ♥ / ✓ / ✗ marks and filters (✗ hidden from "All" by default), "used in" text for ✓, card-by-card triage mode with keyboard shortcuts.
- **Gate:** rating-filter tests. Playwright keyboard run-through.

### Phase 8: Hardening and backup
- Soft delete and restore, login rate limiting, HTTPS-only cookies, mobile layout pass.
- Backup: a root-cron script in the style of `radbak` (`sqlite3 .backup` plus copy of audio to your home directory), with an optional manual mirror to `/mnt` or Hetzner Storage Box as the guide suggests.
- **Gate:** restore into a scratch directory and run the app against it.

### README "Planned features" (written, not built)
- iOS Shortcut for one-tap upload from the share sheet, with an upload-only token.
- Record Audio Shortcut (Action Button / Back Tap) that skips Voice Memos.
- Weekly email digest of forgotten hearted ideas, sent through your existing `smtpd` and smtp2go.
- Shuffle button and a "not played in 30+ days" list.
- Possible later: waveform thumbnails in the list, export-all zip.

## Deliverables

Built in `/home/user/riffbox/` and delivered as a zip for you to `rsync` up:

```
riffbox/
  README.md   PHASES.md (checklist of the gates)
  app/        Flask app, schema.sql, tests/
  static/     index.html, css, js, vendor/wavesurfer.js
  deploy/     rc.d script, relayd/cert-renew diff, deploy.sh, backup.sh
```

## Risks
- `relayd.conf`, `acme-client.conf` and `pf.conf` are unseen until Phase 0. If they differ from my assumptions, only `deploy/` changes.
- If `py3-flask` or a WSGI server isn't packaged for 7.9, fall back to a stdlib-only server (more code, no dependencies).
- 1 GB RAM: keep to one worker process.
- Cert handling for a new subdomain is the fiddliest server change, and a mistake could break renewal for the main site. The diff keeps the existing `$domain` flow intact and is reviewed before applying.
- iPhone m4a playback and scrubbing can only be verified by you on a device, at the Phase 3 and 6 deploy gates.
