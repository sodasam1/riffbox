# Riffbox: current plan (updated 10 Nov 2026, groups stages 1 to 5 built)

The original plan is archived, unchanged, at `docs/archive/plan-original-2026-11-08.md` in the repository. This version
reflects what was actually built, the principles that emerged, and what comes next. Day-to-day status lives in
`PHASES.md`; the owner-facing explanation is the app's private **How this works** page. This file is committed as
`docs/PLAN.md`. The detailed, measured proposal for speed, interface feel and long-term upkeep (not built yet, to be done
eventually) is `docs/PLAN-performance-ux-sustainability.md`. The design and staged plan for **groups** (one idea made of several
recordings; stages 1 to 4 merged to `main`, stage 5 on `groups-stage5`) is `docs/PLAN-groups.md`; its short manual test lists are in
`docs/CHECKLIST-groups.md`.

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
- **Style and colours as two separate choices** in the Menu, remembered per device: style is standard or minimal (one ink colour, no fills); colours are auto (follow the device), light or dark. Any style works with any colours, and new styles or colour sets only add blocks of CSS variables.
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

**Added since the last version of this plan** (all merged to `main` except groups)
- **Stable tabs:** switching between Inbox, Library and Resurface no longer shifts the layout (each tab keeps its controls in
  the same column; the Trash tab and counts reserve their space). Merged.
- **Edit in the Inbox:** an Inbox idea can be edited and saved partly, staying in the Inbox, or saved and moved to the
  Library; a Library idea can be sent back. Merged.
- **Restore tool (`deploy/restore.py`, `app/riffbox/restorer.py`):** rebuilds a data folder from a website export (zip or
  folder), checks every checksum, reports missing or damaged files, and can drop Trash entries whose audio was not exported.
  Tested. Used for the migration rehearsal.
- **Groups, stage 1 (branch `groups`, not merged, not deployed):** every recording now belongs to an idea (a "group";
  singles are groups of one and look exactly as before). New tables `idea_groups` and `group_tags`; the additive, repeatable
  migration; `/api/groups` endpoints and library queries over groups; legacy recording endpoints kept as aliases; the page
  reads groups. Single ideas are also written to the old columns so rolling back to `main` stays lossless until a
  multi-recording group exists. 326 server tests and 15 browser scripts pass. Not yet rehearsed on the owner's real data.

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
| 8 | Trash, backup, restore drill, export | Deployed (in daily use). The nightly backup schedule, the practice restore and the off-server copy routine were **not** set up and moved to Planned features (sections 6 and 7) |
| After 8 | Backup and export page; Resurface; Cozy/Compact; backup status line; Trash tab styling; header Menu; compact upload; sortable headings; Select + bulk actions; Random | Built and merged; **awaiting owner check on real devices** |
| After 8 | iPhone Outbox Shortcuts | Done; confirmed working by the owner |
| Review 2 | Clean-up without behaviour change; layout, contrast and tap-target fixes (see `PHASES.md`) | Done; tested |
| After 8 | Minimal theme with a switch in the Menu | Done; tested; awaiting the owner's look |
| After 8 | Stable tabs; edit in the Inbox; restore tool | Built and merged to `main` |
| Groups 1 | Data layer, migration, page reads groups; no visible change | Deployed |
| Groups 2 | Making and changing groups: Select mode in the Inbox, one-click Group… (clashing tempo/key kept and flagged to resolve later in Edit), Add to group…, upload as one idea, Parts list in the edit form, group trash and restore | Deployed |
| Groups 3 | Looks: expandable rows with caret and parts badge, Compact and minimal theme, player "part n of m", auto-advance | Deployed |
| Groups 4 | Keyboard: auto-open and collapse (manual-open stays open), arrows across parts, Random, triage with parts, select-all | Deployed |
| Groups 5 | Resurface with whole groups, search over part titles (server done), group-aware export and restore tests, docs, migration runbook | Deployed |
| Groups 6 | Optional: grouping suggestions from times, download all parts, play together | Not decided |
| Later | Speed, interface feel and upkeep: `docs/PLAN-performance-ux-sustainability.md` | Planned, not started (owner: eventually, not now) |

Quality gates today: 308 automated server tests on `main` (326 on `groups`) and 15 Playwright browser scripts (`tests/e2e/`), all passing. Each groups stage ends with a short manual checklist (`docs/CHECKLIST-groups.md`).

## 6. Open items that need the owner
Groups are deployed and working (checked with a quick scroll on an iPhone in Safari and Chrome; not yet rigorous). Still open:
1. **Try the restore path** (`deploy/restore.py` on a real export) once, so the first time is not an emergency.
2. **A longer check on the phone:** Resurface, Compact rows, grouping from the Inbox, the Menu's Style and Colors.
3. The backup items that used to be the Phase 8 gate are now **planned features** (section 7), not open work: the nightly backup
   schedule, the practice restore, and the habit of copying an export or the backup folder off the server (a backup on the same
   VPS does not survive losing the VPS).

## 7. Candidate next features (not decided; the owner chooses)
- **Groups: one idea made of several recordings (designed 10 Nov; stage 1 built; full spec and staged plan in
- **Backups you do not have to remember (moved here from the Phase 8 deploy gate; not set up):** make the backup folder and set
  `RIFFBOX_BACKUP_DIR`, schedule the nightly job (the cron line in `deploy/PHASE8.md` is untried on the real OpenBSD), do the
  practice restore once, and copy an export or the backup folder off the server regularly. The code (`backup.py`, the *Back up now*
  button, the export, `restore.py`) is built and deployed; what is missing is the schedule and the habit.
  `docs/PLAN-groups.md`).** The owner's model: a group is for recordings that make no sense alone but are one
  idea (keys, drums and vocal memos). For a multi-recording idea the tags, tempo, key, notes and marks belong to the **group**;
  the parts keep their own data as a snapshot "just in case". Every recording belongs to a group internally (singles are groups
  of one and look exactly as today); the table is `idea_groups`. A group shows the earliest recorded and latest upload dates.
  Collapsed it looks nearly identical to a single idea (a small caret and a parts badge); expanded it shows its parts. Made from
  **Select mode (also in the Inbox)** with *Group…*, or by uploading several files as one idea; the grouping dialog resolves
  tempo and key so a group can never conflict. Keyboard: arrowing onto a group auto-expands it and plays its first (or, going
  up, last) part, moves through the parts as separate lines and collapses again when you leave, unless you opened it by hand
  (taken as "stays open"). Selecting a group selects all parts. Resurface always shows the whole group. Open points: the any/all
  filter toggle is moot once details are group-level (recommend dropping it); group length = longest part; part labels. Six
  stages on a `groups` branch: data layer and migration with no visible change, making groups, looks, keyboard, Resurface and
  export, then optional extras.
- **Speed, interface and upkeep plan (decided to do eventually, not now):** compression and long-lived caching, fixing the three
  slow interactions (Library tab, Select mode, Select all: 660-880 ms against a 200 ms target), loading changes, theme variables,
  a smaller `app.js`, shared test helpers, WebKit/Firefox test runs, numbered migrations, a monthly self-test and a yearly-care
  checklist. Full detail, measurements and the recommended order are in `docs/PLAN-performance-ux-sustainability.md`.
- **Off-server copy reminder and a Verify-library button** (S): warn when no export or backup has been taken off the server
  for N days; re-check every audio file against its upload checksum.
- **Pin and vendor the dependencies** (S to M): keep the exact Flask, waitress and helper packages in the repo with an
  install-from-that-copy path. The biggest 20-year risk per hour of effort.
- **Timestamped markers on the waveform** (M): short notes at positions in a recording, included in the export.
- **Interface decluttering, remaining proposals:** an idle player that stays slim, one menu for the row actions, a collapsible
  filter sidebar, a two-step edit form, orange only for primary actions. (Done: compact Upload, tabs without the heading, header Menu, minimal theme, dark theme, spaced button groups in the tab row.)
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
