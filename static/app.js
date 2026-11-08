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

// ---- "How this works": a private page, fetched from the server only after login ---------------
// (It describes the server setup, so it is not part of the public page files.) Reached through
// the link in the header; the address gets "#how", so the browser's Back button works.
async function route() {
  const how = location.hash === "#how";
  $("#how-view").hidden = !how;
  $("#main-view").hidden = how;
  if (!how) return;
  window.scrollTo(0, 0);
  const body = $("#how-body");
  try {
    const r = await api("about");
    if (r.status === 401) { show("login"); return; }
    if (r.ok) body.innerHTML = await r.text();      // our own file from our own server, never user input
    else body.textContent = "Could not load this page (error " + r.status + ").";
  } catch (e) {
    body.textContent = "Could not reach the server. Check your connection and try again.";
  }
}
window.addEventListener("hashchange", route);

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  let r;
  try {
    r = await api("login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: $("#pass").value }),
    });
  } catch (e) {
    err.textContent = "Could not reach the server. Check your connection and try again.";
    err.hidden = false;
    return;
  }
  if (r.ok) { $("#pass").value = ""; boot(); }
  else if (r.status === 429) {
    const secs = Number(r.headers.get("Retry-After")) || 900;
    err.textContent = "Too many wrong attempts. Try again in about " + Math.ceil(secs / 60) + " minutes.";
    err.hidden = false;
  } else { err.textContent = "Wrong passphrase."; err.hidden = false; }
});

$("#logout").addEventListener("click", async () => {
  player.pause();
  await api("logout", { method: "POST" });
  history.replaceState(null, "", location.pathname + location.search);   // leave "#how" behind
  show("login");
});

// ---- list + playback -------------------------------------------------------
const player = $("#player");
let playingId = null;

function fmtSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// Dates. Every recording has a date uploaded and a date recorded. The date recorded starts out as the date
// uploaded; entering a date in the form sets it (stored as local noon on that day, so it can never slip to
// the neighbouring day), and clearing the box puts it back to the upload date.
const dayKey = (iso) => {                         // the local calendar day, "2026-03-01"
  const d = new Date(iso);
  return isNaN(d) ? "" : d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString([], { dateStyle: "medium" }); };
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
    const on = Number(li.dataset.id) === playingId && !player.paused;
    li.classList.toggle("playing", Number(li.dataset.id) === playingId);
    li.querySelector(".play").textContent = on ? "❚❚" : "▶";
    li.querySelector(".play").setAttribute("aria-label", (on ? "Pause " : "Play ") + li.dataset.title);
  }
}

let playStatus = new Map();    // recording id -> play_status from the latest list ("pending", "failed", ...)

// Start `rec` from the beginning (or, if it is already the loaded recording, make sure it is playing).
function startPlay(rec) {
  $("#audio-error").hidden = true;
  // After an error, starting again reloads the source (a FLAC play copy may be ready by now).
  if (playingId === rec.id && !player.error) {
    if (player.paused) player.play().catch(() => {});
    return;
  }
  playingId = rec.id;
  player.src = "api/play/" + rec.id;     // the FLAC play copy if there is one, else the original
  loadTransport(rec);
  player.play().catch(() => {});
  markPlaying();
}

function togglePlay(rec) {
  setSelected(rec.id);
  if (playingId === rec.id && !player.error && !player.paused) { player.pause(); return; }
  startPlay(rec);
}

// Highlight a row (the one the arrow keys move from, and Space plays).
function setSelected(id) {
  selectedId = id;
  for (const li of document.querySelectorAll("#list > li")) {
    const on = Number(li.dataset.id) === id;
    li.classList.toggle("selected", on);
    if (on) { li.setAttribute("aria-current", "true"); li.scrollIntoView({ block: "nearest" }); }
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
    if (r.status === 401) { show("login"); return; }
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
    text = "Could not reach the server. Check your connection and try again.";
  }
  if (playingId !== id) return;                            // user already moved on to another recording
  msg.textContent = text;
  msg.hidden = false;
});

// ---- inbox / library, details, and the intake form -------------------------------------------
// Uploads land in the Inbox. Saving the form (even completely empty) moves a recording to the Library.
const KEY_ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
let view = "inbox";            // which list is showing: "inbox" | "library" | "trash"
let trashRecs = [];            // recordings moved to the Trash (only fetched while that tab is open)
let trashCount = 0;
let inboxRecs = [];            // everything not yet saved to the Library
let libRecs = [];              // Library recordings matching the current filters (the server does the filtering)
let libTotal = 0;              // Library size before any filter
let libRatings = { heart: 0, check: 0, x: 0, none: 0 };   // how many Library recordings carry each mark
let allTags = [];
let openEditId = null;         // at most one edit form open at a time
let selectedId = null;         // the highlighted row; arrow keys move it, Space plays it
let pollTimer = null;
let loadSeq = 0;               // numbers each load so a slow, older response can't overwrite a newer one

// What the Library sidebar is asking for. Sort and the preview switch are remembered between visits
// (a per-device convenience only: everything still works if the browser refuses to store them).
const filters = { q: "", tags: [], match: "all", bpm_min: null, bpm_max: null, key_root: "", key_mode: "", rating: "all",
                  sort: "recorded", order: "desc" };
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
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function detailsText(rec) {
  const parts = [];
  if (rec.bpm) parts.push(rec.bpm + " BPM");
  if (rec.key_root || rec.key_mode) parts.push([rec.key_root, rec.key_mode].filter(Boolean).join(" "));
  if (rec.rating === "check" && rec.used_in) parts.push("used in " + rec.used_in);
  return parts.join(" · ");
}

function notify(text) {
  const n = $("#notice");
  n.textContent = text;
  n.hidden = !text;
}

function setView(next) {
  if (triage) exitTriage();
  view = next;
  openEditId = null;
  notify("");
  render();
}
$("#tab-inbox").addEventListener("click", () => setView("inbox"));
$("#tab-library").addEventListener("click", () => setView("library"));
$("#tab-trash").addEventListener("click", () => { setView("trash"); loadList(); });

function updateTabs() {
  const inbox = inboxRecs.length;
  $("#tab-inbox").textContent = "Inbox" + (inbox ? " (" + inbox + ")" : "");
  $("#tab-library").textContent = "Library" + (libTotal ? " (" + libTotal + ")" : "");
  $("#tab-trash").hidden = !trashCount && view !== "trash";
  $("#tab-trash").textContent = "Trash" + (trashCount ? " (" + trashCount + ")" : "");
  $("#tab-trash").setAttribute("aria-pressed", String(view === "trash"));
  $("#tab-inbox").setAttribute("aria-pressed", String(view === "inbox"));
  $("#tab-library").setAttribute("aria-pressed", String(view === "library"));
}

const bpmActive = () => filters.bpm_min !== null || filters.bpm_max !== null;
const filtersActive = () => Boolean(filters.q.trim() || filters.tags.length || bpmActive() ||
                                    filters.key_root || filters.key_mode || filters.rating !== "all");

function render() {
  updateTabs();
  const inLibrary = view === "library";
  const shown = inLibrary ? libRecs : view === "trash" ? trashRecs : inboxRecs;
  const ul = $("#list");
  ul.replaceChildren();
  ul.classList.toggle("library", inLibrary);
  $("#app").classList.toggle("wide", inLibrary);           // the Library table gets more room
  $("#filters").hidden = !inLibrary;
  $("#browser").classList.toggle("with-filters", inLibrary);
  $("#colhead").hidden = !inLibrary || !shown.length;
  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = (inboxRecs.length + libTotal) === 0 ? "Nothing yet. Upload a voice memo above."
      : view === "trash" ? "The Trash is empty."
      : !inLibrary ? "Nothing waiting to be tagged. Switch to Library to browse what you've saved."
      : libTotal === 0 ? "Nothing in the Library yet. Open a recording in the Inbox and save it, and it moves here."
      : "No recordings match these filters. Use Clear filters to start over.";
  }
  $("#kbd-hint").hidden = !shown.length;
  $("#triage-start").hidden = !(view === "inbox" && inboxRecs.length && !triage);
  $("#triage-start").textContent = "Triage the Inbox (" + inboxRecs.length + ")";
  $("#count").textContent = shown.length ? "(" + shown.length + ")" : "";
  if (inLibrary) updateFilterUI();
  playStatus = new Map([...inboxRecs, ...libRecs].map((rec) => [rec.id, rec.play_status]));
  if (selectedId !== null && !shown.some((r) => r.id === selectedId)) selectedId = null;   // filtered out
  for (const rec of shown) ul.append(view === "trash" ? buildTrashRow(rec) : buildRow(rec));
  markPlaying();
}

function buildRow(rec) {
  const btn = el("button", { class: "play", type: "button" }, "▶");
  btn.addEventListener("click", () => togglePlay(rec));
  const meta = el("div", { class: "meta when" }, whenText(rec) +
    (rec.duration_s ? " · " + fmtTime(rec.duration_s) : "") + " · " + fmtSize(rec.size));
  if (rec.play_status === "pending") meta.append(el("span", { class: "chip" }, "preparing playback…"));
  if (rec.play_status === "failed") meta.append(el("span", { class: "chip" }, "no play copy"));
  const info = el("div", { class: "info" }, el("div", { class: "title" }, rec.title), meta);
  const details = detailsText(rec);
  if (details) info.append(el("div", { class: "meta details" }, details));
  if (rec.tags.length) {
    const tags = el("div", { class: "tags" });
    for (const t of rec.tags) tags.append(el("span", { class: "chip tag" }, t));
    info.append(tags);
  }
  if (rec.notes) info.append(el("div", { class: "meta notes" }, rec.notes));
  const edit = el("button", { class: "link edit-btn", type: "button", "aria-expanded": String(openEditId === rec.id) },
    rec.status === "inbox" ? "Tag" : "Edit");
  edit.addEventListener("click", () => {
    openEditId = openEditId === rec.id ? null : rec.id;
    notify("");
    render();
    if (openEditId !== null) {
      const first = document.querySelector("#list form.edit input");
      // put the cursor in the Title box, except on a touch screen, where that would throw the keyboard up at once
      if (first && !window.matchMedia("(pointer: coarse)").matches) first.focus();
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
    el("a", { class: "dl", href: "api/audio/" + rec.id + "?download=1" }, "Download"), rate);
  const li = el("li", { "data-id": String(rec.id), "data-title": rec.title }, btn, info, side);
  if (rec.id === selectedId) { li.classList.add("selected"); li.setAttribute("aria-current", "true"); }
  if (openEditId === rec.id) li.append(buildForm(rec));
  return li;
}

// A recording in the Trash: it can't be played or edited, only brought back.
function buildTrashRow(rec) {
  const restore = el("button", { class: "link restore-btn", type: "button" }, "Restore");
  restore.addEventListener("click", async () => {
    restore.disabled = true;
    try {
      const r = await api("recordings/" + rec.id + "/restore", { method: "POST" });
      if (r.status === 401) { show("login"); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        notify(body.error || "Could not restore it (error " + r.status + ").");
        restore.disabled = false;
        return;
      }
      await loadList();
      notify("Restored to the " + (rec.status === "inbox" ? "Inbox" : "Library") + ".");
    } catch (e) { notify("Could not reach the server. Check your connection and try again."); restore.disabled = false; }
  });
  const meta = el("div", { class: "meta when" }, "Deleted " + fmtDay(rec.deleted_at) + " · " + fmtSize(rec.size));
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
    const r = await api("tags", { method: "POST", headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ name: newTag.value }) });
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

  // key
  const root = el("select", { id: "f-root-" + id });
  root.append(el("option", { value: "" }, "—"));
  for (const k of KEY_ROOTS) root.append(el("option", { value: k }, k));
  root.value = rec.key_root || "";
  const mode = el("select", { id: "f-mode-" + id });
  mode.append(el("option", { value: "" }, "—"), el("option", { value: "major" }, "major"), el("option", { value: "minor" }, "minor"));
  mode.value = rec.key_mode || "";
  form.append(el("div", { class: "keyrow" }, field("Key", root, "f-root-" + id), field("Major / minor", mode, "f-mode-" + id)));

  // date recorded: blank means "same as the date uploaded"
  const initialDate = dateIsSet(rec) ? dayKey(rec.recorded_at) : "";
  const dateInput = el("input", { id: "f-date-" + id, type: "date", value: initialDate, max: dayKey(new Date().toISOString()) });
  form.append(el("div", { class: "field" }, el("label", { for: "f-date-" + id }, "Date recorded (optional)"), dateInput,
    el("div", { class: "meta" }, "Leave it blank to use the date it was uploaded (" + fmtDay(rec.uploaded_at) + ").")));

  const notes = el("textarea", { id: "f-notes-" + id, rows: "3", maxlength: "5000" });
  notes.value = rec.notes || "";
  form.append(field("Notes", notes, "f-notes-" + id));

  const err = el("p", { class: "error", role: "alert", hidden: "" });
  const save = el("button", { type: "submit", class: "primary" }, rec.status === "inbox" ? "Save and move to Library" : "Save");
  const cancel = el("button", { type: "button" }, "Cancel");
  cancel.addEventListener("click", () => { openEditId = null; notify(""); render(); });
  const actions = el("div", { class: "actions" }, save, cancel);
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
      const r = await api("recordings/" + id, { method: "DELETE" });
      if (r.status === 401) { show("login"); return; }
      if (!r.ok) { err.textContent = "Could not delete (error " + r.status + ")."; err.hidden = false; del.textContent = "Delete"; return; }
    } catch (e) { err.textContent = "Could not reach the server."; err.hidden = false; del.textContent = "Delete"; return; }
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
    if (dateChanged) payload.recorded_at = dateInput.value ? localNoon(dateInput.value) : null;   // null = use the upload date
    const r = await api("recordings/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify(payload) });
    if (r.status === 401) { show("login"); return; }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      err.textContent = body.error || "Could not save (error " + r.status + ").";
      err.hidden = false;
      return;
    }
    openEditId = null;
    await loadList();
    notify(status === "inbox" ? "Moved back to Inbox." : rec.status === "inbox" ? "Saved. Moved to Library." : "Saved.");
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); submit("tagged"); });
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
  // "All" leaves out the ones marked ✗ (no longer interesting); pick ✗ to see them
  p.set("rating", filters.rating === "all" ? "heart,check,none" : filters.rating);
  return p.toString();
}

async function loadList() {
  clearTimeout(pollTimer);
  const seq = ++loadSeq;
  let inbox, lib, tags, trash;
  try {
    [inbox, lib, tags, trash] = await Promise.all([
      api("recordings?status=inbox"), api("recordings?" + libraryQuery()), api("tags"),
      view === "trash" ? api("trash") : Promise.resolve(null)]);
  } catch (e) {
    if (seq === loadSeq) { notify("Could not reach the server. Check your connection and try again."); schedulePoll(); }
    return;
  }
  if (inbox.status === 401 || lib.status === 401) { if (seq === loadSeq) show("login"); return; }
  if (!inbox.ok || !lib.ok) { notify("Could not load your recordings (error " + (lib.ok ? inbox.status : lib.status) + ")."); return; }
  const [inboxBody, libBody] = await Promise.all([inbox.json(), lib.json()]);
  if (seq !== loadSeq) return;                // a newer load is already on its way; this answer is stale
  inboxRecs = inboxBody.recordings;
  libRecs = libBody.recordings;
  libTotal = libBody.total;
  libRatings = libBody.ratings;
  trashCount = inboxBody.trashed;
  if (trash && trash.ok) trashRecs = (await trash.json()).recordings;
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

// ---- transport bar: waveform, scrubbing, speed, loop, download --------------------------------------
// The waveform and length are measured once on the server (ffmpeg) when a recording is uploaded, so
// nothing heavy is decoded on a phone. Without them the bar still works: it just shows a plain line.
const wave = $("#wave");
const wctx = wave.getContext("2d");
const SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"];
let current = null;            // the recording loaded in the player
let peaks = null;              // waveform: numbers 0-255; [] = could not be measured; null = not known (yet)
let knownDuration = 0;         // seconds, from the server's measurement
let loopA = null, loopB = null, loopOn = false;
let pendingSeek = null;        // a seek asked for before the file's length was known
let reported = false;          // has this listen been counted as "played" yet?
let rafId = 0;

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(r).padStart(2, "0");
}
const totalTime = () => (Number.isFinite(player.duration) && player.duration > 0) ? player.duration : knownDuration;

// speed (pitch stays put when you slow down or speed up)
for (const v of SPEEDS) $("#pb-speed").append(el("option", { value: v }, v + "×"));
let speed = SPEEDS.includes(stored.get("speed")) ? stored.get("speed") : "1";
$("#pb-speed").value = speed;
function applySpeed() {
  player.defaultPlaybackRate = Number(speed);
  player.playbackRate = Number(speed);
  for (const k of ["preservesPitch", "mozPreservesPitch", "webkitPreservesPitch"]) if (k in player) player[k] = true;
}
$("#pb-speed").addEventListener("change", (e) => { speed = e.target.value; stored.set("speed", speed); applySpeed(); });
applySpeed();

function loadTransport(rec) {
  current = rec;
  lastTimeText = "";
  peaks = null;
  knownDuration = rec.duration_s || 0;
  loopA = loopB = null; loopOn = false; pendingSeek = null; reported = false;
  player.loop = false;
  $("#pb-title").textContent = rec.title;
  const dl = $("#pb-dl");
  dl.href = "api/audio/" + rec.id + "?download=1";
  dl.hidden = false;
  $("#pb-play").disabled = false;
  applySpeed();                    // a new source resets the rate in some browsers
  syncLoopUI(); updateTime(); drawWave();
  loadAnalysis(rec, 0);
}

async function loadAnalysis(rec, attempt) {
  try {
    const r = await api("recordings/" + rec.id + "/analysis");
    if (!r.ok || !current || current.id !== rec.id) return;
    const body = await r.json();
    if (body.duration_s) knownDuration = body.duration_s;
    if (body.peaks === null) {                   // not measured yet (just uploaded): look again shortly
      if (attempt < 8) setTimeout(() => { if (current && current.id === rec.id && peaks === null) loadAnalysis(rec, attempt + 1); }, 4000);
      return;
    }
    peaks = body.peaks;
    updateTime(); drawWave();
  } catch (e) { /* offline: the plain line is fine */ }
}

let lastTimeText = "";
function updateTime() {       // runs every animation frame while playing: only touch the page when the text changes
  const total = totalTime();
  const text = fmtTime(player.currentTime) + " / " + fmtTime(total);
  if (text === lastTimeText && current) return;
  lastTimeText = text;
  $("#pb-time").textContent = text;
  wave.setAttribute("aria-valuemax", String(Math.round(total)));
  wave.setAttribute("aria-valuenow", String(Math.round(player.currentTime)));
  wave.setAttribute("aria-valuetext", current ? fmtTime(player.currentTime) + " of " + fmtTime(total) : "Nothing playing");
}

let colorCache = null;       // reading computed styles every frame is wasteful; the colours only change with the theme
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colorCache = null; drawWave(); });
function waveColors() {
  if (!colorCache) {
    const css = getComputedStyle(document.documentElement);
    colorCache = { accent: css.getPropertyValue("--accent").trim() || "#d9480f", muted: css.getPropertyValue("--muted").trim() || "#888" };
  }
  return colorCache;
}

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w || !h) return;
  if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(h * dpr)) {
    wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr);
  }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  const { accent, muted } = waveColors();
  const total = totalTime();
  const progress = total > 0 ? Math.min(1, player.currentTime / total) : 0;

  if (peaks && peaks.length) {
    const n = peaks.length, barW = w / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, Math.pow(peaks[i] / 255, 0.75) * (h - 10));
      wctx.fillStyle = (i + 0.5) / n <= progress ? accent : muted;
      wctx.globalAlpha = (i + 0.5) / n <= progress ? 1 : 0.55;
      wctx.fillRect(i * barW + 0.5, (h - bh) / 2, Math.max(1, barW - 1), bh);
    }
  } else {                                        // not measured: a plain line, filled up to the playhead
    wctx.globalAlpha = 0.55; wctx.fillStyle = muted; wctx.fillRect(0, h / 2 - 1, w, 2);
    wctx.globalAlpha = 1; wctx.fillStyle = accent; wctx.fillRect(0, h / 2 - 1, w * progress, 2);
  }
  wctx.globalAlpha = 1;

  if (loopA !== null && total > 0) {              // the A–B section
    const a = (loopA / total) * w, b = (loopB !== null ? loopB / total : loopA / total) * w;
    wctx.fillStyle = accent;
    if (loopB !== null) { wctx.globalAlpha = loopOn ? 0.22 : 0.1; wctx.fillRect(a, 0, b - a, h); }
    wctx.globalAlpha = 1;
    wctx.fillRect(a - 1, 0, 2, h);
    if (loopB !== null) wctx.fillRect(b - 1, 0, 2, h);
  }
  if (current && total > 0) { wctx.fillStyle = accent; wctx.fillRect(progress * w - 1, 0, 2, h); }   // playhead
}

function syncLoopUI() {
  player.loop = loopOn && (loopA === null || loopB === null);     // no section set: repeat the whole recording
  $("#pb-loop").setAttribute("aria-pressed", String(loopOn));
  $("#pb-a").classList.toggle("set", loopA !== null);
  $("#pb-b").classList.toggle("set", loopB !== null);
  $("#pb-clear").disabled = loopA === null && loopB === null && !loopOn;
  drawWave();
}

function enforceLoop() {
  if (loopOn && loopA !== null && loopB !== null && player.currentTime >= loopB) player.currentTime = loopA;
}

function seekTo(seconds) {
  const total = totalTime();
  const t = Math.min(Math.max(0, seconds), total > 0 ? total : seconds);
  if (player.readyState === 0) pendingSeek = t;     // length not loaded yet: apply it when it is
  else player.currentTime = t;
  updateTime(); drawWave();
}

// animation loop while playing: smooth playhead and an accurate loop point (timeupdate is too coarse)
function tick() {
  rafId = 0;
  enforceLoop(); updateTime(); drawWave();
  if (!player.paused && !player.ended) rafId = requestAnimationFrame(tick);
}
const startTicking = () => { if (!rafId) rafId = requestAnimationFrame(tick); };

player.addEventListener("loadedmetadata", () => {
  if (pendingSeek !== null) { player.currentTime = pendingSeek; pendingSeek = null; }
  updateTime(); drawWave();
});
player.addEventListener("play", () => { $("#pb-play").textContent = "❚❚"; $("#pb-play").setAttribute("aria-label", "Pause"); startTicking(); });
for (const ev of ["pause", "ended", "error"]) {
  player.addEventListener(ev, () => { $("#pb-play").textContent = "▶"; $("#pb-play").setAttribute("aria-label", "Play"); updateTime(); drawWave(); });
}
player.addEventListener("ended", () => {          // a section that runs to the very end still repeats
  if (loopOn && loopA !== null && loopB !== null) { player.currentTime = loopA; player.play().catch(() => {}); }
});
player.addEventListener("timeupdate", () => {
  enforceLoop(); updateTime();
  // count it as "played" only once it has really been listened to, not skipped past while browsing
  if (!reported && current && player.currentTime >= Math.min(5, (totalTime() || 10) * 0.5)) {
    reported = true;
    api("recordings/" + current.id + "/played", { method: "POST" }).catch(() => {});
  }
});

$("#pb-play").addEventListener("click", () => {
  if (!current) return;
  if (player.error) { startPlay(current); return; }
  if (player.paused) player.play().catch(() => {}); else player.pause();
});

// click or drag on the waveform to scrub; Shift + drag selects a loop section (touch: use the A and B buttons)
let drag = null;
const fractionAt = (e) => { const r = wave.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
wave.addEventListener("pointerdown", (e) => {
  if (!current || !totalTime()) return;
  wave.setPointerCapture(e.pointerId);
  wave.focus({ preventScroll: true });
  drag = { select: e.shiftKey, start: fractionAt(e), moved: false };
  if (!drag.select) seekTo(drag.start * totalTime());
});
wave.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const f = fractionAt(e), total = totalTime();
  if (Math.abs(f - drag.start) > 0.004) drag.moved = true;
  if (drag.select) { loopA = Math.min(drag.start, f) * total; loopB = Math.max(drag.start, f) * total; drawWave(); }
  else seekTo(f * total);
});
const endDrag = () => {
  if (drag && drag.select) {
    if (drag.moved && loopB !== null && loopB - loopA >= 0.5) loopOn = true; else { loopA = loopB = null; }
    syncLoopUI();
  }
  drag = null;
};
wave.addEventListener("pointerup", endDrag);
wave.addEventListener("pointercancel", () => { drag = null; });

wave.addEventListener("keydown", (e) => {
  if (!current || e.altKey || e.ctrlKey || e.metaKey) return;
  const total = totalTime();
  const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[e.key];
  if (step !== undefined) { e.preventDefault(); seekTo(player.currentTime + step); }
  else if (e.key === "Home") { e.preventDefault(); seekTo(0); }
  else if (e.key === "End") { e.preventDefault(); seekTo(total); }
  else if (e.key === " ") { e.preventDefault(); $("#pb-play").click(); }
  else if (e.key === "[") { e.preventDefault(); $("#pb-a").click(); }
  else if (e.key === "]") { e.preventDefault(); $("#pb-b").click(); }
});

$("#pb-a").addEventListener("click", () => {
  if (!current) return;
  loopA = player.currentTime;
  if (loopB !== null && loopB <= loopA) loopB = null;
  if (loopB !== null) loopOn = true;
  syncLoopUI();
});
$("#pb-b").addEventListener("click", () => {
  if (!current) return;
  const t = player.currentTime;
  if (loopA === null) loopA = 0;
  if (t <= loopA) { loopB = loopA; loopA = t; } else loopB = t;
  if (loopB - loopA < 0.2) { loopB = null; syncLoopUI(); return; }   // too short to be a section
  loopOn = true;
  syncLoopUI();
});
$("#pb-loop").addEventListener("click", () => { loopOn = !loopOn; syncLoopUI(); });
$("#pb-clear").addEventListener("click", () => { loopA = loopB = null; loopOn = false; syncLoopUI(); });

new ResizeObserver(drawWave).observe(wave);

// Collapse the player to one slim row: by the button (remembered), and automatically while typing on a small or
// touch screen, so a phone keyboard doesn't leave the form with a sliver of screen.
const playerBar = $("#playerbar"), barToggle = $("#pb-toggle");
let barMini = stored.get("mini") === "1";
let typing = false;
const isTextField = (n) => Boolean(n && n.matches && !n.closest("#playerbar") &&
  n.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"])'));
const smallScreen = () => window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
function applyBar() {
  const collapsed = barMini || typing;
  playerBar.classList.toggle("mini", collapsed);
  barToggle.textContent = collapsed ? "▴" : "▾";
  barToggle.setAttribute("aria-label", collapsed ? "Expand the player" : "Collapse the player");
  barToggle.setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed) drawWave();
}
// Collapse at once when a text box gets the cursor; expand only after it has been gone for a moment and no finger or
// mouse button is down. Expanding the instant focus moved (e.g. onto a button being pressed) made the bar jump up over
// the very spot being tapped, so the tap landed on the player and the button never got its click.
let typingTimer = null, pointerDown = false;
function syncTyping() {
  const now = smallScreen() && isTextField(document.activeElement);
  if (now) {
    clearTimeout(typingTimer); typingTimer = null;
    if (!typing) { typing = true; applyBar(); }
    return;
  }
  if (!typing || typingTimer) return;
  typingTimer = setTimeout(function settle() {
    typingTimer = null;
    if (smallScreen() && isTextField(document.activeElement)) return;
    if (pointerDown) { typingTimer = setTimeout(settle, 150); return; }
    typing = false; applyBar();
  }, 300);
}
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { pointerDown = false; }, true);
barToggle.addEventListener("click", () => {
  const collapsedNow = barMini || typing;                 // collapsed for either reason: the button expands it
  if (typing && document.activeElement && document.activeElement.blur) document.activeElement.blur();   // also puts the keyboard away
  clearTimeout(typingTimer); typingTimer = null;
  typing = false;
  barMini = !collapsedNow;
  stored.set("mini", barMini ? "1" : "0");
  applyBar();
});
document.addEventListener("focusin", syncTyping);
document.addEventListener("focusout", syncTyping);
setInterval(syncTyping, 1000);                                                // safety net: a field removed while focused
applyBar();

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
  const n = [filters.q.trim(), filters.tags.length, bpmActive(), filters.key_root, filters.key_mode,
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
  const otherFilters = Boolean(filters.q.trim() || filters.tags.length || bpmActive() || filters.key_root || filters.key_mode);
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
  Object.assign(filters, { q: "", tags: [], match: "all", bpm_min: null, bpm_max: null, key_root: "", key_mode: "", rating: "all" });
  $("#f-q").value = ""; $("#f-root").value = ""; $("#f-mode").value = "";
  $("#f-match-all").checked = true;
  filtersChanged(0);
});
$("#filters-toggle").addEventListener("click", () => {
  const open = $("#filters").classList.toggle("open");
  $("#filters-toggle").setAttribute("aria-expanded", String(open));
});

// ---- marks: ♥ interesting, ✓ used in a song, ✗ no longer interesting ---------------------------------
const MARKS = [["heart", "♥", "Interesting"], ["check", "✓", "Used in a song"], ["x", "✗", "No longer interesting"]];

async function setMark(rec, value) {
  const r = await api("recordings/" + rec.id, { method: "PATCH", headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ rating: value }) });
  if (r.status === 401) { show("login"); return; }
  if (!r.ok) { notify("Could not save that mark (error " + r.status + ")."); return; }
  const saved = (await r.json()).recording;
  rec.rating = saved.rating; rec.used_in = saved.used_in;
  for (const li of document.querySelectorAll('#list > li[data-id="' + rec.id + '"] .side .ratebtn')) {
    li.setAttribute("aria-pressed", String(li.dataset.rating === rec.rating));     // update in place: keeps any open form
  }
  await loadList();      // a mark can change what a filter shows (✗ leaves "All"); this refreshes lists and counts
}

// ---- triage: work through the Inbox one recording at a time, keyboard first ---------------------
// Each card autoplays (if "play as I move" is on). Number keys toggle tags, h / c / x mark it, n or u jump to
// the notes or the song name, and Right arrow or Enter saves it to the Library and moves on; s skips it.
let triage = null;       // null, or { recs, queue, index, savedIds, skippedIds, drafts }

function startTriage() {
  if (!inboxRecs.length) return;
  triage = { recs: new Map(inboxRecs.map((r) => [r.id, r])), queue: inboxRecs.map((r) => r.id), index: 0,
             savedIds: new Set(), skippedIds: new Set(), drafts: new Map() };
  openEditId = null;
  notify("");
  $("#browser").hidden = true;
  $("#triage").hidden = false;
  $("#triage-start").hidden = true;
  renderTriage();
}

function exitTriage() {
  if (!triage) return;
  triage = null;
  $("#triage").hidden = true;
  $("#browser").hidden = false;
  player.pause();
  loadList();
}

function readCard() {            // what is on the card right now (null on the "done" screen)
  if (!$("#t-notes")) return null;
  const card = $("#triage-card");
  const mark = card.querySelector('.ratebtn[aria-pressed="true"]');
  return { tags: [...card.querySelectorAll('.tagbtn[aria-pressed="true"]')].map((b) => b.dataset.tag),
           rating: mark ? mark.dataset.rating : null, used_in: $("#t-used").value.trim(), notes: $("#t-notes").value };
}

function setCardMark(key, forceOn) {
  const buttons = [...document.querySelectorAll("#triage-card .ratebtn")];
  const current = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
  const turnOn = forceOn || !current || current.dataset.rating !== key;      // pressing the same mark again removes it
  for (const b of buttons) b.setAttribute("aria-pressed", String(turnOn && b.dataset.rating === key));
  $("#t-used-wrap").hidden = !(turnOn && key === "check");
}

function renderTriage() {
  const card = $("#triage-card");
  card.replaceChildren();
  if (triage.index >= triage.queue.length) {
    const skipped = [...triage.skippedIds].filter((id) => !triage.savedIds.has(id)).length;
    const done = el("button", { type: "button", class: "primary" }, "Back to the Inbox");
    done.addEventListener("click", exitTriage);
    $("#triage-pos").textContent = "Done";
    card.append(el("h4", {}, "That's the whole Inbox."),
      el("p", {}, "Saved " + triage.savedIds.size + (triage.savedIds.size === 1 ? " recording" : " recordings") +
                  " to the Library" + (skipped ? ", left " + skipped + " in the Inbox." : ".")), done);
    $("#triage").focus({ preventScroll: true });
    return;
  }
  const id = triage.queue[triage.index];
  const rec = triage.recs.get(id);
  const draft = triage.drafts.get(id) || { tags: rec.tags, rating: rec.rating, used_in: rec.used_in || "", notes: rec.notes || "" };
  $("#triage-pos").textContent = (triage.index + 1) + " of " + triage.queue.length;
  card.append(el("h4", {}, rec.title),
    el("div", { class: "meta" }, whenText(rec) + (rec.duration_s ? " · " + fmtTime(rec.duration_s) : "")));

  const tagBox = el("div", { class: "tagbox", role: "group", "aria-label": "Instruments and ideas (keys 1 to 9)" });
  allTags.forEach((t, i) => {
    const b = el("button", { type: "button", class: "tagbtn", "data-tag": t, "aria-pressed": String(draft.tags.includes(t)) });
    if (i < 9) b.append(el("span", { class: "key", "aria-hidden": "true" }, String(i + 1)));
    b.append(t);
    b.addEventListener("click", () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
    tagBox.append(b);
  });
  const hints = { heart: "h", check: "c", x: "x" };
  const markBox = el("div", { class: "rate", role: "group", "aria-label": "Mark this recording" });
  for (const [key, glyph, label] of MARKS) {
    const b = el("button", { type: "button", class: "ratebtn", "data-rating": key, title: label + " (" + hints[key] + ")",
                             "aria-label": label, "aria-pressed": String(draft.rating === key) }, glyph);
    b.addEventListener("click", () => setCardMark(key));
    markBox.append(b);
  }
  const used = el("input", { id: "t-used", type: "text", maxlength: "200", placeholder: "Which song? (optional)", value: draft.used_in });
  const usedWrap = el("div", { id: "t-used-wrap" }, el("label", { for: "t-used" }, "Used in (u)"), used);
  usedWrap.hidden = draft.rating !== "check";
  const notes = el("textarea", { id: "t-notes", rows: "3", maxlength: "5000" });
  notes.value = draft.notes;
  const error = el("p", { id: "t-error", class: "error", role: "alert", hidden: "" });
  const back = el("button", { type: "button" }, "← Back");
  const skip = el("button", { type: "button" }, "Skip (s)");
  const save = el("button", { type: "button", class: "primary" }, "Save and next (→)");
  back.addEventListener("click", triageBack); skip.addEventListener("click", triageSkip); save.addEventListener("click", triageSave);
  card.append(tagBox, markBox, usedWrap,
    el("div", {}, el("label", { for: "t-notes" }, "Notes (n)"), notes), error,
    el("div", { class: "actions" }, back, skip, save));
  if (autoPreview) startPlay(rec);
  $("#triage").focus({ preventScroll: true });
}

async function triageSave() {
  if (!triage || triage.saving) return;       // a held-down key or a double press must not save (and skip) twice
  const data = readCard();
  if (!data) return;
  triage.saving = true;
  const session = triage;
  try { await saveCard(data); } finally { session.saving = false; }
}

async function saveCard(data) {
  const id = triage.queue[triage.index];
  const err = $("#t-error");
  err.hidden = true;
  const session = triage;
  let r;
  try {
    r = await api("recordings/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags: data.tags, rating: data.rating, notes: data.notes, status: "tagged",
                           used_in: data.rating === "check" ? (data.used_in || null) : null }) });
  } catch (e) {
    err.textContent = "Could not reach the server. Check your connection and try again.";
    err.hidden = false;
    return;
  }
  if (session !== triage) return;               // triage was closed while this was saving
  if (r.status === 401) { show("login"); return; }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    err.textContent = body.error || "Could not save (error " + r.status + ").";
    err.hidden = false;
    return;
  }
  const saved = (await r.json()).recording;
  if (session !== triage) return;
  triage.recs.set(id, saved);
  triage.drafts.delete(id);
  triage.savedIds.add(id);
  triage.index++;
  renderTriage();
}

function triageSkip() {
  if (triage.saving) return;
  const data = readCard();
  if (!data) return;
  const id = triage.queue[triage.index];
  triage.drafts.set(id, data);
  triage.skippedIds.add(id);
  triage.index++;
  renderTriage();
}

function triageBack() {
  if (triage.saving) return;
  const data = readCard();
  if (data) triage.drafts.set(triage.queue[triage.index], data);
  triage.index = Math.max(0, triage.index - 1);
  renderTriage();
}

$("#triage-start").addEventListener("click", startTriage);
$("#triage-exit").addEventListener("click", exitTriage);

document.addEventListener("keydown", (e) => {
  if (!triage || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const target = e.target;
  if (target.closest && target.closest("input, textarea, select")) {      // typing: only Escape and Enter-in-a-box are ours
    if (e.key === "Escape") { e.preventDefault(); target.blur(); $("#triage").focus({ preventScroll: true }); }
    else if (e.key === "Enter" && target.tagName === "INPUT") { e.preventDefault(); triageSave(); }
    return;
  }
  const onControl = target.closest && target.closest("button, a");      // Space and Enter already press a focused button
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); exitTriage(); return; }
  if (!$("#t-notes")) return;                                             // the "done" screen has no card
  const rec = triage.recs.get(triage.queue[triage.index]);
  if (k >= "1" && k <= "9") {
    const b = $("#triage-card").querySelectorAll(".tagbtn")[Number(k) - 1];
    if (b) { e.preventDefault(); b.click(); }
  } else if (k === "h" || k === "c" || k === "x") { e.preventDefault(); setCardMark({ h: "heart", c: "check", x: "x" }[k]); }
  else if (k === "u") { e.preventDefault(); setCardMark("check", true); $("#t-used").focus(); }
  else if (k === "n") { e.preventDefault(); $("#t-notes").focus(); }
  else if (k === "s") { e.preventDefault(); triageSkip(); }
  else if (k === "ArrowLeft") { e.preventDefault(); triageBack(); }
  else if (k === "ArrowRight" || (k === "Enter" && !onControl)) { e.preventDefault(); triageSave(); }
  else if (k === " " && !onControl) {
    e.preventDefault();
    if (playingId === rec.id && !player.error) { if (player.paused) player.play().catch(() => {}); else player.pause(); }
    else startPlay(rec);
  }
});

// ---- moving through the list with the keyboard -----------------------------------------------------
// Click a row (or Tab to the list), then Up/Down move the highlight and, with "play as I move" on,
// play each recording as you land on it, like auditioning samples. Space plays or pauses the
// highlighted one. Keys typed in a form field are never taken over.
const listEl = $("#list");
const recById = (id) => [...inboxRecs, ...libRecs].find((r) => r.id === id);

function previewIfWanted(id) {
  setSelected(id);
  const rec = recById(id);
  if (autoPreview && rec) startPlay(rec);
}

listEl.addEventListener("click", (e) => {
  if (e.target.closest("button, a, form, input, select, textarea, label")) return;
  const li = e.target.closest("#list > li");
  if (!li) return;
  listEl.focus({ preventScroll: true });
  previewIfWanted(Number(li.dataset.id));
});

listEl.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest("form, input, textarea, select")) return;
  const rows = [...listEl.children];
  if (!rows.length) return;
  const at = rows.findIndex((li) => Number(li.dataset.id) === selectedId);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    previewIfWanted(Number(rows[next].dataset.id));
  } else if ((e.key === "h" || e.key === "c" || e.key === "x") && selectedId !== null) {
    e.preventDefault();                                                  // h = ♥, c = ✓, x = ✗; again to remove the mark
    const rec = recById(selectedId);
    const key = { h: "heart", c: "check", x: "x" }[e.key];
    if (rec) setMark(rec, rec.rating === key ? null : key);
  } else if (e.key === " " && !e.target.closest("button, a")) {      // on a button, Space already means "press it"
    e.preventDefault();
    const rec = recById(selectedId !== null ? selectedId : Number(rows[0].dataset.id));
    if (rec) togglePlay(rec);
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
    const done = (text, cls) => { state.textContent = text; state.className = "state " + cls; bar.hidden = true; resolve(); };
    xhr.addEventListener("load", () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error page */ }
      if (xhr.status === 201) done("Uploaded", "ok");
      else if (xhr.status === 200 && body.duplicate) done("Already have it", "ok");
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
  for (const [file, row] of rows) {   // one at a time keeps memory and the 1 GB server calm
    row.querySelector(".state").textContent = "Uploading";
    await uploadOne(file, row);
  }
  await loadList();
}

const drop = $("#drop"), input = $("#file");
input.addEventListener("change", () => { if (input.files.length) handleFiles(input.files); input.value = ""; });
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

boot();
