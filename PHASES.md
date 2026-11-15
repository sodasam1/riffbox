# Build phases and gates

Do not start a phase until the previous gate is ticked.

**Housekeeping rule:** when a phase finishes, also update the roadmap table and the "Last updated" line in
`app/riffbox/about.html` (the in-app "How this works" page), and the "Planned features" list there and in
`README.md` if it changed. `app/tests/test_about.py` fails if the data-model table drifts from the schema.

- [x] **Phase 0** Server recon done. Python 3.13.16, sqlite3 works, py3-flask 3.1.3 and
      py3-waitress 3.0.2 available; single 21 GB `/` with 18 GB free; no pf, DNS, cert or cert-renew change needed
      (URL is sanjaysubramanian.com/ideas, so only relayd routing changes).
- [x] **Phase 1** Core skeleton, local. Gate: `pytest` 31 passed; real `waitress` server:
      upload 201, re-upload deduped, no token 401, `Range: bytes=0-99` returns 206 with
      correct `Content-Range` and identical bytes (tested with a real AAC `.m4a`).
- [x] **Phase 2** First deploy. Gates A (runs on loopback), B (public HTTPS), C (50 MB upload) passed on the real server
      (reported by owner; steps 1-11 of `deploy/PHASE2.md` completed).
- [x] **Phase 3** Minimal UI: login, uploader, list, player.
      - [x] Local gate: `pytest` 42 passed; `node tests/e2e/phase3.cjs` (Chromium, served under `/ideas`):
            login, upload + duplicate detection, play/pause, download, logout, login lockout, no unexpected console errors.
      - [x] Deploy gate: a real iPhone memo uploads and plays in Safari (reported by owner).
- [x] **Phase 3.5** FLAC play copies for Apple Lossless memos (Chrome cannot play ALAC).
      - [x] Local gate: `pytest` 56 passed (MP4 parser on synthetic and real files, lossless round trip,
            failure fallback, migration of a pre-3.5 database, backfill after installing ffmpeg later);
            browser test: ALAC upload plays in Chromium via FLAC, Download returns the original bytes.
      - [x] Deploy gate: ffmpeg installed per `deploy/PHASE3_5.md`; the existing ALAC memo plays in Chrome (reported by owner).
- [x] **Phase 4** Inbox + intake form (deploy gate: owner reports it working well). Follow-up fixes shipped: automatic
      names use local time; player bar spacing; the private "How this works" page (`app/riffbox/about.html`,
      checked by `tests/e2e/howto.cjs` and `app/tests/test_about.py`). Later changes (owner requests, on `phase-6`):
      the Slow/Medium/Fast words were removed from the edit form and the details line (the `tempo` column stays in
      the database, unused); an optional "Date recorded" was added: both dates are always stored, a blank date
      recorded means the date uploaded, entering one keeps the upload date beside it, and the page no longer sends
      the file's own timestamp as the date recorded; very long titles, notes and tag names no longer stretch rows
      or push Edit/Download off a phone screen (`tests/e2e/longtitles.cjs`, fails on the old CSS).
      - [x] Local gate: `pytest` 122 passed (validation rules, tags, PATCH round trips, inbox/tagged filter, auth);
            `node tests/e2e/phase4.cjs` (Chromium): uploads land in the Inbox with a count, every field saves and moves the
            recording to the Library, an empty form saves, details persist across reload, edit form is prefilled,
            Move back to Inbox, a bad BPM shows the server message and keeps the form, an upload finishing never
            wipes an open form. `phase3.cjs` still passes.
      - [x] Deploy gate: routine deploy (no new package, no database step, no config change); tag and save one of your
            real memos on the phone and on the computer.
- [x] **Phase 5** Library browser (merged to `main`). Owner confirmed they like the play-as-you-move behaviour;
      behaviour with many recordings is untested because only a few are uploaded so far.
      - [x] Local gate: `pytest` 166 passed (`app/tests/test_library.py`: every filter, AND/OR tags, tempo, key,
            search over title/notes/tag names with literal `%` and `_`, sorts incl. BPM nulls last, validation,
            SQL-injection attempts, auth; also checked by deliberately breaking the filter code three ways);
            `node tests/e2e/phase5.cjs` (Chromium, desktop and 390px phone): filters, search, sort remembered across
            reload, click/arrow/Space with auto-preview on and off, keys inside a form left alone, filters wait for an
            open form, phone layout with collapsible filters and no sideways scroll. Phases 3, 4 and the how-to page
            tests still pass.
      - [x] Deploy gate: routine deploy; owner tried it with the few recordings they have (high volume not yet tried).
      - Follow-ups after the owner's phone test: the highlight bar of a selected row no longer sits on top of the
        left edge of an open form (rows now have inner padding; regression-tested at phone width); the
        slow/medium/fast filters were replaced by a BPM range slider (`bpm_min` / `bpm_max`, inclusive; recordings
        without a BPM are excluded while it is set). The Tempo words remain in the edit form.
      - Deviation from the original plan: sorting by length and by last played is deferred to Phase 6, because
        neither value is recorded until then (`duration_s` is filled by the waveform step; `last_played_at` needs
        the player to report plays).
- [ ] **Phase 6** Player polish (merged to `main` at the owner's request; the deploy check below is still to be done).
      - Design change from the original plan: the waveform and length are measured on the server with ffmpeg
        (once per upload, in the background worker; older recordings at the next restart) instead of decoding in
        the browser, which would load whole files into a phone's memory and cannot read Apple Lossless in Chrome.
        So the waveform needs ffmpeg, which the owner already installed.
      - [x] Local gate: `pytest` 199 passed (`test_analysis.py`: peak summarising incl. odd chunk boundaries, real
            ffmpeg on six formats, garbage and disguised-playlist files, failed ffmpeg, restart/backfill, the
            `played` marker, sort by length and last played); `node tests/e2e/phase6.cjs` (Chromium, desktop and
            phone): waveform drawn, scrubbing by click/drag/keyboard, speed with pitch kept and remembered, A-B
            loop (checked by watching the playback position for 3.6 s), Shift+drag, whole-recording loop, "played"
            only after a real listen, lengths and the two new sorts, phone layout. Loop, played-marker and
            scrubbing tests were each checked by breaking the code and watching them fail.
      - [ ] Deploy gate: routine deploy (no new package; ffmpeg is already installed and configured). After
            `doas sh ~/riffbox/deploy/install.sh` the restart measures existing recordings: waveforms should appear within a
            minute. Try the waveform, scrubbing, speed, loop and download on the phone and on the computer.
- [ ] **Phase 7** Ratings + triage mode (branch `phase-7`; not merged to `main` until the owner asks).
      - Design: three marks (`heart`, `check`, `x`) on `recordings.rating`; `used_in` only exists while the mark is a
        check (the server refuses it otherwise and clears it when the mark changes). The Library's "Show" filter
        sends `rating=heart,check,none` for "All", so ✗ is hidden by default; the response carries `ratings` counts.
        Triage walks a snapshot of the Inbox; shortcuts are ignored while typing in a box.
      - [x] Local gate: `pytest` 227 passed (mark validation, the used-in rules, the rating filter incl. unmarked,
            counts, access; three deliberate breakages caught); `node tests/e2e/phase7.cjs`: the Show filter and
            its counts, row buttons, h/c/x on the list, the form's marks and song box, and a full keyboard
            triage (autoplay, tags by number, typing is safe, save/skip/back, summary, Esc). Three deliberate
            breakages caught (typing guard, skip-saves, All showing ✗).
      - [ ] Deploy gate: routine deploy (no new package, no database step, no config change). Mark a few recordings
            on the phone, try the Show filter, and triage a few Inbox recordings on the computer.
      - Also on this branch: the player collapse (see below).
- [ ] **Phase 8** Hardening + backup + restore drill (branch `phase-8`).
      - [x] Built and tested: Trash (soft delete, restore, 409 if the same audio was uploaded again meanwhile), `deploy/backup.py`
            (consistent, integrity-checked database copies + add-only audio copies), the restore drill as an automated test,
            `deploy/export.py` (readable names, a `.md` note per recording, `index.html`, `index.csv`, database copy,
            checksums; the HTML checked playing from `file://`), portability section on the How-this-works page,
            fixes for the open issues from the review (atomic duplicate check, data-disk staging, no waveform polling
            without ffmpeg). Browser: `tests/e2e/phase8.cjs`.
      - [x] Added after the merge: the **Backup and export** page (header link): zip export streamed from the browser (shared recipe in
            `app/riffbox/exporter.py`, byte-identical to `deploy/export.py`), database-only download, backup status and a
            *Back up now* button (`RIFFBOX_BACKUP_DIR`; shared code in `app/riffbox/backup.py`). Tests: `test_data_page.py`, `tests/e2e/datapage.cjs`.
      - [ ] Deploy gate: routine deploy; then `deploy/PHASE8.md` (make the backup folder, set `RIFFBOX_BACKUP_DIR`, schedule it, do the restore drill once, download one export).

## Player collapse (owner request: the player blocked a phone screen while typing)
The player bar has a collapse button (▾/▴) that folds it to one slim row (play, title, time), remembered between
visits; on a small or touch screen it also collapses by itself while a text box has focus and expands afterwards;
the player's own speed menu does not count. Opening an edit form no longer puts the cursor in the Title box on a
touch screen (that raised the keyboard at once). Checked by `tests/e2e/collapse.cjs` (breakages caught).

## Whole-code review (bugs and optimisations)
Fixed: an extreme "date recorded" (year 1 or 9999 with a time-zone offset) crashed the server with a 500 on save
and upload; search and title sort ignored case for non-English letters (été vs Été); holding the Save key in triage
saved the same card repeatedly and skipped the next one; half-written upload files were never cleaned up and a failed
database insert left an orphan audio file; no message when the network was down at login or when loading the lists.
Faster: the list endpoint runs one count query instead of two; the player no longer reads computed styles or
rewrites the time text every animation frame. Added `X-Content-Type-Options: nosniff`.
Tests: `app/tests/test_review.py` and `tests/e2e/review.cjs` (each fails on the old code).

## Phone upload: Outbox Shortcuts (owner request: fewer steps from Voice Memos to Riffbox)
Server side built and tested: replies carry a `message` a Shortcut can show; a file whose name lost its extension is
identified from its content (m4a, wav, mp3, flac, ogg, caf, aiff, aac) and non-audio is still refused; a title that is
the file name loses its extension; `GET /api/token-check`; every 401 carries a message. `deploy/SHORTCUT.md` has the
Shortcut recipes (Flush Riffbox Outbox, Send to Riffbox), the Control Center step and a phone test list.
**Not verifiable from the build machine:** the Shortcuts themselves and how the iPhone behaves (uploads, locked phone,
long memos). Deploy gate: routine deploy, then SHORTCUT.md section 6.

## Resurface, compact rows, backup status line, Trash tab (owner request)
- **Backup and export: status line.** `app/riffbox/health.py` (pure, unit-tested thresholds): disk free (warn under 10%, bad
  under 5% or 1 GB), growth forecast from the last 90 days of uploads (counts FLAC copies, and counts everything twice when
  the backup folder is on the same disk; no forecast under 14 days of history), backup age (warn after 3 days, bad after 14),
  audio files not yet backed up, "no backup set up". Shown at the top of the page.
- **Resurface.** `GET /api/resurface?days=N` (0 = every ♥): hearted Library ideas not played for N days, never-played first.
  A tab with a time choice (remembered) and *Surprise me* (random, not the one already playing; falls back to any ♥ when
  everything was played lately).
- **Cozy / Compact** switch for the Library (remembered): one slim line per recording; desktop rows 135 px -> 44 px in the
  browser test. The phone header now wraps instead of colliding (a bug from adding the Backup and export link).
- **Trash tab** is set apart (far right, dashed) and its page has its own heading, note and muted rows.
- Tests: `test_health_resurface.py`, `tests/e2e/phase9.cjs`. Deploy gate: routine deploy, then try the four things on the phone.

## Whole-code review 2 (clean-up without changing behaviour, plus bugs and glitches)
**Clean-up (no behaviour change):** login throttling moved out of the 800-line `create_app` into `throttle.py` (a small class
with a fake-clock-friendly constructor); the status-line data gathering into `health.collect`; `sniff_audio_ext` into
`media.py`; in `app.js` one `sendJson` helper (5 copies), one `loggedOut()` check (11 copies), one `NETWORK_ERROR` text
(10 copies), one size formatter instead of two, and dead code removed (`cap`, the `.tempo` and `.hint` CSS rules).
**Bugs and glitches fixed (each has a test in `tests/e2e/polish.cjs`, which fails on the old code):**
- A long title with no spaces pushed the player bar's time, Download and collapse button off a phone screen (the grid column
  was not allowed to shrink).
- Between 900 and 1150 px the Library table was up to 90 px wider than the screen, and the marks stuck out of the table at
  every desktop width (their column was 32 px too narrow). The table now starts at 1150 px; narrower screens use the stacked rows.
- The date field in the edit form was unstyled (small, light grey box in dark mode); BPM and Tap tempo sat on two lines
  because of a CSS specificity slip.
- Opening Edit on a desktop left the form hidden behind the expanded player; the page now scrolls it clear.
- "94 KB" could split across two lines; sizes now keep their unit attached.
- Text links were 22 px tall (hard to tap); their hit area is now 30 px or more without moving anything.
- Text contrast in light mode: accent orange, the warning colour and the delete link were below 4.5:1; slightly darker values.
- The keyboard hint showed in the Trash, where the arrow keys do nothing. Log out while offline now says so instead of
  showing the login page while still signed in.

## Library table, menu, compact upload, bulk actions, Random (owner request)
- **Sorting by heading** (Title, Tempo · key = BPM, Length, Recorded, Uploaded): first click ascending, second descending, third the
  default. Default sort is now **newest upload first** (server default `uploaded`; the Inbox and triage still ask for newest
  recorded first, as before). Ties (a batch uploaded within one second) now keep a steady order in both directions.
- **Columns:** Length, Recorded and Uploaded are separate and show the date only; the tooltip has the local timestamp and the stored
  UTC one. **Compact:** `108 · A m`, ISO dates, "Download" as ↓, and tags fit whole with a "+N" (never "b…"). The table starts at 1240 px;
  the page is wider on big screens (96rem) so tags and titles get room.
- **Select mode + bulk actions:** `POST /api/bulk` (add or remove tags, mark, status, trash; all or nothing; the same "used in only
  for ✓" rule as a single change); checkboxes with shift-click ranges, select all, rows hidden by a filter are un-ticked, two-press trash.
- **Random:** plays a different recording from the list on screen, in the Library (a tag filter narrows the draw) and in the Inbox (not during triage).
- **Header Menu** (Backup and export, How this works, theme switch, Log out); **one-line upload bar** with drop-anywhere; the "Recordings (n)" heading is gone.
- Tests: `test_bulk.py`, `tests/e2e/phase10.cjs` (and the older browser tests updated for the Menu and the new default order).

## Minimal theme (owner request)
A second look for the same page, chosen in the Menu ("Switch to the minimal theme" / "...standard theme") and remembered per device.
`static/theme.js` (6 lines, in the `<head>`) applies it before the first paint, so there is no flash; the stylesheet's last section
overrides colours and a few shapes under `html[data-theme="minimal"]` (one ink colour, hairlines instead of boxes, plain tags,
underlined tabs, a player docked edge to edge, underlined form fields, neutral links). Light and dark both work. Nothing about
behaviour changes. Tests: `tests/e2e/theme.cjs` (switch, remembered, applied before first paint, no overflow 320-1600 px in every
view, tags still fit whole, contrast 4.5:1 or better, switching back restores the standard look exactly).

## Stable tabs on desktop (merged to `main`; owner request)
Problem: switching between Inbox, Library and Resurface on desktop moved the whole page (the Library made the page wider and
left-aligned, the others were narrow and centred), and Random jumped because the Library tools only existed on one tab.
Fix: the page is the same width on every tab; the left column always holds that tab's own controls (Inbox: the triage button;
Library: the filters; Resurface: the time choice and *Surprise me*; Trash: its note) and the list is always in the right
column; the tab row has fixed slots, and controls that do not apply (row size and Select outside the Library, Random on
Resurface and Trash) stay as invisible placeholders on desktop instead of disappearing. Phones are unchanged (the panels stack
above the list as before, and inapplicable controls are removed). The How this works and Backup pages keep a readable width.
Tests: `tests/e2e/stable.cjs` measures every fixed element on every tab at 900 to 1920 px (it failed on the old layout).

## Editing in the Inbox (merged to `main`; owner request)
Before: the only way to save details typed into an Inbox recording was to move it to the Library. Now an Inbox row's button says
**Edit**, and its form has **Save** (keeps it in the Inbox; Enter in a field does the same) and **Save and move to Library**.
A Library recording still has Save and Move back to Inbox. No server change was needed: a change request without `status`
never moved anything. The notice says which happened ("Saved. Still in the Inbox." / "Saved. Moved to Library."). Triage mode is
unchanged (it still saves and moves; a skipped card's typing is kept only until you leave triage). Tests: `test_inbox_edit.py`,
`tests/e2e/inboxedit.cjs`; `phase4.cjs` was updated to click Save and move to Library where it expects a move.

## Groups, stages 1 to 4 (merged to `main` after a review; not deployed)
One idea made of several recordings: spec and staged plan in `docs/PLAN-groups.md`, short manual checks per stage in
`docs/CHECKLIST-groups.md`. Built: every recording belongs to an idea (`idea_groups`, `group_tags`, `recordings.group_id` and
`position`; additive repeatable migration; single ideas are also written to the old columns so rolling back stays lossless
while no multi-recording group exists); `/api/groups` endpoints with the older recording endpoints kept as aliases; one-click
**Group…** from Select mode (Inbox and Library) with clashing tempo/key kept and flagged (`unresolved`) to be picked later in
Edit, plus a Library filter for them; Add to group, a Parts list (rename, reorder, take out, break up), upload several files as
one idea; expandable rows and part playback; arrow keys through parts (auto-open and close, hand-opened stays open); Random,
Select and triage for groups; a restore tool (`deploy/restore.py`); Cozy/Compact on the Inbox; Style and Colors theme choices.
Review before the merge: a randomised workout (`test_group_invariants.py`, 25 seeds x 70 steps, checking the database after every
step) found one real bug (a recording taken out of a group, or an idea broken up, kept an out-of-date Inbox/Library status in
its own copy, which an older version of the app would have shown wrongly after a rollback); fixed. A migration rehearsal on a
60-recording database made by the old code (Inbox, Library, Trash, marks, tags, dates, plays) showed identical lists before and
after, and, after edits, bulk changes, trash, restore, an upload, and grouping then breaking up, the old code read the same
lists as the new. Restore tool: a file name taken from a database is now refused unless it is a plain name.
**Measured cost (lab, 4x CPU, 300 recordings):** the Library list grew from 118 KB to 186 KB (7.5 KB compressed) because each
idea carries its parts, and the throttled page load's LCP moved from about 2.1 s to about 2.8 s (the 2.5 s line); the server's
list time is 9 ms. The planned compression and caching work (`docs/PLAN-performance-ux-sustainability.md`, items B1.1 and B1.2)
removes most of that; it is not done yet. **Known gaps:** the export and the readable indexes do not carry a group's own
details yet (stage 5); Resurface does not treat groups specially yet (stage 5).

## Groups, stage 5 (branch `groups-stage5`, not merged)
Resurface shows a hearted group once, whole, with every part and no caret; Surprise me starts it at the first part; arrow keys
walk its parts. A Library search that matches only a part's name says so on the row. **Export**: an idea of several recordings is
one note (`<date> <title> [idea N].md` with the idea's details, its parts and any tempo or key still to be chosen) plus one audio
file per part (`<date> <title> - part 2 <label> [recording id].<ext>`); `index.csv` keeps one row per recording and gains
`idea_id`, `idea_parts`, `part`, `part_title`; `index.html` groups the parts; a single idea exports exactly as before, and a
database from before groups still exports. The restore tool round-trips an export with groups (`test_export_groups.py`). First
deploy runbook with the migration rehearsal and rollback drill: `deploy/GROUPS.md`. Tests: `groups5.cjs`, `test_export_groups.py`.

## Status update (after the groups deploy)
Groups are deployed and work (a quick check on iPhone Safari and Chrome; the restore of an export was not tried). The Phase 8 deploy
gate items that were never done (nightly backup schedule, practice restore, off-server copy routine) are no longer treated as open
work: they are listed under Planned features in `README.md`, `docs/PLAN.md` and the How this works page.

## Compression, caching and group zip (merged to `main`; deployed and checked on the live site)
Text answers are gzip-compressed and the page files carry a content fingerprint in their addresses and are cached for a year (the
page itself is re-checked with a weak ETag); see `app/riffbox/webcache.py` and the progress note in
`docs/PLAN-performance-ux-sustainability.md`. Lab numbers (300 recordings, throttled phone): about 330 KB to 55 KB per page load, the
Library list 186 KB to 8.6 KB, LCP about 2.8 s to about 1.1 s. Live check by the owner: `content-encoding: gzip` and the
`immutable` cache header are present; the group Download zip works. A grouped idea's Download gives every part as one zip (a folder
named after the idea, files numbered in order); each part's own Download still gives that original.

## Speed and upkeep (branch `speed-and-upkeep`; built and tested, not merged or deployed)
Interaction speed (date formatters made once, off-screen rows skipped, Select mode and Select all change the rows already drawn); lists
that revalidate with an ETag (and no `Vary: Cookie`, which had made the browser's copies unusable); numbered database migrations with a copy kept
before the first one (`app/riffbox/migrations.py`); all eight dependencies pinned to exact versions in `app/requirements.txt` (vendoring them in the repository was
tried and removed at the owner's request: it tripled the size of the application for little benefit); browser tests selectable by engine (`RIFFBOX_BROWSER`). Numbers and what was not done:
`docs/PLAN-performance-ux-sustainability.md` section 7. Not verified: the browser tests in WebKit and Firefox (the engines could not be downloaded
in the build environment). Review: a migration rehearsal on a database made by the pre-groups code (identical lists, a copy kept, numbered 2).
Short manual checks: `docs/CHECKLIST-speed-and-upkeep.md`.

## Code upkeep (branch `code-upkeep`; built and tested, not merged or deployed)
Built on top of `speed-and-upkeep`. **Theme variables:** the minimal style's long list of override rules is now a block of variables (radii,
fills, borders, shadows, the "pressed" look, the docked player), read by the component rules, which carry the standard value as their
fallback; only 22 minimal-specific selectors remain (67 before). Checked by 104 screenshots (standard and minimal, light and dark, desktop and
phone, 13 states each) that are pixel-identical before and after. **`app.js` split:** the core is 1,382 lines (was 2,012); the player bar
(`transport.js`), triage (`triage.js`), the two private pages (`pages.js`) and the start-up call (`boot.js`) are separate scripts loaded after it
(they share one set of names, so no wiring was needed); one `ask()` helper replaced five copies of "send, check login, check errors". **Shared test set-up:**
`tests/e2e/_helpers.cjs` (server, temporary data, WAV maker); the 24 scripts went from 4,009 to 3,396 lines.
**Browser engines:** the browser tests were run in WebKit and Firefox (the engines were downloaded after the environment's network allowlist
was extended with the two Playwright download hosts). In WebKit every script passes. In Firefox every script passes except `groups4`, `groups5`,
`phase3` and `phase6`, which need to play sound: the machine had no sound device, so Firefox reported a media error (`OnMediaSinkAudioError`) after
playback started; they need a run on a machine with sound. **Real problems the engine runs found and fixed:** (1) in Safari the player bar could cover the
field being edited when it grew or when focus moved (CSS `scroll-padding` is not applied there): a `reveal()` helper now scrolls the field clear of the
bar, also when the bar changes height; (2) `content-visibility` (the off-screen-row speed-up from `speed-and-upkeep`) let a row move under the pointer between
pressing and releasing in WebKit, so a click could land on the wrong element: it is now switched on only in Chromium (`data-cv` set by `theme.js`; Safari and
Firefox draw every row, still much faster than before because of the date-formatting fix); (3) the player now moves on to the next part only when the loaded
recording really ended. Also found: two browser test scripts (`datapage`, `phase9`) had a name clash introduced earlier that made them fail to start, and the
pass/fail loop used until then did not notice (it only looked for a "FAIL" line): they now run, and the loop checks exit codes.
Short manual checks: `docs/CHECKLIST-code-upkeep.md`.

## One-file installer (branch `one-file-installer`)
`deploy/install.sh` replaces the manual runbook steps, `install-riffbox.sh`, `deploy.sh` and `deploy.ps1` (see `deploy/INSTALL.md`, which also
lists every step by hand). Also: `/var/riffbox-restore` drop folder for the in-app restore,
`ffmpeg` installed with the other packages. No nightly backup is scheduled (owner's decision: manual backups for now, nightly listed as a future feature).
- [x] Local gate: `tests/installer/test-install.sh` (21 checks, against the real Tech Independence `relayd.conf` and the owner's live `relayd.conf`
      and service script) and the 380 server tests. Modes: default (creates only what is missing), `--repair`, `--app-files-only`, `--yes`, `--check`.
- [ ] Deploy gate (owner): upload `riffbox/`, `doas sh ~/riffbox/deploy/install.sh --check`, read it, then run it. Expected on the current server:
      relayd rules, `riffbox.conf` and the service script all LEFT ALONE; only two new folders and the backup cron line are created; code copied; service restarted; PASS line.
      Not verifiable here: `pkg_add`, `useradd`, `rcctl`, `relayd -n`, `crontab`.

## Hashed login (branch `hashed-login`, stacked on `one-file-installer`: merge that one first)
All login code moved to `app/riffbox/auth.py`; the passphrase is stored only as a salted hash (`RIFFBOX_PASSPHRASE_HASH`; method scrypt, or PBKDF2
if the server's Python lacks scrypt). The old plain `RIFFBOX_PASSPHRASE` still works with a log warning, and `deploy/install.sh` converts it in
place (login unchanged). `docs/AUTH.md` explains it and the path to a shared login or a proxy.
- [x] Local gate: 393 server tests (13 new in `test_auth_hash.py`; breaking the verifier makes 5 fail), installer tests 17 checks.
- [ ] Deploy gate (owner): merge, upload, make a root-only safety copy (`doas cp -p /etc/riffbox.conf /etc/riffbox.conf.bak-plain`), then
      `doas sh ~/riffbox/deploy/install.sh --app-files-only` (new code; plain passphrase still accepted) and confirm login works; then
      `doas sh ~/riffbox/deploy/install.sh --repair` and answer `y` to replace the plain passphrase with a hash. Log in with your SAME passphrase; a wrong one is
      refused; run `SHORTCUT.md` section 6 (phone upload still works). Run `python3 /usr/local/riffbox/deploy/hash_passphrase.py --method` and tell me what it prints;
      delete `/etc/riffbox.conf.bak-plain` once all is well.
      Not verified here: scrypt availability on OpenBSD, hash parameters vs the current OWASP sheet, iPhone behaviour.

      relayd rules, `riffbox.conf` and the service script all LEFT ALONE; only two new folders are created (and, with --repair, the backup-folder line added to riffbox.conf); code copied; service restarted; PASS line.
      Not verifiable here: `pkg_add`, `useradd`, `rcctl`, `relayd -n`.

## Restore inside the app (branch `in-app-restore`, independent of the other two)
The Backup and export page has a **Restoring** section. Upload a backup folder (`db/` + `audio/`), an unzipped export or an export zip to the drop
folder `/var/riffbox-restore` (`RIFFBOX_RESTORE_DIR`), press the button. It only works while the library is **empty**; it works out of sight first,
copies audio without overwriting anything, and replaces the live database last, so a failure leaves the library empty and repeatable. Missing or
damaged audio is listed, not hidden. Code: `app/riffbox/restorer.py` (`inspect_source`, `restore_into_live`, `Runner`), two routes in `__init__.py`.
- [x] Local gate: 389 server tests (9 new in `test_restore_live.py`: backup layout, export folder, export zip, refuses a non-empty library at both the
      API and the function, missing and damaged audio reported, nothing usable, failure leaves the library empty and retry works, login and token
      access); mutation-checked (removing the empty-library rule fails a test); browser test `tests/e2e/restore.cjs`; `datapage.cjs` still passes.
- [ ] Deploy gate (owner): upload this branch's ZIP (it includes the installer), `doas sh ~/riffbox/deploy/install.sh --app-files-only`. The drop folder
      `/var/riffbox-restore` already exists from the installer. On your real library the Restoring section must say restoring is switched off and the
      button must be disabled. Practise a real restore on your own computer on an EMPTY library, never on the server. Not verified here: restore time on a multi-GB library, SQLite's online copy into a live WAL database on the real server.

## Archive of finished work (branch `archive-old-files`: built on top of the other three, so merge it LAST)
Five finished-work documents moved (not deleted) into `archive/`, with an index and the reason for each: `archive/README.md`. References updated.
- [x] Local gate: the three feature branches combined plus this move: 402 server tests, the installer checks and the browser restore test pass.
- [ ] Owner: look at `archive/README.md` and say if anything should come back out.

## Verified on the owner's server (hashed login)
`python3 deploy/hash_passphrase.py --method` printed `pbkdf2:sha256:600000`: OpenBSD's Python has no `hashlib.scrypt` (LibreSSL), so Riffbox uses the
PBKDF2 fallback (600,000 rounds). Login, wrong-passphrase refusal and the phone upload were checked after the conversion.

## Clean upload folder (branch `clean-upload-folder`)
Found when FreeFileSync could not delete files in `~/riffbox`: Python run as root (the installer's passphrase tool) left root-owned `__pycache__` folders in the
upload folder. Fix: the installer sets `PYTHONDONTWRITEBYTECODE=1` and the command-line tools (`hash_passphrase.py`, `backup.py`, `export.py`, `restore.py`) set
`sys.dont_write_bytecode` before importing anything. A one-time `chown` of the existing folder is in `deploy/INSTALL.md`.
- [x] Local gate: new installer test (nothing named `__pycache__` appears in the upload folder after the installer and the tools run; removing the fix fails it).
- [ ] Deploy gate (owner): `doas chown -R YOURUSER:YOURUSER ~/riffbox` once, upload this branch, run the installer with `--app-files-only`, then upload again with
      FreeFileSync: it must be able to replace and delete files. `find ~/riffbox ! -user YOURUSER` should print nothing, and still print nothing after the installer ran.

## Cleanup after all branches are deployed (owner, one time)
- [ ] `doas rm /etc/riffbox.conf.bak-plain`: the root-only copy of the settings file from before the passphrase was hashed; it still holds the OLD PLAIN-TEXT passphrase.
- [ ] Old deploy leftovers in the home folder, if present: `rm -rf ~/riffbox-incoming; rm -f ~/install-riffbox.sh ~/riffbox.tgz` (replaced by `~/riffbox` and the installer).
- [ ] Keep for now as undo files, delete when you no longer want them: `/etc/httpd.conf.pre-kit` (site kit) and, if it exists, `/etc/relayd.conf.pre-riffbox`.
- [ ] If you ran the iPhone password spike: delete the spike page, its test audio file and its `httpd` block on the server; the `claude/bold-pasteur-0flqrf` branch on GitHub can be deleted.
- [ ] A Vultr snapshot you took before the changes keeps costing money until deleted (price unverified).
- [ ] On your computer: the test folder `C:\rb-test` from the restore practice run.

## Greyed-out disabled buttons (branch `dim-disabled-restore`)
Owner's check of the Restoring section: it was not visibly greyed out when switched off, because disabled buttons had no style at all (a disabled primary
button looked exactly like an enabled one). Now every disabled button is dimmed with a "not allowed" cursor, and the Restoring section is greyed whenever
restoring is not possible. CSS and a few lines of page code only (`static/style.css`, `static/pages.js`).
- [x] Local gate: all 24 browser scripts pass (`restore.cjs` now also checks the computed opacity of the button and the section).
- [ ] Deploy gate (owner): upload, `doas sh ~/riffbox/deploy/install.sh --app-files-only`, open Backup and export: the Restoring section and its button must look greyed out on
      your real library. Check one other page with a disabled button (press Back up now: the button dims while it runs).

## Practice restore script (branch `practice-restore-script`)
`deploy/practice_restore.py PATH` restores a backup folder, an unzipped export or an export zip into a throwaway EMPTY library on the owner's computer, through the
app's own restore code, and checks: no missing or damaged audio, every audio file matches its checksum, and the restored database has the same rows as the source.
PASS/FAIL per check; exit code 0/1/2. `--serve` lets the owner look at the result in a browser. It replaces most of the manual clicking in the restore rehearsal.
Also fixed (found by this script's test): opening a backup database, even read-only, could create `-wal`/`-shm` files in the owner's drop folder, because backups keep the
live database's WAL setting. Source databases are now opened `immutable` (in `restorer.py` too), so the drop folder is never changed.
- [x] Local gate: 6 tests in `test_practice_restore.py` (good backup passes and the source folder is byte-identical afterwards; damaged and missing audio fail; unusable
      folder exits 2; practice library deleted unless `--keep`; the comparison notices a changed note and a missing row) and 1 regression test in `test_restore_live.py`
      (no side files in the drop folder; fails without the fix).
- [ ] Deploy gate (owner): on your PC, pull a backup (`/var/riffbox-backup`), run `python deploy\practice_restore.py <folder>`; it should print `ALL CHECKS PASSED`.
      Then `--serve` and look: counts, a recording's tags and notes, playback. Not verified here: Windows paths and `pip install` behaviour. App change: run
      `--app-files-only` on the server to pick up the `immutable` fix (harmless if you do not).

## Docs refresh (branch `docs-refresh`)
The housekeeping rule above was overdue: the in-app *How this works* page (roadmap row, Last updated, the settings-file row) and `docs/PLAN.md` (deploy row, roadmap row, date) now describe the
installer, the hashed login and in-app restore. Text only.
- [x] Local gate: 402 server tests (including `test_about.py`), `howto.cjs`.
- [ ] Owner: after a deploy (`--app-files-only`), open *How this works*: the Last updated line says 15 Nov 2026 and the roadmap has the new row.
