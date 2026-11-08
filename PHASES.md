# Build phases and gates

Do not start a phase until the previous gate is ticked.

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
- [ ] **Phase 4** Inbox + intake form (merged to `main`; waiting on the deploy gate).
      - [x] Local gate: `pytest` 122 passed (validation rules, tags, PATCH round trips, inbox/tagged filter, auth);
            `node tests/e2e/phase4.cjs` (Chromium): uploads land in the Inbox with a count, every field saves and moves the
            recording to the Library, an empty form saves, details persist across reload, edit form is prefilled,
            Move back to Inbox, a bad BPM shows the server message and keeps the form, an upload finishing never
            wipes an open form. `phase3.cjs` still passes.
      - [ ] Deploy gate: routine deploy (no new package, no database step, no config change); tag and save one of your
            real memos on the phone and on the computer.
- [ ] **Phase 5** Library browser (filters, search, sort, keyboard preview).
- [ ] **Phase 6** Player polish (waveform, scrub, speed, loop, download).
- [ ] **Phase 7** Ratings + triage mode.
- [ ] **Phase 8** Hardening + backup + restore drill.
