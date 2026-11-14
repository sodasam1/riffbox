# Planned: speed, interface feel and long-term upkeep

Written 9 Nov 2026, after the minimal theme was added. **Nothing in this document is built yet.** The owner wants to
implement it eventually, not now. It is a complete record of two proposals made in a design discussion: (A) interface and
interaction changes guided by Google's Core Web Vitals, and (B) making the app lighter and cheaper to maintain without
changing what it does. Everything here is meant to be picked up in a fresh conversation, so the measurements, the
reasoning and the recommended order are all included. The current overall plan is `docs/PLAN.md`; build status is in
`PHASES.md`.

**Rules for doing any of this** (from the project's principles): no change to what the app does; keep the data portable
and the dependencies few; no build step or npm for the page; test first, then a deploy gate the owner runs; say what could
not be verified; the owner chooses what is built and in what order.

## 0. Reference: Core Web Vitals

Google's three user-experience metrics, each judged at the 75th percentile of real visits:

| Metric | What it measures | "Good" |
|---|---|---|
| LCP (Largest Contentful Paint) | how soon the main content appears | 2.5 s or less |
| INP (Interaction to Next Paint) | how quickly the page responds to taps and clicks (replaced FID in March 2024) | 200 ms or less |
| CLS (Cumulative Layout Shift) | how much things jump around | 0.1 or less |

The thresholds above come from mirrored copies of web.dev and secondary pages, not from reading the live threshold table,
so confirm them on web.dev before quoting them anywhere formal.

Guidance this plan leans on (web.dev):
- **INP:** any task over 50 ms is a "long task" that can block a response to input. Split work up and yield to the browser
  (`setTimeout`, or `scheduler.yield()`, which Safari did not support when checked). Use CSS containment
  (`content-visibility`) so off-screen content costs no layout or paint.
- **CLS:** reserve space for anything that arrives late; do not insert content above what is already visible; match
  skeleton placeholders to the final size.
- **LCP:** four parts add up to LCP: server response time, resource load delay, resource load duration and element render
  delay. Start the main request as early as possible and avoid render-blocking resources.

**Caveat that shapes everything below:** these are field metrics, and a private, login-protected app has no field data. So
the numbers here are lab equivalents, measured with `tests/perf/measure.cjs` (4x CPU slowdown, about 1.6 Mbps, 150 ms round
trip, as a stand-in for a mid-range phone). Lab numbers are for before-and-after comparison, not for claiming a "pass".

Sources (all verified in search results when this was written; the full pages were not all read):
- https://web.dev/articles/defining-core-web-vitals-thresholds
- https://web.dev/articles/optimize-inp
- https://web.dev/articles/top-cwv
- https://web.dev/articles/optimize-cls
- https://web.dev/articles/optimize-lcp

## 1. Baseline measurements (8 Nov 2026, 300 recordings: 270 in the Library, 30 in the Inbox)

Re-run with `RIFFBOX_PY=/path/to/python RIFFBOX_N=300 node tests/perf/measure.cjs`. The two runs made agreed within about
10%.

**Size on the wire** (nothing is compressed today: waitress and relayd do not compress; httpd is believed not to either, which was not checked on this server):

| File | Raw | gzip | brotli |
|---|---|---|---|
| `static/app.js` | 85,092 B | 25,130 B | 21,220 B |
| `static/style.css` | 32,753 B | 7,235 B | 6,274 B |
| `static/index.html` | 14,382 B | 4,147 B | 3,394 B |
| `static/theme.js` | 410 B | 274 B | 210 B |
| `GET /api/recordings` (Library, 270 rows) | 118,429 B | 5,256 B | |
| `GET /api/recordings?status=inbox` (30 rows) | 13,219 B | 945 B | |

One page load transfers about 264 KB; compressed it would be about 42 KB. The static files are served with
`Cache-Control: no-cache, max-age=0`, so every load re-asks for `theme.js`, `style.css` and `app.js` (about three round
trips). Page open sequence today: HTML, then `theme.js` and `style.css` (render-blocking), `app.js` (end of body), then
`api/session`, and only after it answers `api/recordings` (Inbox), `api/recordings` (Library, 118 KB, not visible yet) and
`api/tags`.

**Server:** the list answers in 3 to 7 ms; `/api/data` in 5 ms. The server is not the bottleneck.

**Throttled page load:** FCP about 1.2 s, **LCP about 2.1 s** (limit 2.5 s: passes with little room), **CLS 0.008** (limit
0.1: passes), load-time long tasks 101 and 137 ms in the later run (75, 110 and 62 ms in the first), 1,117 DOM nodes,
JS heap 10 MB.

**Interactions** (click to next painted frame, 4x CPU, 270 Library rows):

| Interaction | Time | Against 200 ms "good" |
|---|---|---|
| Open the Library tab | 660 to 725 ms | poor (a single 709 ms task) |
| Turn Select mode on | 695 to 795 ms | poor |
| Select all | 768 to 881 ms | poor |
| Cozy to Compact and back | 240 to 313 ms | needs improvement |
| Open the Menu | 25 to 34 ms | good |

Cause: every state change calls `render()`, which rebuilds every row (about 25 elements and about 6 listeners per row).

**Size of the work:** about 4,700 first-party lines (Python about 1,900 across 9 modules, `app.js` 1,639, `style.css`
433, `index.html` 246, `about.html` 379). Tests: 2,456 lines of Python tests (308 tests, 14 s) and 2,859 lines of browser
tests (15 scripts, each copying its own setup).

## 2. Proposal A: interface and interaction changes (Core Web Vitals)

### A1. Interactions (INP): the biggest measured problem
1. **Do not rebuild the list for view-only changes.** Select mode, select all, the picked highlight and Cozy/Compact only
   need classes and checkbox states changed on rows that already exist. Expected: from 700 to 900 ms to well under 100 ms.
2. **Make rows cheap.** `content-visibility: auto` with `contain-intrinsic-size` on each row so off-screen rows cost no
   layout; one delegated click handler on the list instead of about six per row; build rows by cloning an HTML
   `<template>` and setting `textContent` (still no raw HTML from data, so no new injection risk). For libraries beyond a
   few hundred recordings: render in chunks that yield between them, or a "Show more" step, or true windowing.
3. **Optimistic marks.** Today a ♥ waits for the server, then refetches both lists. Update the button at once, send the
   change, and correct the counts locally from the single updated row the server returns.
4. **Show immediate feedback** (pressed state, a brief "working" cue) before any heavy step, so the next paint is fast even
   when the work is not.

### A2. Loading (LCP)
5. **Start the list request alongside the session check.** An unauthenticated list request already answers 401, so the page
   can ask both at once and show the login page if it gets 401. Saves one round trip (150 to 300 ms on a phone).
6. **Fetch the Library only when its tab opens.** It is 118 KB at load even while the Inbox is showing. The tab counts need
   a tiny summary request (counts only, for example `limit=0`) instead.
7. **Do not block painting on the script.** `app.js` is already at the end of the body; add `defer`, and consider showing
   the static page shell (header, tabs, empty list) before any data arrives. System fonts are already used, so there is no
   webfont delay or font-swap shift to fix.
8. Compression and long-lived caching, listed under B1 because they are the largest single gain.

### A3. Stability (CLS): already good (0.008), keep it that way
9. Reserve space for late arrivals: the Trash tab appears after load, tab counts change width ("Inbox (3)" after load), and
   the notice banner pushes the list down when a result arrives. Reserve the tab space (tabular digits, `min-width`) and
   make the notice an overlay rather than a block above the list.

### A4. Usability, clutter and ergonomics
10. Remaining interface clean-up proposed earlier: a slim idle player (it is a 175 px empty panel until something plays and
    covers rows), one row-actions menu (keep ♥ visible; Edit, Download, ✓ and ✗ behind "⋯"), collapsible filter groups with
    active-filter counts (the sidebar is about 600 px tall), a two-step edit form ("Basics" with title, tags, mark and Save;
    "More details" for BPM, key, date and notes), and orange used only for the active tab and primary buttons.
11. Tap targets of at least 44 px on touch (Compact rows are 28 px by the owner's choice; keep Cozy as the default on phones).
12. Respect `prefers-reduced-motion` if animation is ever added (there is none now).
13. Optional: log real LCP, INP and CLS from the owner's own phone (a few lines with `PerformanceObserver`, written to the
    console or to the server), since there is no field data otherwise.
14. Optional, weigh the upkeep: a web app manifest and `theme-color` for a home-screen icon. A service worker for an
    offline app shell would make repeat loads near instant but adds maintenance; recommended only if repeat-load speed is
    still a problem after B1 (caching).

## 3. Proposal B: lighter, and cheaper to keep alive

### B1. Faster and lighter (no behaviour change)
1. **Compress in the app:** about 15 lines with Python's built-in `gzip` for JSON and text files (waitress and relayd do not
   compress). Measured: 264 KB becomes about 42 KB per load; the 118 KB list becomes about 5 KB.
2. **Cache static files for a long time, with the content hash in the file name.** Add the hash when the server starts (it
   rewrites the links in `index.html`), so there is no build step. Repeat visits then need no static requests at all.
3. **Trim the list payload:** drop fields the page never reads (for example `orig_filename`, `mime`, `codec`). Add
   `limit`/offset or "load more", and an ETag so an unchanged list answers 304.
4. **SQLite settings:** a busy timeout and `synchronous=NORMAL` (WAL is already on). No indexes are needed at this size.
5. **Do not minify.** It saves only about 35% on top of compression, adds a build step and makes the code harder to read.
   Compression gives most of the gain with no build.

### B2. Fewer lines to maintain
6. **Themes through variables.** The minimal theme is about 70 override rules at the end of `style.css`. If radius, border,
   fill and shadow become CSS variables, it shrinks to roughly 15 variable overrides and every rule is shared by both themes.
   The best maintenance win in the stylesheet.
7. **`app.js` from about 1,640 to roughly 1,100 lines:** a small state-and-render core, table-driven handlers for the
   repeated patterns (filter wiring, bulk bar, menu), row templates and event delegation. Rarely used parts (triage, the
   Backup page, bulk actions) could load only when opened. Caution: relayd speaks HTTP/1.1, so every extra file is a round
   trip; if the page is split into modules, keep the first-load path to one file.
8. **Python:** split the 800-line `create_app` into route modules by area (recordings, tags, media, data page, auth); remove
   the `parse_iso` / `parse_instant` overlap only if the lenient upload behaviour can be kept; make validation table-driven.
9. **Tests:** the 15 browser scripts repeat the same server start, WAV maker and seeding. One shared helper module removes
   roughly 600 lines; one `check` command runs everything.

### B3. Sustainability (years without attention)
10. **Run the browser tests in WebKit and Firefox as well.** They run only in Chromium, but the owner's phone is Safari.
    (Not checked whether those engines are available in the build environment.)
11. **Numbered database migrations** with `PRAGMA user_version`, replacing the ad hoc `ALTER TABLE` in `migrate()`.
12. **A self-test script** (tests, an export, a restore drill) that cron can run monthly and mail only on failure.
13. **A "yearly care" checklist** in the README: OS and Python upgrades, restore drill, export check, certificate renewal.
14. **Pin and vendor Flask and waitress** (pure Python; keep exact copies in the repo and an install-from-that-copy path). **(vendoring dropped; the pins are done)**
    Then reconsider a standard-library-only server (see `docs/PLAN.md`): the hard part is reading file uploads, which Python
    removed from its standard library in 3.13; sending the file as a plain request body would avoid needing it.

## 4. Recommended order

1. Compression and long-lived caching (B1.1, B1.2): the largest measured gain for the least code.
2. The interaction fixes (A1): removes the three "poor" interactions.
3. Loading changes (A2) together with the list payload trim (B1.3).
4. Variable-based themes (B2.6), then the `app.js` clean-up (B2.7) once the interaction work has reshaped it.
5. The test helper and the WebKit/Firefox runs (B2.9, B3.10), the migrations and self-test (B3.11, B3.12), and the
   yearly-care checklist (B3.13).
6. ~~Vendoring (B3.14)~~: tried and removed (see section 7). Pinning is done.

Before starting: re-run `tests/perf/measure.cjs` for a fresh baseline, and keep the 308 server tests and 15 browser scripts
green at every step. Most of these changes touch behaviour the browser tests pin down, so update those tests deliberately,
not as a side effect.

## 6. Progress (10 Nov 2026)
**Done, on branch `perf-compression`:** B1.1 (compression) and B1.2 (long-lived caching, with the fingerprint worked out by the server).
`app/riffbox/webcache.py`: text answers (JSON, HTML, CSS, JS) are gzip-compressed for browsers that accept it; the page files carry
`?v=<fingerprint>` in the addresses written into `index.html`, and a fingerprinted address is cached for a year (a changed file has a
new fingerprint, so there is no stale copy and no build step); the page itself is re-checked on every visit and answers "not
modified" when unchanged. Audio, ranges and the streamed export are never touched.
Measured with `tests/perf/measure.cjs` (300 recordings, 4x CPU, 1.6 Mbps, 150 ms): bytes on the wire for one page load **about 330 KB
to 55 KB**; the Library list **186 KB to 8.6 KB**; LCP **about 2.8 s (after groups) to about 1.1 s**, FCP about 0.8 s; a repeat visit loads
the page files from the browser's cache. Server list time about 9 to 12 ms, as before. **Not done:** B1.3 (trim the list payload, ETag on
the list), the interaction fixes (A1: opening the Library, Select mode and Select all are still 700 to 880 ms), the loading-order changes (A2).

## 7. Progress, branch `speed-and-upkeep` (10 Nov 2026; built, not yet deployed)
**A1 interactions (done).** Profiling at 4x CPU found that the biggest cost was not the number of elements but formatting dates:
`toLocaleDateString` and `toLocaleString` were called with options for every date of every row (about 35 percent of the time of drawing the
Library). Formatters are now made once and each answer remembered. Rows that are off screen are skipped by the browser
(`content-visibility: auto`). Select mode, Select all and leaving Select mode now change classes and tick marks on the rows already drawn.
Lab numbers (300 recordings, 4x CPU), before to after: opening the Library about 990 to 160-330 ms; Select mode on about 830 to 70-110 ms; Select
all about 1,095 to 50 ms; leaving Select mode about 790 to 40-50 ms; Cozy/Compact about 240-400 to 60-130 ms (phone 390 px and desktop 1280 px). Test:
`tests/e2e/speed.cjs` (the rows are not redrawn). **Not done:** event delegation and cloning rows from a template (not needed now), A2 (load the
Library list only when its tab opens; the list is 8.6 KB compressed, so the gain is small), optimistic marks (a mark already takes under 30 ms).
**B1.3 (list payload) partly done.** The lists now carry an ETag and `Cache-Control: private, no-cache`, so an unchanged list comes back as
"not modified" with no body. This needed one more fix: Flask renews the login cookie on every answer and then adds `Vary: Cookie`, which made
every saved copy unusable (the cookie never matched the one the copy was stored under); the revalidated lists no longer say it. Trimming unused
fields from the list was measured as not worth it (the compressed list is 8.6 KB).
**B3 upkeep (done).** Numbered migrations (`app/riffbox/migrations.py`, `PRAGMA user_version`; existing databases are adopted as version 2, a
copy is kept in `before-migration/`); all eight dependencies pinned to exact versions in `app/requirements.txt`. **Vendoring (B3.14) was built, then
removed at the owner's request: it tripled the size of the application for little benefit.** The browser tests can run in
WebKit and Firefox (`RIFFBOX_BROWSER`, `tests/e2e/_browser.cjs`). **Not verified:** the scripts have **not been run** in WebKit or Firefox, because those
engines could not be downloaded in the build environment (the network blocks the download host). Run them on a computer with the engines installed.
**Still planned:** theme variables (B2.6), a smaller `app.js` (B2.7), shared test helpers (B2.9), the monthly self-test (B3.12), the yearly-care checklist (B3.13).

## 8. Progress, branch `code-upkeep` (10 Nov 2026; built, not deployed)
**B2.6 theme variables (done):** the minimal style is a block of variables plus 22 selectors (was 67 override selectors); 104 screenshots pixel-identical
before and after. **B2.7 smaller `app.js` (done, as a split):** 2,012 to 1,382 lines in the core; `transport.js`, `triage.js`, `pages.js`, `boot.js`; a shared `ask()` for change
requests. The files are plain scripts that share names, so there is no module system and no build step; each is cached for a year (fingerprinted). **B2.9 shared test helpers
(done):** `tests/e2e/_helpers.cjs`. **B3.10 WebKit and Firefox runs (done, with one limit):** see `PHASES.md` (three real fixes found; four Firefox scripts that play sound need
a machine with a sound device). **Still planned:** A2 (Library list only when its tab opens), the monthly self-test (B3.12), the yearly-care checklist (B3.13).
Measured after this branch (300 recordings, 4x CPU, 1.6 Mbps): page load LCP about 1.1 s, FCP about 0.9 s; 12 requests (the page, three style/theme files, five scripts, the API
calls), 59 KB on the wire (the split into five scripts costs about 4 KB and no extra waiting: the requests run in parallel and are cached for a year); Library open 158 ms, Select on 48 ms,
Select all 38 ms, Cozy/Compact 44-70 ms in Chromium. Safari and Firefox draw every row (no off-screen skipping), about 330-430 ms to open the Library in the same lab.
