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
      checked by `tests/e2e/howto.cjs` and `app/tests/test_about.py`).
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
- [ ] **Phase 6** Player polish (waveform, scrub, speed, loop, download), plus recording each recording's length and
      last-played time, which unlocks the two deferred sorts and the "not played in a while" list.
- [ ] **Phase 7** Ratings + triage mode.
- [ ] **Phase 8** Hardening + backup + restore drill.
