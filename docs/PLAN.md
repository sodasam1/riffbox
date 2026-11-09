# Riffbox: current plan (updated 9 Nov 2026, after the minimal theme)

The original plan is archived, unchanged, at `docs/archive/plan-original-2026-11-08.md` in the repository. This version
reflects what was actually built, the principles that emerged, and what comes next. Day-to-day status lives in
`PHASES.md`; the owner-facing explanation is the app's private **How this works** page. This file is committed as
`docs/PLAN.md`. The detailed, measured proposal for speed, interface feel and long-term upkeep (not built yet, to be done
eventually) is `docs/PLAN-performance-ux-sustainability.md`.

## 1. What Riffbox is
A private, single-user web app for organizing musical voice-memo ideas, at `https://sanjaysubramanian.com/ideas/`, run
on the owner's own OpenBSD VPS (built from the Tech Independence guide). Capture is low-friction, tagging is deferred
to an Inbox triage pass, and retrieval works like a DAW sample browser. Repository: `sodasam1/riffbox` (branch `main`
has everything; `phase-6`, `phase-7`, `phase-8` are kept as requested).

## 2. Principles (the rules every decision has been checked against)
1. **The owner owns the data, and it must stay usable for decades.** Originals are never modified or deleted by the app.
   Delete is only a Trash. Everything can be exported to plain files that need no software from us.
2. **Few, long-lived dependencies.** Python 3 + SQLite + plain HTML/CSS/JS (no build step, no npm, no front-end
   libraries). Flask and waitress are the one soft spot (see section 8). No Cloudflare, no third-party services, no
   outside fonts or scripts.
3. **Manual tagging only.** No AI. (Automatic BPM/key detection was considered and left out for this reason.)
4. **Compartmentalized and removable.** A dedicated `_riffbox` user, one data folder, one code folder, and
   `deploy/UNINSTALL.md` lists every change made to the server.
5. **Built in tested phases.** Each phase passes automated tests first, then a deploy gate that only the owner can run
   (real server, real iPhone). Breakages are deliberately introduced to prove the tests catch them.
6. **Say what is unverified.** Anything that could not be checked from the build machine (iPhone behaviour, the real
   server) is marked, never assumed.
7. **Simplest thing that removes friction.** Reduce steps before adding features.

## 3. What is built
**Capture**
- Web uploader: a one-line bar (button, or drop files anywhere on the page), multiple files, progress; duplicates rejected by SHA-256; uploads land in the **Inbox**.
- Phone upload via two iPhone **Outbox Shortcuts** (`deploy/SHORTCUT.md`): *Send to Riffbox* saves the memo to an Outbox
  folder and runs *Flush Riffbox Outbox*, which uploads and deletes a file only after the server confirms it. Server side
  is built and tested (friendly replies, files whose name lost their extension identified by content, token check).
  **Confirmed working on the owner's phone.**
- Apple Lossless memos get a lossless FLAC play copy (Chrome cannot play ALAC); the original is kept untouched.

**Organize**
- Inbox with the intake form (all optional): title, instrument tags, marks, "used in", BPM with tap-tempo, key, date
  recorded (defaults to date uploaded; both stored), notes. Keyboard **triage** mode works through the Inbox.
- Marks ♥ interesting, ✓ used in a song (with a song box), ✗ no longer interesting (hidden from "All").

**Find and listen**
- Library: search, tag filters (all/any), BPM range slider, key, Show (marks) filter with counts. A table with **click-to-sort column
  headings** (once ascending, twice descending, third back to the default, newest upload first), separate Recorded and Uploaded
  columns (date only; full timestamp on hover), **Select mode with bulk actions** (tags, mark, Inbox, Trash), and a **Random** button.
  Arrow keys with play-as-I-move and Space.
- **Two themes** (standard, and a minimal one with one ink colour and no fills), switched in the Menu and remembered per device.
- **Cozy / Compact** row size (remembered); Compact shows `108 · A m`, ISO dates and whole tags with a "+N". **Resurface**: hearted ideas not played for N days, never-played first, and
  *Surprise me*. **Trash** tab set apart, with Restore.
- Player bar: waveform and length measured on the server, scrubbing, speed, A/B and whole-recording loop, "played" only
  after a real listen, collapses to one row (button, and automatically while typing on a phone so the keyboard does not
  hide the form).

**Protect and export**
- **Backup and export** page: a status line (disk space, growth forecast, backup age, files not yet backed up), *Back up
  now*, a streamed **zip export** (readable audio names, a `.md` note beside each, `index.html`, `index.csv`, database
  copy, checksums, `PROBLEMS.txt` if anything is damaged), and a database-only download. Command-line equivalents
  `deploy/export.py` and `deploy/backup.py` need only Python and share one code path with the page.
- Nightly backup (cron line in `deploy/PHASE8.md`) keeps 14 database copies and one add-only copy of every original. A
  practice restore is documented and covered by an automated test.
- Login throttling, signed cookies scoped to `/ideas`, add-only upload token, no data readable with that token.
- A private **How this works** page, including a dependency table and a "Keeping your data portable" section.

## 4. Architecture and where things live
| Piece | Choice |
|---|---|
| Backend | Python 3.13, Flask 3.1 + waitress 3.0 (OpenBSD packages), one worker, SQLite in WAL mode |
| Front end | `static/index.html`, `app.js`, `style.css`: plain, no build |
| Media | ffmpeg (optional): waveform, length, FLAC copies. The app works without it. |
| Front door | relayd sends `/ideas` and `/ideas/*` to `127.0.0.1:8100`; TLS and certificates unchanged |
| Server layout | code `/usr/local/riffbox` (root-owned); data `/var/riffbox` (`riffbox.db`, `audio/`, `tmp/`); settings `/etc/riffbox.conf`; service `/etc/rc.d/riffbox`; optional backups `/var/riffbox-backup` |
| Deploy | FreeFileSync (SFTP) to `~/riffbox-incoming`, then `sh ~/install-riffbox.sh` |

Changes from the original plan: path `/ideas` instead of an `ideas.` subdomain; the iPhone Shortcut grew into the Outbox
pattern; delete, backup, export and the backup page are in Phase 8 and after; the waveform is computed on the server
instead of the browser.

## 5. Roadmap and status
| Phase | Scope | Status |
|---|---|---|
| 0 | Read the real server setup | Done |
| 1 | Core: upload, dedupe, range streaming, auth | Done |
| 2 | First deploy | Done (owner checked) |
| 3 / 3.5 | Minimal UI; FLAC play copies | Done (owner checked) |
| 4 | Inbox and intake form | Done (owner checked) |
| 5 | Library browser | Done (owner checked) |
| 6 | Player polish (waveform, speed, loop) | Done; in daily use, working per owner |
| 7 | Marks and triage | Done; in daily use, working per owner |
| 8 | Trash, backup, restore drill, export | Built and merged to `main`; **deploy gate pending** (section 6) |
| After 8 | Backup and export page; Resurface; Cozy/Compact; backup status line; Trash tab styling; header Menu; compact upload; sortable headings; Select + bulk actions; Random | Built and merged; **awaiting owner check on real devices** |
| After 8 | iPhone Outbox Shortcuts | Done; confirmed working by the owner |
| Review 2 | Clean-up without behaviour change; layout, contrast and tap-target fixes (see `PHASES.md`) | Done; tested |
| After 8 | Minimal theme with a switch in the Menu | Done; tested; awaiting the owner's look |
| Later | Speed, interface feel and upkeep: `docs/PLAN-performance-ux-sustainability.md` | Planned, not started (owner: eventually, not now) |

Quality gates today: 308 automated server tests and 15 Playwright browser scripts (`tests/e2e/`), all passing.

## 6. Open items that need the owner
1. Deploy the latest `main` (routine deploy: no new package, no database step) and run `deploy/PHASE8.md`: make the backup
   folder, set `RIFFBOX_BACKUP_DIR`, schedule the nightly job (the cron line is untried on the real OpenBSD), do the
   restore drill once on a computer, download one export and open its `index.html`.
2. Try on the phone: Resurface, Compact rows, the backup status line, the header on a narrow screen.
3. Pull the backup folder (or a zip export) to the owner's own computer now and then: a backup on the same VPS does not
   survive losing the VPS.

## 7. Candidate next features (not decided; the owner chooses)
- **Speed, interface and upkeep plan (decided to do eventually, not now):** compression and long-lived caching, fixing the three
  slow interactions (Library tab, Select mode, Select all: 660-880 ms against a 200 ms target), loading changes, theme variables,
  a smaller `app.js`, shared test helpers, WebKit/Firefox test runs, numbered migrations, a monthly self-test and a yearly-care
  checklist. Full detail, measurements and the recommended order are in `docs/PLAN-performance-ux-sustainability.md`.
- **Off-server copy reminder and a Verify-library button** (S): warn when no export or backup has been taken off the server
  for N days; re-check every audio file against its upload checksum.
- **Pin and vendor the dependencies** (S to M): keep the exact Flask, waitress and helper packages in the repo with an
  install-from-that-copy path. The biggest 20-year risk per hour of effort.
- **Timestamped markers on the waveform** (M): short notes at positions in a recording, included in the export.
- **Songs view** (S to M): group ✓ ideas by their "used in" text.
- **Interface decluttering, remaining proposals:** an idle player that stays slim, one menu for the row actions, a collapsible
  filter sidebar, a two-step edit form, orange only for primary actions. (Done: compact Upload, tabs without the heading, header Menu, minimal theme.)
- **Pass the memo's creation date from the Shortcut** as the date recorded (S).
- **Home-screen icon** for the web app (S).
- If Shortcuts file uploads misbehave: a base64 upload variant, a Record button inside the page, or email-in (Mail to the
  server's `smtpd`). Email-in needs an unguessable address, a size cap and a careful design.
- **Weekly email digest** of forgotten hearted ideas through the existing `smtpd` and smtp2go relay (partly covered now by
  Resurface).
- **Serve the page files from `htdocs`** and narrow the relayd rule to `/ideas/api/*` (the owner's preferred direction;
  trade-offs recorded in the README).
- **Later and bigger:** a standard-library-only server (no Flask or waitress). The hard part is reading file uploads
  (Python removed `cgi` in 3.13); sending the file as a plain request body would avoid needing it. The test suite is the
  specification for the rewrite.

## 8. Risks and limits
- **Dependencies:** Flask and its six helper packages are the weakest point over decades (major-version changes, OpenBSD
  packages eventually dropped). SQLite and plain audio files are very low risk. Mitigation: pinned versions, vendoring,
  yearly restore drill, and the export bundle that needs none of this code.
- **Storage:** a 25 GB disk; a same-disk backup stores each recording twice. The status line forecasts this.
- **iPhone:** the Outbox design keeps every memo safe until the server confirms it; very long memos and a locked phone mid-upload are still untried.
- **Unseen server files:** the real `relayd.conf` timeouts are unknown, so very large export downloads (several GB) are
  untested through relayd.
- **Single user, single worker, one server:** no redundancy by design.

## 9. Working agreements
- One branch per phase while it is being checked; `main` is only advanced when the owner asks (follow-up features since
  Phase 8 were committed directly to `main` at the owner's request). No tags or remote branch deletion are possible from
  the build environment; the old phase-3 to phase-5 branches were deleted by the owner on GitHub.
- Deployment is the two-move routine (FreeFileSync, then one command); anything that changes server files, packages or
  config is called out explicitly with exact commands and a CHECK after each step.
- The owner decides what is built next.
