# Build phases and gates

Do not start a phase until the previous gate is ticked.

- [x] **Phase 0** Server recon done. Python 3.13.16, sqlite3 works, py3-flask 3.1.3 and
      py3-waitress 3.0.2 available; single 21 GB `/` with 18 GB free; no pf, DNS, cert or cert-renew change needed
      (URL is sanjaysubramanian.com/ideas, so only relayd routing changes).
- [x] **Phase 1** Core skeleton, local. Gate: `pytest` 31 passed; real `waitress` server:
      upload 201, re-upload deduped, no token 401, `Range: bytes=0-99` returns 206 with
      correct `Content-Range` and identical bytes (tested with a real AAC `.m4a`).
- [ ] **Phase 2** First deploy. Follow `deploy/PHASE2.md`. Gates A (runs on loopback), B (public HTTPS), C (50 MB upload).
- [ ] **Phase 3** Minimal UI: login, uploader, list, player.
      - [x] Local gate: `pytest` 32 passed; `node tests/e2e/phase3.cjs` (Chromium, served under `/ideas`):
            login, upload + duplicate detection, play/pause, download, logout, no unexpected console errors.
      - [ ] Deploy gate: a real `.m4a` from your iPhone uploads and plays in Safari (needs Phase 2 first).
- [ ] **Phase 4** Inbox + intake form.
- [ ] **Phase 5** Library browser (filters, search, sort, keyboard preview).
- [ ] **Phase 6** Player polish (waveform, scrub, speed, loop, download).
- [ ] **Phase 7** Ratings + triage mode.
- [ ] **Phase 8** Hardening + backup + restore drill.
