"use strict";
// All URLs are relative ("api/..."), so the app works under any prefix such as /ideas/.
// No inline handlers, data: or blob: URLs, no third-party hosts (the site's security headers forbid them).

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids) node.append(kid);
  return node;
}

async function api(path, opts) {
  return fetch("api/" + path, { credentials: "same-origin", ...opts });
}
const sendJson = (path, method, body) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";
// A 401 means the session ended: show the login page. Returns true so callers can stop.
function loggedOut(r) {
  if (r.status !== 401) return false;
  show("login");
  return true;
}

// Send a change request and answer with its JSON body, or null after saying why it failed in the notice (and showing the login page
// if the session ended). `failed` finishes the sentence "Could not ...".
async function ask(path, method, body, failed) {
  let r;
  try { r = await (body === undefined ? api(path, { method }) : sendJson(path, method, body)); } catch (e) { notify(NETWORK_ERROR); return null; }
  if (loggedOut(r)) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { notify(data.error || "Could not " + failed + " (error " + r.status + ")."); return null; }
  return data;
}

// ---- login ---------------------------------------------------------------
function show(view) {
  $("#login").hidden = view !== "login";
  $("#app").hidden = view !== "app";
  $("#playerbar").hidden = view !== "app";
}

async function boot() {
  let ok = false;
  try { ok = (await api("session")).ok; } catch (e) { /* offline: fall through to login */ }
  if (ok) { show("app"); route(); await loadList(); } else { show("login"); $("#pass").focus(); }
}

// ---- list + playback -------------------------------------------------------
const player = $("#player");
let playingId = null;

// Sizes use a non-breaking space so "94 KB" never splits across two lines.
function fmtSize(n) {
  const nb = "\u00a0";
  return n >= 1073741824 ? (n / 1073741824).toFixed(2) + nb + "GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + nb + "MB"
       : Math.max(1, Math.round(n / 1024)) + nb + "KB";
}

// Dates. Every recording has a date uploaded and a date recorded. The date recorded starts out as the date
// uploaded; entering a date in the form sets it (stored as local noon on that day, so it can never slip to
// the neighbouring day), and clearing the box puts it back to the upload date.
const dayKey = (iso) => {                         // the local calendar day, "2026-03-01"
  const d = new Date(iso);
  return isNaN(d) ? "" : d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
// Formatters are made once, and each answer is remembered: building one per call was the slowest part of drawing a long list.
const dayFormat = new Intl.DateTimeFormat([], { dateStyle: "medium" });
const stampFormat = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "medium" });
const memo = (format) => { const seen = new Map(); return (iso) => { let r = seen.get(iso); if (r === undefined) { const d = new Date(iso); r = isNaN(d) ? null : format(d); seen.set(iso, r); } return r; }; };
const dayText = memo((d) => dayFormat.format(d)), stampText = memo((d) => stampFormat.format(d));
const fmtDay = (iso) => { const r = dayText(iso); return r === null ? iso : r; };
const dateIsSet = (rec) => rec.recorded_at !== rec.uploaded_at;      // a date recorded was entered by hand
const localNoon = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d, 12).toISOString(); };
function whenText(rec) {
  let text = fmtDay(rec.recorded_at);
  if (dateIsSet(rec) && dayKey(rec.recorded_at) !== dayKey(rec.uploaded_at)) text += " (uploaded " + fmtDay(rec.uploaded_at) + ")";
  return text;
}

// The automatic name ("Idea, Nov 8 3:42pm") is built here, from the same local time the date line
// shows. (The server only knows UTC, so a name it generated would disagree with the date line.)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The automatic name for a recording: the time it was uploaded, or, if a date recorded was entered, just that day.
function titleFor(recordedIso, dateEntered) {
  const d = new Date(recordedIso);
  return dateEntered ? "Idea, " + MONTHS[d.getMonth()] + " " + d.getDate() : autoTitle(d);
}
function autoTitle(d) {
  const h = d.getHours();
  return "Idea, " + MONTHS[d.getMonth()] + " " + d.getDate() + " " + (h % 12 || 12) + ":" +
         String(d.getMinutes()).padStart(2, "0") + (h < 12 ? "am" : "pm");
}

function markPlaying() {
  for (const li of document.querySelectorAll("#list li")) {
    const btn = li.querySelector(".play");
    if (!btn) continue;                                   // Trash rows have nothing to play
    const mine = playingId !== null && (li.dataset.pids || "").split(",").includes(String(playingId));   // an idea's row lights up for any of its parts
    const on = mine && !player.paused;
    li.classList.toggle("playing", mine);
    li.querySelector(".play").textContent = on ? "❚❚" : "▶";
    li.querySelector(".play").setAttribute("aria-label", (on ? "Pause " : "Play ") + li.dataset.title);
  }
}

let playStatus = new Map();    // recording id -> play_status from the latest list ("pending", "failed", ...)

// Start `rec` from the beginning (or, if it is already the loaded recording, make sure it is playing).
// `rec` is an idea; `part` one of its recordings (the one playing, else the first).
function startPlay(rec, part) {
  $("#audio-error").hidden = true;
  if (rec.rec) { part = rec.part; rec = rec.rec; }          // the player's own track object: play that part again
  part = part || (rec.parts || []).find((p) => p.id === playingId) || (rec.parts || [])[0] || rec;
  // After an error, starting again reloads the source (a FLAC play copy may be ready by now).
  if (playingId === part.id && !player.error) {
    if (player.paused) player.play().catch(() => {});
    return;
  }
  playingId = part.id;
  player.src = "api/play/" + part.id;     // the FLAC play copy if there is one, else the original
  loadTransport(trackFor(rec, part));
  player.play().catch(() => {});
  markPlaying();
}

// What the player bar shows for a recording: for one part of several, the idea, the part and where it stands.
function trackFor(rec, part) {
  if (!rec.parts || rec.parts.length < 2) return rec;
  const n = rec.parts.findIndex((p) => p.id === part.id) + 1;
  return { id: part.id, gid: rec.gid, rec, part, duration_s: part.duration_s,
           title: rec.title + " \u2014 " + part.title + " (part " + n + " of " + rec.parts.length + ")" };
}

function togglePlay(rec, part) {
  setSelected(rec.id, part ? part.id : null);
  part = part || (rec.parts || []).find((p) => p.id === playingId) || (rec.parts || [])[0] || rec;
  if (playingId === part.id && !player.error && !player.paused) { player.pause(); return; }
  startPlay(rec, part);
}

// Highlight a row (the one the arrow keys move from, and Space plays).
// Scroll just far enough that `el` is clear of the top edge and of the player bar. (CSS scroll-padding does the same for most
// browsers, but Safari does not apply it when focusing a field or scrolling a row into view.)
function reveal(el) {
  const r = el.getBoundingClientRect();
  const bar = playerBar.hidden ? window.innerHeight : playerBar.getBoundingClientRect().top;
  const limit = Math.min(window.innerHeight, bar) - 8;
  if (r.bottom > limit) window.scrollBy(0, r.bottom - limit);
  else if (r.top < 8) window.scrollBy(0, r.top - 8);
}

function setSelected(id, partId = null) {
  selectedId = id;
  selectedPart = partId;
  for (const li of document.querySelectorAll("#list > li")) {
    const isPart = li.classList.contains("part");
    const own = !isPart && Number(li.dataset.id) === id;
    const on = isPart ? partId !== null && Number(li.dataset.part) === partId : own && partId === null;
    li.classList.toggle("selected", on);
    li.classList.toggle("sel-parent", own && partId !== null);       // the idea whose part is highlighted
    if (on) { li.setAttribute("aria-current", "true"); reveal(li); }
    else li.removeAttribute("aria-current");
  }
}

player.addEventListener("play", markPlaying);
player.addEventListener("pause", markPlaying);
player.addEventListener("ended", markPlaying);
// When playback fails, ask the server what it actually returns, so the message names the real
// cause: logged out, file missing, server trouble, or a format this browser cannot decode.
player.addEventListener("error", async () => {
  if (playingId === null) return;
  const id = playingId;
  const mediaCode = player.error ? player.error.code : 0;   // 2 = network, 3 = decode, 4 = unsupported
  const msg = $("#audio-error");
  let text;
  try {
    const r = await fetch("api/play/" + id, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" });
    const status = playStatus.get(id);
    if (loggedOut(r)) return;
    if (r.status === 404) text = "That recording's audio file is missing on the server.";
    else if (!r.ok) text = "The server could not send this file (error " + r.status + ").";
    else if (mediaCode === 2) text = "A network problem interrupted loading the audio. Try again.";
    else if (status === "pending") text = "This recording is still being prepared for playback in your browser. " +
                "Try again in a few seconds.";
    else text = "This browser can't decode this file's audio format. It is probably Apple Lossless " +
                "(Voice Memos set to Lossless quality), which Safari plays but Chrome, Edge and Firefox do not. " +
                (status === "failed" ? "The server tried to make a playable copy and could not. "
                                     : "The server has no playable copy of it. ") +
                "Use Download to play it in VLC or another player, or open this page in Safari.";
  } catch (e) {
    text = NETWORK_ERROR;
  }
  if (playingId !== id) return;                            // user already moved on to another recording
  msg.textContent = text;
  msg.hidden = false;
});

// ---- inbox / library, details, and the intake form -------------------------------------------
// Uploads land in the Inbox. Saving the form (even completely empty) moves a recording to the Library.
const KEY_ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
let view = "inbox";            // which list is showing: "inbox" | "library" | "resurface" | "trash"
let resurfaceRecs = [];        // hearted ideas not played for a while (fetched while that tab is open)
let resurfaceHearts = 0;       // how many hearted ideas exist at all
let resurfaceDays = 30;
let density = "cozy";          // Library row size: "cozy" | "compact"
let trashRecs = [];            // recordings moved to the Trash (only fetched while that tab is open)
let trashCount = 0;
let inboxRecs = [];            // everything not yet saved to the Library
let libNeeds = 0;               // Library ideas still waiting for a tempo or key choice
let libRecs = [];              // Library recordings matching the current filters (the server does the filtering)
let libTotal = 0;              // Library size before any filter
let libRatings = { heart: 0, check: 0, x: 0, none: 0 };   // how many Library recordings carry each mark
let allTags = [];
let openEditId = null;         // at most one edit form open at a time
let selectedId = null;         // the highlighted row; arrow keys move it, Space plays it
let selectedPart = null;       // the recording highlighted inside an open idea (null: the idea's own row)
let selecting = false;         // "Select" mode (Inbox and Library): checkboxes and the bulk-action bar
const picked = new Set();      // ids ticked in Select mode
let lastPicked = null;         // for shift-click ranges
let pollTimer = null;
let loadSeq = 0;               // numbers each load so a slow, older response can't overwrite a newer one

// What the Library sidebar is asking for. Sort and the preview switch are remembered between visits
// (a per-device convenience only: everything still works if the browser refuses to store them).
const filters = { unresolved: false, q: "", tags: [], match: "all", bpm_min: null, bpm_max: null, key_root: "", key_mode: "", rating: "all",
                  sort: "uploaded", order: "desc" };      // newest upload first unless the owner picks otherwise
const DEFAULT_SORT = { sort: "uploaded", order: "desc" };
const BPM_LO = 40, BPM_HI = 240;   // the slider's ends; a thumb sitting at an end means "no limit" on that side
let autoPreview = true;
const stored = {
  get(k) { try { return localStorage.getItem("riffbox." + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem("riffbox." + k, v); } catch (e) { /* storage unavailable */ } },
};
{
  const s = stored.get("sort"), o = stored.get("order"), p = stored.get("preview");
  if (["recorded", "uploaded", "title", "bpm", "length", "played"].includes(s)) filters.sort = s;
  if (o === "asc" || o === "desc") filters.order = o;
  if (p === "0") autoPreview = false;
  if (stored.get("density") === "compact") density = "compact";
  const rd = Number(stored.get("resurface-days"));
  if ([0, 7, 30, 90, 180, 365].includes(rd) && stored.get("resurface-days") !== null) resurfaceDays = rd;
}

function detailsText(rec) {
  const parts = [];
  if (rec.bpm) parts.push(rec.bpm + " BPM");
  if (rec.key_root || rec.key_mode) parts.push([rec.key_root, rec.key_mode].filter(Boolean).join(" "));
  if (rec.rating === "check" && rec.used_in) parts.push("used in " + rec.used_in);
  return parts.join(" · ");
}
// The same for the Compact table: no "BPM", and major/minor as M/m ("108 · A m").
function shortDetails(rec) {
  const parts = [];
  if (rec.bpm) parts.push(String(rec.bpm));
  if (rec.key_root || rec.key_mode) parts.push([rec.key_root, rec.key_mode === "major" ? "M" : rec.key_mode === "minor" ? "m" : ""].filter(Boolean).join(" "));
  return parts.join(" · ");
}
// A date for the table: just the day on screen, the full timestamp (local, then UTC as stored) in the tooltip.
function dateCell(cls, iso) {
  const stamp = stampText(iso);
  const tip = stamp === null ? iso : stamp + "  (" + iso + ")";
  return el("span", { class: cls, title: tip }, el("span", { class: "d-full" }, fmtDay(iso)), el("span", { class: "d-iso" }, dayKey(iso) || iso));
}

function notify(text) {
  const n = $("#notice");
  n.textContent = text;
  n.hidden = !text;
}

function setView(next) {
  if (triage) exitTriage();
  view = next;
  selecting = false; picked.clear();
  autoOpened.clear(); selectedPart = null;
  openEditId = null;
  notify("");
  render();
  if (next === "trash" || next === "resurface") loadList();      // these lists are only fetched while open
}
$("#tab-inbox").addEventListener("click", () => setView("inbox"));
$("#tab-library").addEventListener("click", () => setView("library"));
$("#tab-resurface").addEventListener("click", () => setView("resurface"));
$("#tab-trash").addEventListener("click", () => setView("trash"));

// Row size for the Inbox and the Library: cozy (the full row) or compact (one slim line, to see more at once). One setting for
// both, remembered on this device.
function applyDensity() {
  const compact = (view === "library" || view === "inbox") && density === "compact";
  $("#list").classList.toggle("compact", compact);
  $("#results").classList.toggle("compact", compact);
  $("#dens-cozy").setAttribute("aria-pressed", String(density === "cozy"));
  $("#dens-compact").setAttribute("aria-pressed", String(density === "compact"));
  // On desktop a control that does not apply to the tab stays as an invisible placeholder, so nothing else moves.
  $("#library-tools").classList.toggle("slot-off", view !== "library" && view !== "inbox");
  $("#select-toggle").classList.toggle("slot-off", view !== "library" && view !== "inbox");
  $("#random").classList.toggle("slot-off", !(view === "library" || view === "inbox") || triage !== null);     // draws from the list on screen
  scheduleFitTags();
}
for (const [id, value] of [["#dens-cozy", "cozy"], ["#dens-compact", "compact"]]) {
  $(id).addEventListener("click", () => { density = value; stored.set("density", value); applyDensity(); const li = document.querySelector("#list li.selected"); if (li) reveal(li); });
}

function updateTabs() {
  const inbox = inboxRecs.length;
  $("#tab-inbox").textContent = "Inbox" + (inbox ? " (" + inbox + ")" : "");
  $("#tab-library").textContent = "Library" + (libTotal ? " (" + libTotal + ")" : "");
  $("#tab-trash").hidden = !trashCount && view !== "trash";
  $("#tab-trash").textContent = "Trash" + (trashCount ? " (" + trashCount + ")" : "");
  $("#tab-trash").setAttribute("aria-pressed", String(view === "trash"));
  $("#tab-resurface").setAttribute("aria-pressed", String(view === "resurface"));
  $("#tab-inbox").setAttribute("aria-pressed", String(view === "inbox"));
  $("#tab-library").setAttribute("aria-pressed", String(view === "library"));
}

const bpmActive = () => filters.bpm_min !== null || filters.bpm_max !== null;
const filtersActive = () => Boolean(filters.unresolved || filters.q.trim() || filters.tags.length || bpmActive() ||
                                    filters.key_root || filters.key_mode || filters.rating !== "all");

function render() {
  updateTabs();
  const inLibrary = view === "library";
  const shown = inLibrary ? libRecs : view === "trash" ? trashRecs : view === "resurface" ? resurfaceRecs : inboxRecs;
  $("#app").classList.toggle("in-trash", view === "trash");
  $("#side-inbox").hidden = view !== "inbox";                       // the left column: one panel per tab
  $("#side-resurface").hidden = view !== "resurface";
  $("#side-trash").hidden = view !== "trash";
  if (view === "resurface") {
    $("#resurface-days").value = String(resurfaceDays);
    $("#resurface-text").textContent = !resurfaceHearts ? "Heart (♥) some ideas in the Library and they will come back here."
      : resurfaceRecs.length + " of your " + resurfaceHearts + " hearted " + (resurfaceHearts === 1 ? "idea has" : "ideas have") +
        (resurfaceDays ? " not been played in " + $("#resurface-days").selectedOptions[0].textContent : " been listed") + ". Never-played ones come first, then the longest ago.";
  }
  const ul = $("#list");
  ul.replaceChildren();
  ul.classList.toggle("library", inLibrary);
  $("#filters").hidden = !inLibrary;
  $("#colhead").hidden = !inLibrary || !shown.length;
  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = (inboxRecs.length + libTotal) === 0 ? "Nothing yet. Upload a voice memo above."
      : view === "trash" ? "The Trash is empty."
      : view === "resurface" ? (resurfaceHearts ? "Every hearted idea has been played recently. Pick a shorter time, or press Surprise me for any ♥." : "No hearted ideas yet.")
      : !inLibrary ? "Nothing waiting to be tagged. Switch to Library to browse what you've saved."
      : libTotal === 0 ? "Nothing in the Library yet. Open a recording in the Inbox and save it, and it moves here."
      : "No recordings match these filters. Use Clear filters to start over.";
  }
  $("#kbd-hint").hidden = !shown.length || view === "trash";      // arrow keys do nothing in the Trash
  $("#triage-start").hidden = !(view === "inbox" && inboxRecs.length && !triage);
  $("#triage-start").textContent = "Triage the Inbox (" + inboxRecs.length + ")";
  if (inLibrary) { updateFilterUI(); updateSortHeaders(); }
  for (const id of picked) if (!selectableRecs().some((r) => r.id === id)) picked.delete(id);   // a filter hid it: never act on what you cannot see
  const canSelect = view === "library" || view === "inbox";
  $("#results").classList.toggle("selecting", canSelect && selecting);
  $("#select-toggle").setAttribute("aria-pressed", String(selecting));
  $("#bulkbar").hidden = !(canSelect && selecting);
  $("#bulk-inbox").hidden = view === "inbox";                    // already there
  if (canSelect && selecting) updateBulkBar();
  playStatus = new Map([...inboxRecs, ...libRecs, ...resurfaceRecs].flatMap((rec) => rec.parts.map((p) => [p.id, p.play_status])));
  if (selectedId !== null && !shown.some((r) => r.id === selectedId)) { selectedId = null; selectedPart = null; }   // filtered out
  for (const rec of shown) {
    if (view === "trash") ul.append(buildTrashRow(rec));
    else ul.append(buildRow(rec), ...(isOpen(rec) ? buildPartRows(rec) : []));
  }
  applyDensity();
  markPlaying();
}

const openParts = new Set();     // ideas whose parts are shown because you opened them (with the caret): they stay open
const autoOpened = new Set();    // ideas opened by arrowing onto them: they close again when you move off them
// Resurface always shows an idea whole, with every part; elsewhere an idea is open if you (or the arrow keys) opened it.
const isOpen = (rec) => (view === "resurface" && rec.parts.length > 1) || openParts.has(rec.gid) || autoOpened.has(rec.gid);
const rowFor = (rec) => document.querySelector('#list > li[data-id="' + rec.id + '"]');

// The rows for the recordings inside an idea, shown under it when it is open.
function buildPartRows(rec) {
  return rec.parts.map((p, i) => {
    const btn = el("button", { class: "play", type: "button" }, "▶");
    btn.addEventListener("click", () => togglePlay(rec, p));
    const lead = el("div", { class: "lead" });
    if (view === "library" || view === "inbox") {                       // ticking a part ticks the whole idea
      const box = el("input", { type: "checkbox", class: "rowsel", "aria-label": "Select " + rec.title });
      box.checked = picked.has(rec.id);
      box.addEventListener("click", (e) => pickRow(rec.id, box.checked, e.shiftKey));
      lead.append(box);
    }
    lead.append(btn);
    const info = el("div", { class: "info" }, el("div", { class: "title" }, p.title),
      el("div", { class: "meta when" }, (p.duration_s ? fmtTime(p.duration_s) + " · " : "") + fmtSize(p.size)),
      el("span", { class: "c-len", title: fmtSize(p.size) }, p.duration_s ? fmtTime(p.duration_s) : ""));
    const side = el("div", { class: "side" }, el("a", { class: "dl", href: "api/audio/" + p.id + "?download=1", title: "Download the original",
      "aria-label": "Download " + p.title }, el("span", { class: "dl-full" }, "Download"), el("span", { class: "dl-short", "aria-hidden": "true" }, "↓")));
    const li = el("li", { class: "part", "data-part": String(p.id), "data-gid": String(rec.gid), "data-owner": String(rec.id), "data-pids": String(p.id),
                          "data-title": p.title, "aria-label": "Part " + (i + 1) + " of " + rec.parts.length + ": " + p.title }, lead, info, side);
    if (picked.has(rec.id)) li.classList.add("picked");
    if (p.id === selectedPart) { li.classList.add("selected"); li.setAttribute("aria-current", "true"); }
    return li;
  });
}

// By hand (the caret): opening keeps it open, closing closes it; either way the "opened by arrowing" mark is cleared.
function toggleParts(rec, li) {
  const on = !isOpen(rec);
  autoOpened.delete(rec.gid);
  if (on) openParts.add(rec.gid); else openParts.delete(rec.gid);
  showParts(rec, li, on);
}

// Show or hide an idea's part rows in place (no rebuild of the list) and keep the caret in step.
function showParts(rec, li, on) {
  const caret = li.querySelector(".caret");
  if (caret) {
    caret.setAttribute("aria-expanded", String(on));
    caret.textContent = on ? "▾" : "▸";
    caret.setAttribute("aria-label", (on ? "Hide the " : "Show the ") + rec.parts.length + " parts of " + rec.title);
  }
  while (li.nextElementSibling && li.nextElementSibling.classList.contains("part")) li.nextElementSibling.remove();
  if (on) { let at = li; for (const p of buildPartRows(rec)) { at.after(p); at = p; } }
  markPlaying();
}

// For a search: the names of the parts (of an idea of several) that contain one of the searched words.
function partsMatching(rec) {
  if (rec.parts.length < 2 || !filters.q.trim()) return "";
  const words = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rec.parts.filter((p) => words.some((w) => p.title.toLowerCase().includes(w))).map((p) => p.title).join(", ");
}

function buildRow(rec) {
  const btn = el("button", { class: "play", type: "button" }, "▶");
  btn.addEventListener("click", () => togglePlay(rec));
  const lead = el("div", { class: "lead" });
  if (view === "library" || view === "inbox") {                     // always there, shown only in Select mode (so switching it needs no redraw)
    const box = el("input", { type: "checkbox", class: "rowsel", "aria-label": "Select " + rec.title });
    box.checked = picked.has(rec.id);
    box.addEventListener("click", (e) => pickRow(rec.id, box.checked, e.shiftKey));
    lead.append(box);
  }
  lead.append(btn);
  const meta = el("div", { class: "meta when" }, whenText(rec) +
    (rec.duration_s ? " · " + fmtTime(rec.duration_s) : "") + " · " + fmtSize(rec.size) +
    (view === "resurface" ? " · " + (rec.last_played_at ? "last played " + ago(rec.last_played_at) : "never played") : ""));
  if (rec.play_status === "pending") meta.append(el("span", { class: "chip" }, "preparing playback…"));
  if (rec.play_status === "failed") meta.append(el("span", { class: "chip" }, "no play copy"));
  const info = el("div", { class: "info" }, el("div", { class: "title" }, rec.title), meta);
  const details = detailsText(rec);
  if (details) {
    info.append(el("div", { class: "meta details", title: details }, el("span", { class: "d-full" }, details),
      el("span", { class: "d-short" }, shortDetails(rec))));
  }
  if (rec.tags.length) {
    const tags = el("div", { class: "tags" });
    for (const t of rec.tags) tags.append(el("span", { class: "chip tag" }, t));
    info.append(tags);
  }
  let noteText = rec.notes || "";
  const hit = view === "library" ? partsMatching(rec) : "";                     // searched words found in a part's name
  if (hit) noteText = "Matches part: " + hit + (noteText ? " · " + noteText : "");
  if (noteText) info.append(el("div", { class: "meta notes" }, noteText));
  // Table-only cells (hidden in the stacked layout, which shows the same facts in the line under the title)
  info.append(el("span", { class: "c-len", title: fmtSize(rec.size) }, rec.duration_s ? fmtTime(rec.duration_s) : ""),
    dateCell("c-rec", rec.recorded_at), dateCell("c-up", rec.uploaded_at));
  const edit = el("button", { class: "link edit-btn", type: "button", "aria-expanded": String(openEditId === rec.id) },
    "Edit");
  edit.addEventListener("click", () => {
    openEditId = openEditId === rec.id ? null : rec.id;
    notify("");
    render();
    if (openEditId !== null) {
      const first = document.querySelector("#list form.edit input");
      // put the cursor in the Title box, except on a touch screen, where that would throw the keyboard up at once
      if (first && !window.matchMedia("(pointer: coarse)").matches) { first.focus({ preventScroll: true }); reveal(first); }
    }
  });
  const rate = el("div", { class: "rate", role: "group", "aria-label": "Mark this recording" });
  for (const [key, glyph, label] of MARKS) {
    const b = el("button", { type: "button", class: "ratebtn", "data-rating": key, title: label,
                             "aria-label": label, "aria-pressed": String(rec.rating === key) }, glyph);
    b.addEventListener("click", () => setMark(rec, rec.rating === key ? null : key));
    rate.append(b);
  }
  const side = el("div", { class: "side" }, edit,
    el("a", { class: "dl", href: rec.parts.length > 1 ? "api/groups/" + rec.gid + "/download" : "api/audio/" + rec.id + "?download=1",
      title: rec.parts.length > 1 ? "Download all " + rec.parts.length + " parts as a zip (each part has its own Download below)" : "Download the original",
      "aria-label": "Download " + (rec.parts.length > 1 ? "all parts of " : "") + rec.title },
      el("span", { class: "dl-full" }, "Download"), el("span", { class: "dl-short", "aria-hidden": "true" }, "↓")), rate);
  const li = el("li", { "data-id": String(rec.id), "data-gid": String(rec.gid), "data-title": rec.title,
                        "data-pids": rec.parts.map((p) => p.id).join(",") }, lead, info, side);
  if (rec.parts.length > 1) {
    const open = isOpen(rec);
    const caret = view === "resurface" ? el("span", { class: "caret-gap", "aria-hidden": "true" }) : el("button", { class: "caret", type: "button", "aria-expanded": String(open),
      "aria-label": (open ? "Hide the " : "Show the ") + rec.parts.length + " parts of " + rec.title }, open ? "▾" : "▸");
    if (view !== "resurface") caret.addEventListener("click", () => toggleParts(rec, li));
    const t = info.querySelector(".title");
    t.classList.add("has-parts");                       // the badge stays visible when a long title is cut short
    t.replaceChildren(caret, el("span", { class: "tt" }, rec.title), el("span", { class: "chip parts", title: rec.parts.length + " recordings in this idea" }, String(rec.parts.length), el("span", { class: "p-w" }, " parts")));
  }
  if (rec.unresolved) {                                   // tempo or key the recordings disagreed on, waiting for a choice
    const what = Object.keys(rec.unresolved).map((k) => (k === "bpm" ? "tempo" : "key")).join(" & ");
    info.querySelector(".title").append(el("span", { class: "chip pending", title: "The recordings disagree on " + what + ". Open Edit to pick one." },
      "⚠", el("span", { class: "p-w" }, " pick " + what)));
  }
  if (picked.has(rec.id)) li.classList.add("picked");
  if (rec.id === selectedId) {
    li.classList.add(selectedPart === null ? "selected" : "sel-parent");
    if (selectedPart === null) li.setAttribute("aria-current", "true");
  }
  if (openEditId === rec.id) li.append(buildForm(rec));
  return li;
}

// A recording in the Trash: it can't be played or edited, only brought back.
function buildTrashRow(rec) {
  const restore = el("button", { class: "link restore-btn", type: "button" }, "Restore");
  restore.addEventListener("click", async () => {
    restore.disabled = true;
    if (!(await ask("groups/" + rec.gid + "/restore", "POST", undefined, "restore it"))) { restore.disabled = false; return; }
    await loadList();
    notify("Restored to the " + (rec.status === "inbox" ? "Inbox" : "Library") + ".");
  });
  const meta = el("div", { class: "meta when" }, "Deleted " + fmtDay(rec.deleted_at) + " · " + fmtSize(rec.size) +
    (rec.parts.length > 1 ? " · " + rec.parts.length + " parts" : ""));
  const info = el("div", { class: "info" }, el("div", { class: "title" }, rec.title), meta);
  if (rec.tags.length) {
    const tags = el("div", { class: "tags" });
    for (const t of rec.tags) tags.append(el("span", { class: "chip tag" }, t));
    info.append(tags);
  }
  return el("li", { "data-id": String(rec.id), "data-title": rec.title }, el("span"), info, el("div", { class: "side" }, restore));
}

function field(labelText, control, id) {
  return el("div", { class: "field" }, el("label", { for: id }, labelText), control);
}

function buildForm(rec) {
  const id = rec.id;
  const form = el("form", { class: "edit", novalidate: "" });

  const title = el("input", { id: "f-title-" + id, type: "text", maxlength: "200", value: rec.title });
  form.append(field("Title", title, "f-title-" + id));

  // instruments: toggle buttons, plus a box for new ones
  const tagBox = el("div", { class: "tagbox", role: "group", "aria-label": "Instruments and ideas" });
  const addToggle = (name, on) => {
    const b = el("button", { type: "button", class: "tagbtn", "data-tag": name, "aria-pressed": String(on) }, name);
    b.addEventListener("click", () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
    tagBox.append(b);
  };
  for (const t of allTags) addToggle(t, rec.tags.includes(t));
  const newTag = el("input", { id: "f-newtag-" + id, type: "text", maxlength: "30", placeholder: "new tag" });
  const addBtn = el("button", { type: "button" }, "Add tag");
  const tagErr = el("p", { class: "error", role: "alert", hidden: "" });
  const createTag = async () => {
    tagErr.hidden = true;
    if (!newTag.value.trim()) return;
    const r = await sendJson("tags", "POST", { name: newTag.value });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { tagErr.textContent = body.error || "Could not add that tag."; tagErr.hidden = false; return; }
    const existing = tagBox.querySelector('[data-tag="' + CSS.escape(body.name) + '"]');
    if (existing) existing.setAttribute("aria-pressed", "true");
    else { allTags.push(body.name); addToggle(body.name, true); }
    newTag.value = "";
  };
  addBtn.addEventListener("click", createTag);
  newTag.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createTag(); } });
  form.append(el("fieldset", {}, el("legend", {}, "What's in it?"), tagBox,
    el("div", { class: "addtag" }, newTag, addBtn), tagErr));

  // marks: ♥ interesting, ✓ used in a song (with its name), ✗ no longer interesting
  let mark = rec.rating;
  const markBox = el("div", { class: "rate", role: "group", "aria-label": "Mark this recording" });
  const usedIn = el("input", { id: "f-used-" + id, type: "text", maxlength: "200", placeholder: "Which song? (optional)",
                               value: rec.used_in || "" });
  const usedField = field("Used in", usedIn, "f-used-" + id);
  const syncMarks = () => {
    for (const b of markBox.children) b.setAttribute("aria-pressed", String(b.dataset.rating === mark));
    usedField.hidden = mark !== "check";
  };
  for (const [key, glyph, label] of MARKS) {
    const b = el("button", { type: "button", class: "ratebtn", "data-rating": key, title: label, "aria-label": label,
                             "aria-pressed": "false" }, glyph);
    b.addEventListener("click", () => { mark = mark === key ? null : key; syncMarks(); });
    markBox.append(b);
  }
  form.append(el("fieldset", {}, el("legend", {}, "Mark"), markBox), usedField);
  syncMarks();

  // BPM: a number, with tap-along
  const bpm = el("input", { id: "f-bpm-" + id, type: "number", min: "20", max: "400", inputmode: "numeric",
                            value: rec.bpm == null ? "" : String(rec.bpm) });
  const tap = el("button", { type: "button" }, "Tap tempo");
  let taps = [];
  tap.addEventListener("click", () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];      // a pause starts over
    taps.push(now);
    taps = taps.slice(-8);
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      bpm.value = String(Math.min(400, Math.max(20, Math.round(60000 / avg))));
    }
  });
  form.append(el("div", { class: "field" }, el("label", { for: "f-bpm-" + id }, "BPM (optional)"),
                 el("div", { class: "bpm" }, bpm, tap)));
  const waived = new Set();                                    // tempo / key left empty on purpose: stop asking
  // The recordings of a new group can disagree; both answers are kept here until one is picked (or waived).
  const pendingNote = (kind, text, choices, none, apply) => {
    const box = el("div", { class: "pending-note" }, el("p", { class: "meta" }, text));
    for (const c of choices) {
      const b = el("button", { type: "button" }, c.label);
      b.addEventListener("click", () => { apply(c); waived.delete(kind); box.hidden = true; });
      box.append(b);
    }
    const n = el("button", { type: "button", class: "link" }, none);
    n.addEventListener("click", () => { apply(null); waived.add(kind); box.hidden = true; });
    box.append(n);
    form.append(box);
  };
  if (rec.unresolved && rec.unresolved.bpm) {
    pendingNote("bpm", "These recordings had different tempos. Pick the one for the whole idea:",
      rec.unresolved.bpm.map((c) => ({ label: c.value + " BPM (" + c.from.join(", ") + ")", value: c.value })), "No tempo",
      (c) => { bpm.value = c ? String(c.value) : ""; });
  }

  // key
  const root = el("select", { id: "f-root-" + id });
  root.append(el("option", { value: "" }, "—"));
  for (const k of KEY_ROOTS) root.append(el("option", { value: k }, k));
  root.value = rec.key_root || "";
  const mode = el("select", { id: "f-mode-" + id });
  mode.append(el("option", { value: "" }, "—"), el("option", { value: "major" }, "major"), el("option", { value: "minor" }, "minor"));
  mode.value = rec.key_mode || "";
  form.append(el("div", { class: "keyrow" }, field("Key", root, "f-root-" + id), field("Major / minor", mode, "f-mode-" + id)));
  if (rec.unresolved && rec.unresolved.key) {
    pendingNote("key", "These recordings had different keys. Pick the one for the whole idea:",
      rec.unresolved.key.map((c) => ({ label: [c.key_root, c.key_mode].filter(Boolean).join(" ") + " (" + c.from.join(", ") + ")", value: c })), "No key",
      (c) => { root.value = c ? c.value.key_root || "" : ""; mode.value = c ? c.value.key_mode || "" : ""; });
  }

  // date recorded: blank means "same as the date uploaded"
  const initialDate = dateIsSet(rec) ? dayKey(rec.recorded_at) : "";
  const dateInput = el("input", { id: "f-date-" + id, type: "date", value: initialDate, max: dayKey(new Date().toISOString()) });
  form.append(el("div", { class: "field" }, el("label", { for: "f-date-" + id }, "Date recorded (optional)"), dateInput,
    el("div", { class: "meta" }, "Leave it blank to use the date it was uploaded (" + fmtDay(rec.uploaded_at) + ").")));

  const notes = el("textarea", { id: "f-notes-" + id, rows: "3", maxlength: "5000" });
  notes.value = rec.notes || "";
  form.append(field("Notes", notes, "f-notes-" + id));

  const err = el("p", { class: "error", role: "alert", hidden: "" });
  // an idea made of several recordings: name and order the parts, take one out, or break the idea up
  const partRows = [];
  if (rec.parts.length > 1) {
    const list = el("ul", { class: "parts-list" });
    const armedBtns = new Map();
    const arm = (btn, ask, run) => btn.addEventListener("click", async () => {
      if (!armedBtns.has(btn)) {                                 // first press asks, a second within 4 s does it
        const was = btn.textContent;
        btn.textContent = ask;
        armedBtns.set(btn, setTimeout(() => { armedBtns.delete(btn); btn.textContent = was; }, 4000));
        return;
      }
      clearTimeout(armedBtns.get(btn)); armedBtns.delete(btn);
      btn.disabled = true;
      let r;
      try { r = await run(); } catch (e) { err.textContent = NETWORK_ERROR; err.hidden = false; btn.disabled = false; return; }
      if (loggedOut(r)) return;
      if (!r.ok) { err.textContent = (await r.json().catch(() => ({}))).error || "Could not do that (error " + r.status + ")."; err.hidden = false; btn.disabled = false; return; }
      openEditId = null;
      await loadList();
      notify(ask.includes("break") ? "Broke the idea up into separate recordings." : "Took the recording out into its own idea.");
    });
    for (const p of rec.parts) {
      const input = el("input", { type: "text", maxlength: "200", value: p.title, "aria-label": "Name of this part" });
      const up = el("button", { type: "button", "aria-label": "Move this part up", title: "Move up" }, "↑");
      const down = el("button", { type: "button", "aria-label": "Move this part down", title: "Move down" }, "↓");
      const out = el("button", { type: "button", class: "link", title: "Make this recording its own idea again" }, "Take out");
      const li = el("li", { "data-part": String(p.id) }, input, up, down, out);
      up.addEventListener("click", () => { if (li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling); });
      down.addEventListener("click", () => { if (li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li); });
      arm(out, "Press again to take out", () => api("groups/" + rec.gid + "/parts/" + p.id, { method: "DELETE" }));
      partRows.push([p.id, input, li]);
      list.append(li);
    }
    const ungroup = el("button", { type: "button", class: "link danger" }, "Break up this idea");
    arm(ungroup, "Press again to break up", () => api("groups/" + rec.gid + "/ungroup", { method: "POST" }));
    form.append(el("fieldset", {}, el("legend", {}, "Parts (" + rec.parts.length + ")"), list, ungroup));
  }
  // "Save" keeps the recording where it is (so a half-filled form can be saved in the Inbox); in the Inbox a second
  // button saves and moves it to the Library. Enter in a field is a plain Save.
  const save = el("button", { type: "submit", class: "primary" }, "Save");
  const cancel = el("button", { type: "button" }, "Cancel");
  cancel.addEventListener("click", () => { openEditId = null; notify(""); render(); });
  const actions = el("div", { class: "actions" }, save);
  if (rec.status === "inbox") {
    const move = el("button", { type: "button", class: "save-move" }, "Save and move to Library");
    move.addEventListener("click", () => submit("tagged"));
    actions.append(move);
  }
  actions.append(cancel);
  let back = null;
  if (rec.status !== "inbox") { back = el("button", { type: "button", class: "link" }, "Move back to Inbox"); actions.append(back); }
  const del = el("button", { type: "button", class: "link danger" }, "Delete");
  let armed = null;
  del.addEventListener("click", async () => {
    if (!armed) {                                              // first press asks; a second press within 4 s does it
      del.textContent = "Press again to move to Trash";
      armed = setTimeout(() => { armed = null; del.textContent = "Delete"; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null;
    try {
      const r = await api("groups/" + rec.gid, { method: "DELETE" });
      if (loggedOut(r)) return;
      if (!r.ok) { err.textContent = "Could not delete (error " + r.status + ")."; err.hidden = false; del.textContent = "Delete"; return; }
    } catch (e) { err.textContent = NETWORK_ERROR; err.hidden = false; del.textContent = "Delete"; return; }
    if (playingId === id) { player.pause(); }
    openEditId = null;
    await loadList();
    notify("Moved to Trash. It is kept, and the Trash tab can restore it.");
  });
  actions.append(del);
  form.append(err, actions);

  const submit = async (status) => {
    err.hidden = true;
    const bpmText = bpm.value.trim();
    const dateChanged = dateInput.value !== initialDate;       // only send the date if it was touched
    const recordedIso = dateChanged ? (dateInput.value ? localNoon(dateInput.value) : rec.uploaded_at) : rec.recorded_at;
    const dateEntered = dateChanged ? Boolean(dateInput.value) : dateIsSet(rec);
    const payload = {
      title: title.value.trim() || titleFor(recordedIso, dateEntered),   // blank title = regenerate it
      tags: [...tagBox.querySelectorAll('.tagbtn[aria-pressed="true"]')].map((b) => b.dataset.tag),
      bpm: bpmText === "" ? null : Number(bpmText),
      key_root: root.value || null,
      key_mode: mode.value || null,
      notes: notes.value,
      status,
      rating: mark,
      used_in: mark === "check" ? (usedIn.value.trim() || null) : null,
    };
    if (waived.size) payload.resolved = [...waived];
    if (dateChanged) payload.recorded_at = dateInput.value ? localNoon(dateInput.value) : null;   // null = use the upload date
    if (partRows.length) {                                      // part names, in the order shown
      const byId = new Map(partRows.map(([pid, input]) => [pid, input]));
      payload.parts = [...form.querySelectorAll(".parts-list > li")].map((li) => {
        const pid = Number(li.dataset.part);
        return { id: pid, title: byId.get(pid).value.trim() || "Part" };
      });
    }
    const r = await sendJson("groups/" + rec.gid, "PATCH", payload);
    if (loggedOut(r)) return;
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      err.textContent = body.error || "Could not save (error " + r.status + ").";
      err.hidden = false;
      return;
    }
    openEditId = null;
    await loadList();
    notify(status === rec.status ? (status === "inbox" ? "Saved. Still in the Inbox." : "Saved.")
      : status === "inbox" ? "Moved back to Inbox." : "Saved. Moved to Library.");
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(rec.status); });
  if (back) back.addEventListener("click", () => submit("inbox"));
  return form;
}

function libraryQuery() {
  const p = new URLSearchParams({ status: "tagged", sort: filters.sort, order: filters.order });
  if (filters.q.trim()) p.set("q", filters.q.trim());
  if (filters.tags.length) { p.set("tags", filters.tags.join(",")); p.set("match", filters.match); }
  if (filters.bpm_min !== null) p.set("bpm_min", filters.bpm_min);
  if (filters.bpm_max !== null) p.set("bpm_max", filters.bpm_max);
  if (filters.key_root) p.set("key_root", filters.key_root);
  if (filters.key_mode) p.set("key_mode", filters.key_mode);
  if (filters.unresolved) p.set("unresolved", "1");
  // "All" leaves out the ones marked ✗ (no longer interesting); pick ✗ to see them
  p.set("rating", filters.rating === "all" ? "heart,check,none" : filters.rating);
  return p.toString();
}

// The server sends ideas (groups). Until the page shows several parts, an idea is shown through its first
// recording: `id` is that recording's number (used for audio and the per-recording endpoints), `gid` the idea's.
const gidOf = new Map();
function asRec(g) {
  const p = g.parts[0];
  gidOf.set(p.id, g.id);
  return { ...g, gid: g.id, id: p.id, codec: p.codec, play_status: g.parts.some((x) => x.play_status === "pending") ? "pending" : g.parts.some((x) => x.play_status === "failed") ? "failed" : p.play_status, orig_filename: p.orig_filename, mime: p.mime, parts: g.parts };
}
const asRecs = (body) => body.groups.map(asRec);

async function loadList() {
  clearTimeout(pollTimer);
  const seq = ++loadSeq;
  let inbox, lib, tags, trash, forgotten;
  try {
    [inbox, lib, tags, trash, forgotten] = await Promise.all([
      api("groups?status=inbox&sort=recorded&order=desc"), api("groups?" + libraryQuery()), api("tags"),
      view === "trash" ? api("trash") : Promise.resolve(null),
      view === "resurface" ? api("resurface?days=" + resurfaceDays) : Promise.resolve(null)]);
  } catch (e) {
    if (seq === loadSeq) { notify(NETWORK_ERROR); schedulePoll(); }
    return;
  }
  if (inbox.status === 401 || lib.status === 401) { if (seq === loadSeq) show("login"); return; }
  if (!inbox.ok || !lib.ok) { notify("Could not load your recordings (error " + (lib.ok ? inbox.status : lib.status) + ")."); return; }
  const [inboxBody, libBody] = await Promise.all([inbox.json(), lib.json()]);
  if (seq !== loadSeq) return;                // a newer load is already on its way; this answer is stale
  inboxRecs = asRecs(inboxBody);
  libRecs = asRecs(libBody);
  libTotal = libBody.total;
  libNeeds = libBody.needs || 0;
  libRatings = libBody.ratings;
  trashCount = inboxBody.trashed;
  if (trash && trash.ok) trashRecs = asRecs(await trash.json());
  if (forgotten && forgotten.ok) { const body = await forgotten.json(); resurfaceRecs = asRecs(body); resurfaceHearts = body.hearts; }
  if (tags.ok) allTags = (await tags.json()).tags;
  if (openEditId !== null) updateTabs();     // never rebuild the list under a form someone is typing in
  else render();
  schedulePoll();
}

// While the server is still converting something, check again shortly so the chip clears itself
// (but not while a form is open: that would throw away what is being typed).
function schedulePoll() {
  clearTimeout(pollTimer);
  if (![...inboxRecs, ...libRecs].some((rec) => rec.play_status === "pending")) return;
  pollTimer = setTimeout(() => { if (openEditId !== null) schedulePoll(); else loadList(); }, 3000);
}

// ---- Library sidebar: search, tag/tempo/key filters, sorting ----------------------------------------
const SORT_WORDS = {      // what the direction button says, per sort
  recorded: { desc: "Newest first", asc: "Oldest first" },
  uploaded: { desc: "Newest first", asc: "Oldest first" },
  title: { asc: "A to Z", desc: "Z to A" },
  bpm: { desc: "Highest first", asc: "Lowest first" },
  length: { desc: "Longest first", asc: "Shortest first" },
  played: { desc: "Most recent first", asc: "Longest ago first" },
};
const DEFAULT_ORDER = { recorded: "desc", uploaded: "desc", title: "asc", bpm: "desc", length: "desc", played: "desc" };

for (const k of KEY_ROOTS) $("#f-root").append(el("option", { value: k }, k));
let renderedTagKey = "";

function updateFilterUI() {
  // tag buttons are only rebuilt when the set of tags changes, so a click never steals keyboard focus
  const key = allTags.join("\n");
  if (key !== renderedTagKey) {
    renderedTagKey = key;
    const box = $("#f-tags");
    box.replaceChildren();
    for (const t of allTags) {
      const b = el("button", { type: "button", class: "tagbtn", "data-tag": t, "aria-pressed": "false" }, t);
      b.addEventListener("click", () => {
        const i = filters.tags.indexOf(t);
        if (i >= 0) filters.tags.splice(i, 1); else filters.tags.push(t);
        filtersChanged(0);
      });
      box.append(b);
    }
  }
  for (const b of $("#f-tags").children) b.setAttribute("aria-pressed", String(filters.tags.includes(b.dataset.tag)));
  const words = SORT_WORDS[filters.sort][filters.order];
  $("#f-order").textContent = (filters.order === "desc" ? "↓ " : "↑ ") + words;
  $("#f-order").setAttribute("aria-label", "Sort direction: " + words + ". Press to reverse.");
  $("#f-sort").value = filters.sort;
  $("#f-preview").checked = autoPreview;
  $("#f-clear").disabled = !filtersActive();
  $("#f-unresolved").checked = filters.unresolved;
  $("#f-unresolved-label").textContent = "Needs a tempo or key choice · " + libNeeds;
  const n = [filters.unresolved, filters.q.trim(), filters.tags.length, bpmActive(), filters.key_root, filters.key_mode,
             filters.rating !== "all"].filter(Boolean).length;
  syncBpmUI();
  const counts = { all: libTotal - libRatings.x, heart: libRatings.heart, check: libRatings.check, x: libRatings.x, none: libRatings.none };
  for (const r of document.querySelectorAll('input[name="f-show"]')) {
    r.checked = r.value === filters.rating;
    const label = $('label[for="' + r.id + '"]');
    label.textContent = label.dataset.base + " · " + counts[r.value];
  }
  $("#filters-toggle").textContent = n ? "Filters (" + n + " active)" : "Filters";
  const hiddenX = filters.rating === "all" ? libRatings.x : 0;     // ✗ ones that "All" leaves out
  const otherFilters = Boolean(filters.unresolved || filters.q.trim() || filters.tags.length || bpmActive() || filters.key_root || filters.key_mode);
  $("#f-count").textContent = libTotal === 0 ? ""
    : otherFilters || filters.rating !== "all" ? libRecs.length + " of " + libTotal + " recordings"
    : libRecs.length + (libRecs.length === 1 ? " recording" : " recordings") + (hiddenX ? " (" + hiddenX + " marked ✗ hidden)" : "");
}

let filterTimer = null;
function filtersChanged(delay) {
  clearTimeout(filterTimer);
  if (openEditId !== null) notify("Filters apply when you save or cancel the open form.");
  filterTimer = setTimeout(loadList, delay);
  if (openEditId === null) updateFilterUI();
}

$("#f-q").addEventListener("input", (e) => { filters.q = e.target.value; filtersChanged(200); });
for (const r of document.querySelectorAll('input[name="f-show"]')) {
  r.addEventListener("change", () => { filters.rating = r.value; filtersChanged(0); });
}
for (const r of document.querySelectorAll('input[name="f-match"]')) {
  r.addEventListener("change", () => { filters.match = r.value; if (filters.tags.length > 1) filtersChanged(0); else updateFilterUI(); });
}
// BPM range: two thumbs on one track. A thumb at its end of the track means "no limit" on that side.
const bpmMin = $("#f-bpm-min"), bpmMax = $("#f-bpm-max");
function syncBpmUI() {
  bpmMin.value = filters.bpm_min === null ? BPM_LO : filters.bpm_min;
  bpmMax.value = filters.bpm_max === null ? BPM_HI : filters.bpm_max;
  const lo = Number(bpmMin.value), hi = Number(bpmMax.value), span = BPM_HI - BPM_LO;
  $("#f-bpm-fill").style.left = ((lo - BPM_LO) / span) * 100 + "%";
  $("#f-bpm-fill").style.right = (1 - (hi - BPM_LO) / span) * 100 + "%";
  $("#f-bpm-readout").textContent = !bpmActive() ? "Any BPM"
    : filters.bpm_min !== null && filters.bpm_max !== null ? lo + "–" + hi + " BPM"
    : filters.bpm_min !== null ? lo + " BPM and up" : "Up to " + hi + " BPM";
  bpmMin.setAttribute("aria-valuetext", filters.bpm_min === null ? "No lower limit" : lo + " BPM");
  bpmMax.setAttribute("aria-valuetext", filters.bpm_max === null ? "No upper limit" : hi + " BPM");
  $("#f-bpm-note").hidden = !bpmActive();
  // whichever thumb is nearer the middle of the track stays underneath, so overlapping thumbs can both be grabbed
  bpmMin.style.zIndex = lo > (BPM_LO + BPM_HI) / 2 ? 3 : 2;
  bpmMax.style.zIndex = lo > (BPM_LO + BPM_HI) / 2 ? 2 : 3;
}
function bpmInput(which) {
  let lo = Number(bpmMin.value), hi = Number(bpmMax.value);
  if (which === "min" && lo > hi) lo = hi;                  // the thumbs cannot cross
  if (which === "max" && hi < lo) hi = lo;
  filters.bpm_min = lo > BPM_LO ? lo : null;
  filters.bpm_max = hi < BPM_HI ? hi : null;
  syncBpmUI();
  filtersChanged(150);
}
bpmMin.addEventListener("input", () => bpmInput("min"));
bpmMax.addEventListener("input", () => bpmInput("max"));
$("#f-root").addEventListener("change", (e) => { filters.key_root = e.target.value; filtersChanged(0); });
$("#f-unresolved").addEventListener("change", (e) => { filters.unresolved = e.target.checked; filtersChanged(0); });
$("#f-mode").addEventListener("change", (e) => { filters.key_mode = e.target.value; filtersChanged(0); });
$("#f-sort").addEventListener("change", (e) => {
  filters.sort = e.target.value;
  filters.order = DEFAULT_ORDER[filters.sort];
  stored.set("sort", filters.sort); stored.set("order", filters.order);
  filtersChanged(0);
});
$("#f-order").addEventListener("click", () => {
  filters.order = filters.order === "desc" ? "asc" : "desc";
  stored.set("order", filters.order);
  filtersChanged(0);
});
$("#f-preview").addEventListener("change", (e) => { autoPreview = e.target.checked; stored.set("preview", autoPreview ? "1" : "0"); });
$("#f-clear").addEventListener("click", () => {
  Object.assign(filters, { unresolved: false, q: "", tags: [], match: "all", bpm_min: null, bpm_max: null, key_root: "", key_mode: "", rating: "all" });
  $("#f-q").value = ""; $("#f-root").value = ""; $("#f-mode").value = "";
  $("#f-match-all").checked = true;
  filtersChanged(0);
});
$("#filters-toggle").addEventListener("click", () => {
  const open = $("#filters").classList.toggle("open");
  $("#filters-toggle").setAttribute("aria-expanded", String(open));
});

// ---- Resurface: hearted ideas you have not played for a while ----------------------------------------
$("#resurface-days").addEventListener("change", (e) => {
  resurfaceDays = Number(e.target.value);
  stored.set("resurface-days", String(resurfaceDays));
  loadList();
});
let surprising = false;
$("#surprise").addEventListener("click", async () => {
  if (surprising) return;
  surprising = true;
  try {
    let pool = resurfaceRecs, anyHeart = false;
    if (!pool.length && resurfaceHearts) {                    // all hearted ideas were played lately: draw from every one
      const r = await api("resurface?days=0");
      if (loggedOut(r)) return;
      if (r.ok) { pool = asRecs(await r.json()); anyHeart = true; }
    }
    if (!pool.length) { notify("Nothing hearted yet. Heart (♥) some ideas in the Library first."); return; }
    const choices = pool.length > 1 ? pool.filter((r) => !r.parts.some((p) => p.id === playingId)) : pool;     // not the one already playing
    const rec = choices[Math.floor(Math.random() * choices.length)];
    setSelected(rec.id);
    startPlay(rec, rec.parts[0]);
    notify("Playing \u201c" + rec.title + "\u201d" + (rec.last_played_at ? ", last played " + ago(rec.last_played_at) : ", which you have never played") +
           (anyHeart ? " (every hearted idea was played lately, so this is any \u2665)." : "."));
  } catch (e) { notify(NETWORK_ERROR); }
  finally { surprising = false; }
});

// ---- sorting by clicking a column heading: first click ascending, second descending, third back to the default ----
function updateSortHeaders() {
  for (const b of document.querySelectorAll("#colhead button[data-sort]")) {
    const on = b.dataset.sort === filters.sort;
    b.setAttribute("aria-sort", on ? (filters.order === "asc" ? "ascending" : "descending") : "none");
    b.querySelector(".caret").textContent = on ? (filters.order === "asc" ? "▲" : "▼") : "";
  }
}
function cycleSort(column) {
  if (filters.sort !== column) { filters.sort = column; filters.order = "asc"; }
  else if (filters.order === "asc") filters.order = "desc";
  else if (column === DEFAULT_SORT.sort) filters.order = "asc";            // desc is already the default for this one
  else Object.assign(filters, DEFAULT_SORT);
  stored.set("sort", filters.sort); stored.set("order", filters.order);
  filtersChanged(0);
}
for (const b of document.querySelectorAll("#colhead button[data-sort]")) b.addEventListener("click", () => cycleSort(b.dataset.sort));

// ---- Tags in the Compact table: whole tags that fit, then "+N" (hover for the rest). Never "b…" ----------------
let fitTimer = null;
function scheduleFitTags() { clearTimeout(fitTimer); fitTimer = setTimeout(fitAllTags, 30); }
function fitTags(box) {
  for (const old of box.querySelectorAll(".more")) old.remove();
  const chips = [...box.querySelectorAll(".chip.tag")];
  for (const c of chips) c.hidden = false;
  if (!box.closest("#list").classList.contains("compact") || !window.matchMedia("(min-width: 1240px)").matches || !chips.length) return;
  const wraps = (c) => c.offsetTop - chips[0].offsetTop > 2;                // a chip on a second line does not fit
  const hiddenCount = chips.filter(wraps).length;
  if (!hiddenCount) return;
  const more = el("span", { class: "chip tag more" });
  box.append(more);
  let shown = chips.length - hiddenCount;
  const place = () => {
    for (const [i, c] of chips.entries()) c.hidden = i >= shown;
    more.textContent = "+" + (chips.length - shown);
    more.title = chips.slice(shown).map((c) => c.textContent).join(", ");
  };
  place();
  while (shown > 0 && wraps(more)) { shown--; place(); }                    // make room for the "+N" itself
}
function fitAllTags() { for (const box of document.querySelectorAll("#list .tags")) fitTags(box); }
new ResizeObserver(scheduleFitTags).observe($("#results"));

// ---- Select mode and bulk actions (Library) ---------------------------------------------------------------
const selectableRecs = () => (view === "inbox" ? inboxRecs : libRecs);
function pickRow(id, on, range) {
  if (range && lastPicked !== null) {                                       // shift-click: everything between the two ticks
    const ids = selectableRecs().map((r) => r.id), a = ids.indexOf(lastPicked), b = ids.indexOf(id);
    if (a >= 0 && b >= 0) for (const i of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) { if (on) picked.add(i); else picked.delete(i); }
  } else if (on) picked.add(id); else picked.delete(id);
  lastPicked = id;
  syncPicked();
}
// Bring the highlight and tick boxes of every drawn row in line with `picked` (no rows are rebuilt).
function syncPicked() {
  for (const li of document.querySelectorAll("#list > li")) {
    const yes = picked.has(Number(li.classList.contains("part") ? li.dataset.owner : li.dataset.id));
    if (li.classList.contains("picked") !== yes) li.classList.toggle("picked", yes);
    const box = li.querySelector(".rowsel");
    if (box && box.checked !== yes) box.checked = yes;
  }
  if (!$("#bulkbar").hidden) updateBulkBar();
}
function updateBulkBar() {
  const n = picked.size, all = $("#bulk-all");
  $("#bulk-count").textContent = n + " selected";
  const pool = selectableRecs();
  all.checked = n > 0 && n === pool.length;
  all.indeterminate = n > 0 && n < pool.length;
  const held = new Set(pool.filter((r) => picked.has(r.id)).flatMap((r) => r.tags));
  fillSelect($("#bulk-add"), "Add tag…", allTags);
  fillSelect($("#bulk-remove"), "Remove tag…", allTags.filter((t) => held.has(t)));       // only tags the selection has
  for (const id of ["#bulk-add", "#bulk-remove", "#bulk-mark", "#bulk-inbox", "#bulk-trash"]) $(id).disabled = n === 0;
  $("#bulk-group").disabled = n < 2;
  // groups of two or more recordings the selection could be added to (not ones that are themselves selected)
  const targets = [...inboxRecs, ...libRecs].filter((r) => r.parts.length > 1 && !picked.has(r.id));
  const want = ["", ...targets.map((r) => r.gid + "\t" + r.title)].join("\n");
  const addTo = $("#bulk-addto");
  if (addTo.dataset.opts !== want) {
    addTo.dataset.opts = want;
    addTo.replaceChildren(el("option", { value: "" }, "Add to group…"), ...targets.map((r) => el("option", { value: String(r.gid) }, r.title)));
  }
  addTo.disabled = n === 0 || !targets.length;
  if (!n) disarmTrash();
}
function fillSelect(select, placeholder, names) {
  const keep = [...select.options].slice(1).map((o) => o.value).join("\n");
  if (keep === names.join("\n")) return;
  select.replaceChildren(el("option", { value: "" }, placeholder), ...names.map((t) => el("option", { value: t }, t)));
}
// Turning Select mode on or off, and Select all, only change classes and tick marks on the rows already drawn.
function setSelecting(on) {
  selecting = on; picked.clear(); lastPicked = null;
  const canSelect = view === "library" || view === "inbox";
  $("#results").classList.toggle("selecting", canSelect && selecting);
  $("#select-toggle").setAttribute("aria-pressed", String(selecting));
  $("#bulkbar").hidden = !(canSelect && selecting);
  syncPicked();
}
$("#select-toggle").addEventListener("click", () => setSelecting(!selecting));
$("#bulk-done").addEventListener("click", () => setSelecting(false));
$("#bulk-all").addEventListener("change", (e) => {
  picked.clear();
  if (e.target.checked) for (const r of selectableRecs()) picked.add(r.id);
  syncPicked();
});
const gidsPicked = () => [...picked].map((id) => gidOf.get(id) ?? id);
async function afterChange() { picked.clear(); lastPicked = null; openEditId = null; await loadList(); }
async function bulk(changes, done) {
  const ids = gidsPicked();
  if (!ids.length) return;
  if (!(await ask("bulk", "POST", { ids, changes }, "change them"))) return;
  await afterChange();
  notify(done(ids.length));
}
$("#bulk-addto").addEventListener("change", async (e) => {
  const target = e.target.value;
  e.target.value = "";
  if (!target || picked.size < 1) return;
  const ids = gidsPicked();
  const body = await ask("groups/" + target + "/parts", "POST", { ids }, "add them");
  if (!body) return;
  await afterChange();
  notify("Added " + nRecordings(ids.length) + " to “" + body.group.title + "”.");
});
// Group… is one click: the recordings are combined at once, and anything they disagree on (tempo, key) is kept
// to be picked later in Edit. A group goes to the Inbox if any of its recordings is there.
$("#bulk-group").addEventListener("click", async () => {
  const ids = gidsPicked();
  if (ids.length < 2) return;
  $("#bulk-group").disabled = true;
  const body = await ask("groups", "POST", { ids }, "group them");
  if (!body) { updateBulkBar(); return; }
  const made = body.group;
  await afterChange();
  const open = made.unresolved ? Object.keys(made.unresolved).map((k) => (k === "bpm" ? "tempo" : "key")).join(" and ") : "";
  notify("Grouped " + nRecordings(ids.length) + " as “" + made.title + "”." + (open ? " They disagree on " + open + "; pick one in Edit when you are ready." : ""));
});
const nRecordings = (n) => n + (n === 1 ? " recording" : " recordings");
for (const [id, key, verb] of [["#bulk-add", "add_tags", "Added tag"], ["#bulk-remove", "remove_tags", "Removed tag"]]) {
  $(id).addEventListener("change", (e) => {
    const tag = e.target.value;
    e.target.value = "";
    if (tag) bulk({ [key]: [tag] }, (n) => verb + " “" + tag + "” on " + nRecordings(n) + ".");
  });
}
$("#bulk-mark").addEventListener("change", (e) => {
  const v = e.target.value;
  e.target.value = "";
  if (v) bulk({ rating: v === "none" ? null : v }, (n) => (v === "none" ? "Cleared the mark on " + nRecordings(n) + "." : "Marked " + nRecordings(n) + " " + { heart: "♥", check: "✓", x: "✗" }[v] + "."));
});
$("#bulk-inbox").addEventListener("click", () => bulk({ status: "inbox" }, (n) => "Moved " + nRecordings(n) + " back to the Inbox."));
let trashArmed = null;                                   // two presses, like Delete in the form: the first only asks
function disarmTrash() { clearTimeout(trashArmed); trashArmed = null; $("#bulk-trash").textContent = "Move to Trash"; }
$("#bulk-trash").addEventListener("click", () => {
  if (!trashArmed) {
    $("#bulk-trash").textContent = "Press again to trash " + picked.size;
    trashArmed = setTimeout(disarmTrash, 4000);
    return;
  }
  disarmTrash();
  bulk({ trash: true }, (n) => "Moved " + nRecordings(n) + " to the Trash. The Trash tab can restore them.");
});

// ---- Random: a different recording from the list on screen each time ------------------------------------
$("#random").addEventListener("click", () => {
  const pool = view === "inbox" ? inboxRecs : libRecs;
  if (!pool.length) { notify("Nothing to pick from: the list is empty."); return; }
  const choices = pool.length > 1 ? pool.filter((r) => !r.parts.some((p) => p.id === playingId)) : pool;     // never the idea already playing
  const rec = choices[Math.floor(Math.random() * choices.length)];
  closeAutoOpenedExcept(rec);
  setSelected(rec.id);
  startPlay(rec, rec.parts[0]);
  notify("Playing “" + rec.title + "”" + (view === "library" && filtersActive() ? " (picked from the filtered list)." : "."));
});

// ---- Themes: "standard" or "minimal" (static/theme.js applies the saved one before the first paint) ----------------
// Two separate choices: the style ("standard" or "minimal": the shapes and amount of decoration) and the colours ("auto" follows
// the device, or "light" / "dark" always). More styles and colour sets can be added next to these.
const STYLES = ["standard", "minimal"], COLORS = ["auto", "light", "dark"];
function applyTheme(name) {
  if (name === "minimal") document.documentElement.dataset.theme = "minimal"; else { delete document.documentElement.dataset.theme; name = "standard"; }
  stored.set("theme", name);
  for (const t of STYLES) $("#theme-" + t).setAttribute("aria-pressed", String(t === name));
  colorCache = null;                                                     // the waveform picks its colours up from the theme
  drawWave();
}
function applyColors(name) {
  if (name === "light" || name === "dark") document.documentElement.dataset.colors = name; else { delete document.documentElement.dataset.colors; name = "auto"; }
  stored.set("colors", name);
  for (const c of COLORS) $("#colors-" + c).setAttribute("aria-pressed", String(c === name));
  colorCache = null;
  drawWave();
}
for (const t of STYLES) $("#theme-" + t).addEventListener("click", () => applyTheme(t));
for (const c of COLORS) $("#colors-" + c).addEventListener("click", () => applyColors(c));
for (const t of STYLES) $("#theme-" + t).setAttribute("aria-pressed", String((document.documentElement.dataset.theme || "standard") === t));
for (const c of COLORS) $("#colors-" + c).setAttribute("aria-pressed", String((document.documentElement.dataset.colors || "auto") === c));

// ---- The header menu ---------------------------------------------------------------------------------------
const menuBtn = $("#menu-btn"), menu = $("#menu");
function setMenu(open) { menu.hidden = !open; menuBtn.setAttribute("aria-expanded", String(open)); }
menuBtn.addEventListener("click", () => setMenu(menu.hidden));
menu.addEventListener("click", () => setMenu(false));                                         // choosing anything closes it
document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest("#menu-wrap")) setMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); menuBtn.focus(); } });

// ---- marks: ♥ interesting, ✓ used in a song, ✗ no longer interesting ---------------------------------
const MARKS = [["heart", "♥", "Interesting"], ["check", "✓", "Used in a song"], ["x", "✗", "No longer interesting"]];

async function setMark(rec, value) {
  const body = await ask("groups/" + rec.gid, "PATCH", { rating: value }, "save that mark");
  if (!body) return;
  const saved = body.group;
  rec.rating = saved.rating; rec.used_in = saved.used_in;
  for (const li of document.querySelectorAll('#list > li[data-id="' + rec.id + '"] .side .ratebtn')) {
    li.setAttribute("aria-pressed", String(li.dataset.rating === rec.rating));     // update in place: keeps any open form
  }
  await loadList();      // a mark can change what a filter shows (✗ leaves "All"); this refreshes lists and counts
}

// ---- moving through the list with the keyboard -----------------------------------------------------
// Click a row (or Tab to the list), then Up/Down move the highlight and, with "play as I move" on,
// play each recording as you land on it, like auditioning samples. Space plays or pauses the
// highlighted one. Keys typed in a form field are never taken over.
const listEl = $("#list");
const recById = (id) => [...inboxRecs, ...libRecs, ...resurfaceRecs].find((r) => r.id === id);

// An idea opened by arrowing closes when the highlight moves to another idea.
function closeAutoOpenedExcept(keep) {
  for (const gid of [...autoOpened]) {
    if (keep && keep.gid === gid) continue;
    autoOpened.delete(gid);
    const rec = [...inboxRecs, ...libRecs, ...resurfaceRecs].find((r) => r.gid === gid);
    const li = rec && rowFor(rec);
    if (li) showParts(rec, li, false);
  }
}

function previewIfWanted(id, part) {
  const rec = recById(id);
  closeAutoOpenedExcept(rec);
  setSelected(id, part ? part.id : null);
  if (autoPreview && rec) startPlay(rec, part || (rec.parts.length > 1 ? rec.parts[0] : undefined));
}

const shownRecs = () => (view === "library" ? libRecs : view === "resurface" ? resurfaceRecs : view === "inbox" ? inboxRecs : []);

// What the arrow keys visit: one stop for an idea of one recording and for each part of an open idea. A closed idea is
// entered through its first part (going down) or its last (going up), which opens it.
function stopsOf(rec) {
  if (rec.parts.length < 2) return [{ rec, part: null }];
  if (isOpen(rec)) return rec.parts.map((part) => ({ rec, part }));
  return [{ rec, part: null, closed: true }];
}

function moveCursor(dir) {
  const flat = shownRecs().flatMap(stopsOf);
  if (!flat.length) return;
  let target;
  const at = flat.findIndex((st) => st.rec.id === selectedId && (st.part ? st.part.id === selectedPart : selectedPart === null));
  if (at >= 0) target = at + dir;
  else {
    const first = flat.findIndex((st) => st.rec.id === selectedId);          // the idea's own row is highlighted: its parts are next
    target = first < 0 ? 0 : dir > 0 ? first : first - 1;
  }
  target = Math.min(flat.length - 1, Math.max(0, target));
  const st = flat[target];
  let part = st.part;
  if (st.closed) {                                                           // arrive on a closed idea: open it, enter by its first or last part
    autoOpened.add(st.rec.gid);
    closeAutoOpenedExcept(st.rec);
    const li = rowFor(st.rec);
    if (li) showParts(st.rec, li, true);
    part = dir > 0 ? st.rec.parts[0] : st.rec.parts[st.rec.parts.length - 1];
  }
  previewIfWanted(st.rec.id, part);
}

listEl.addEventListener("click", (e) => {
  if (e.target.closest("button, a, form, input, select, textarea, label")) return;
  const li = e.target.closest("#list > li");
  if (!li) return;
  listEl.focus({ preventScroll: true });
  if (li.classList.contains("part")) {                                 // a recording inside an idea
    const owner = [...inboxRecs, ...libRecs, ...resurfaceRecs].find((r) => r.gid === Number(li.dataset.gid));
    if (owner) previewIfWanted(owner.id, owner.parts.find((p) => p.id === Number(li.dataset.part)));
    return;
  }
  const rec = recById(Number(li.dataset.id));
  if (rec && rec.parts.length > 1 && isOpen(rec)) { closeAutoOpenedExcept(rec); setSelected(rec.id); if (autoPreview) startPlay(rec, rec.parts[0]); return; }
  previewIfWanted(Number(li.dataset.id));
});

listEl.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest("form, input, textarea, select")) return;
  const rows = shownRecs();
  if (!rows.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveCursor(e.key === "ArrowDown" ? 1 : -1);
  } else if ((e.key === "h" || e.key === "c" || e.key === "x") && selectedId !== null) {
    e.preventDefault();                                                  // h = ♥, c = ✓, x = ✗; again to remove the mark
    const rec = recById(selectedId);
    const key = { h: "heart", c: "check", x: "x" }[e.key];
    if (rec) setMark(rec, rec.rating === key ? null : key);
  } else if (e.key === " " && !e.target.closest("button, a")) {      // on a button, Space already means "press it"
    e.preventDefault();
    const rec = recById(selectedId !== null ? selectedId : rows[0].id);
    if (rec) togglePlay(rec, selectedPart !== null ? rec.parts.find((p) => p.id === selectedPart) : undefined);
  }
});

// ---- upload ------------------------------------------------------------------
function uploadOne(file, row) {
  return new Promise((resolve) => {
    const bar = row.querySelector("progress");
    const state = row.querySelector(".state");
    const fd = new FormData();
    fd.append("file", file, file.name);
    // The date recorded starts out as the date uploaded (set it in the form if you know it), so no recorded
    // date is sent. The automatic name is built from this local time, to match the time shown elsewhere.
    fd.append("title", autoTitle(new Date()));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "api/upload");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) { bar.max = e.total; bar.value = e.loaded; }
    });
    const done = (text, cls, gid) => { state.textContent = text; state.className = "state " + cls; bar.hidden = true; resolve(gid || null); };
    xhr.addEventListener("load", () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error page */ }
      if (xhr.status === 201) done("Uploaded", "ok", body.group_id);
      else if (xhr.status === 200 && body.duplicate) done("Already have it", "ok", body.group_id);
      else if (xhr.status === 401) done("Logged out. Log in again.", "bad");
      else done(body.error || "Failed (" + xhr.status + ")", "bad");
    });
    xhr.addEventListener("error", () => done("Network error", "bad"));
    xhr.send(fd);
  });
}

async function handleFiles(files) {
  const queue = $("#queue");
  const rows = [...files].map((file) => {
    const row = el("li", {},
      el("span", { class: "name" }, file.name),
      el("span", { class: "state" }, "Waiting"),
      el("progress", { value: "0", max: "1" }));
    queue.prepend(row);
    return [file, row];
  });
  const oneIdea = $("#as-one").checked && rows.length > 1;
  const made = [];
  for (const [file, row] of rows) {   // one at a time keeps memory and the 1 GB server calm
    row.querySelector(".state").textContent = "Uploading";
    const gid = await uploadOne(file, row);
    if (gid && !made.includes(gid)) made.push(gid);
  }
  $("#as-one").checked = false;
  if (oneIdea && made.length > 1) {                // "as one idea": the details start from what the uploads say (nothing yet)
    try {
      const r = await sendJson("groups", "POST", { ids: made, status: "inbox" });
      if (loggedOut(r)) return;
      notify(r.ok ? "Uploaded " + made.length + " recordings as one idea. It is in the Inbox." : "Uploaded, but could not group them. Select them in the Inbox and press Group….");
    } catch (e) { notify("Uploaded, but could not group them. Select them in the Inbox and press Group…."); }
  }
  await loadList();
}

const input = $("#file"), veil = $("#dropveil");
$("#pick").addEventListener("click", () => input.click());
input.addEventListener("change", () => { if (input.files.length) handleFiles(input.files); input.value = ""; });
// Files can be dropped anywhere on the page (a veil says so while they are over it).
let dragDepth = 0;
const hasFiles = (e) => Boolean(e.dataTransfer && [...e.dataTransfer.types].includes("Files"));
const canUpload = () => !$("#app").hidden && !$("#main-view").hidden;
window.addEventListener("dragenter", (e) => { if (!hasFiles(e) || !canUpload()) return; e.preventDefault(); dragDepth++; veil.hidden = false; });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.hidden = true; });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; veil.hidden = true;
  if (canUpload() && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
