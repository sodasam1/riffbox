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
  const r = await api("login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: $("#pass").value }),
  });
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
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// The automatic name ("Idea, Nov 8 3:42pm") is built here, from the same local time the date line
// shows. (The server only knows UTC, so a name it generated would disagree with the date line.)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function autoTitle(d) {
  const h = d.getHours();
  return "Idea, " + MONTHS[d.getMonth()] + " " + d.getDate() + " " + (h % 12 || 12) + ":" +
         String(d.getMinutes()).padStart(2, "0") + (h < 12 ? "am" : "pm");
}

function markPlaying() {
  for (const li of document.querySelectorAll("#list li")) {
    const on = Number(li.dataset.id) === playingId && !player.paused;
    li.classList.toggle("playing", Number(li.dataset.id) === playingId);
    li.querySelector(".play").textContent = on ? "❚❚" : "▶";
    li.querySelector(".play").setAttribute("aria-label", (on ? "Pause " : "Play ") + li.dataset.title);
  }
}

let playStatus = new Map();    // recording id -> play_status from the latest list ("pending", "failed", ...)

function togglePlay(rec) {
  $("#audio-error").hidden = true;
  // After an error, clicking again reloads the source (a FLAC play copy may be ready by now).
  if (playingId === rec.id && !player.error) {
    if (player.paused) player.play(); else player.pause();
    return;
  }
  playingId = rec.id;
  player.src = "api/play/" + rec.id;     // the FLAC play copy if there is one, else the original
  player.play().catch(() => {});
  markPlaying();
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
let view = "inbox";            // which list is showing: "inbox" | "library"
let allRecs = [];
let allTags = [];
let openEditId = null;         // at most one edit form open at a time
let pollTimer = null;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function detailsText(rec) {
  const parts = [];
  if (rec.tempo) parts.push(cap(rec.tempo));
  if (rec.bpm) parts.push(rec.bpm + " BPM");
  if (rec.key_root || rec.key_mode) parts.push([rec.key_root, rec.key_mode].filter(Boolean).join(" "));
  return parts.join(" · ");
}

function notify(text) {
  const n = $("#notice");
  n.textContent = text;
  n.hidden = !text;
}

function setView(next) {
  view = next;
  openEditId = null;
  notify("");
  render();
}
$("#tab-inbox").addEventListener("click", () => setView("inbox"));
$("#tab-library").addEventListener("click", () => setView("library"));

function updateTabs() {
  const inbox = allRecs.filter((r) => r.status === "inbox").length;
  const library = allRecs.length - inbox;
  $("#tab-inbox").textContent = "Inbox" + (inbox ? " (" + inbox + ")" : "");
  $("#tab-library").textContent = "Library" + (library ? " (" + library + ")" : "");
  $("#tab-inbox").setAttribute("aria-pressed", String(view === "inbox"));
  $("#tab-library").setAttribute("aria-pressed", String(view === "library"));
}

function render() {
  updateTabs();
  const shown = allRecs.filter((r) => (view === "inbox") === (r.status === "inbox"));
  const ul = $("#list");
  ul.replaceChildren();
  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    empty.textContent = allRecs.length === 0 ? "Nothing yet. Upload a voice memo above."
      : view === "inbox" ? "Nothing waiting to be tagged. Switch to Library to browse what you've saved."
      : "Nothing in the Library yet. Open a recording in the Inbox and save it, and it moves here.";
  }
  $("#count").textContent = shown.length ? "(" + shown.length + ")" : "";
  playStatus = new Map(allRecs.map((rec) => [rec.id, rec.play_status]));
  for (const rec of shown) ul.append(buildRow(rec));
  markPlaying();
}

function buildRow(rec) {
  const btn = el("button", { class: "play", type: "button" }, "▶");
  btn.addEventListener("click", () => togglePlay(rec));
  const meta = el("div", { class: "meta" }, fmtDate(rec.recorded_at) + " · " + fmtSize(rec.size));
  if (rec.play_status === "pending") meta.append(el("span", { class: "chip" }, "preparing playback…"));
  if (rec.play_status === "failed") meta.append(el("span", { class: "chip" }, "no play copy"));
  const info = el("div", {}, el("div", { class: "title" }, rec.title), meta);
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
      if (first) first.focus();
    }
  });
  const side = el("div", { class: "side" }, edit,
    el("a", { class: "dl", href: "api/audio/" + rec.id + "?download=1" }, "Download"));
  const li = el("li", { "data-id": String(rec.id), "data-title": rec.title }, btn, info, side);
  if (openEditId === rec.id) li.append(buildForm(rec));
  return li;
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

  // tempo: word, optional number, tap-along
  const tempo = el("fieldset", { class: "tempo" }, el("legend", {}, "Tempo"));
  for (const [value, label] of [["", "Not set"], ["slow", "Slow"], ["medium", "Medium"], ["fast", "Fast"]]) {
    const rid = "f-tempo-" + id + "-" + (value || "none");
    const radio = el("input", { type: "radio", name: "tempo-" + id, id: rid, value });
    if ((rec.tempo || "") === value) radio.checked = true;
    tempo.append(el("span", { class: "radio" }, radio, el("label", { for: rid }, label)));
  }
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
  tempo.append(el("div", { class: "bpm" }, el("label", { for: "f-bpm-" + id }, "BPM (optional)"), bpm, tap));
  form.append(tempo);

  // key
  const root = el("select", { id: "f-root-" + id });
  root.append(el("option", { value: "" }, "—"));
  for (const k of KEY_ROOTS) root.append(el("option", { value: k }, k));
  root.value = rec.key_root || "";
  const mode = el("select", { id: "f-mode-" + id });
  mode.append(el("option", { value: "" }, "—"), el("option", { value: "major" }, "major"), el("option", { value: "minor" }, "minor"));
  mode.value = rec.key_mode || "";
  form.append(el("div", { class: "keyrow" }, field("Key", root, "f-root-" + id), field("Major / minor", mode, "f-mode-" + id)));

  const notes = el("textarea", { id: "f-notes-" + id, rows: "3", maxlength: "5000" });
  notes.value = rec.notes || "";
  form.append(field("Notes", notes, "f-notes-" + id));

  const err = el("p", { class: "error", role: "alert", hidden: "" });
  const save = el("button", { type: "submit", class: "primary" }, rec.status === "inbox" ? "Save and move to Library" : "Save");
  const cancel = el("button", { type: "button" }, "Cancel");
  cancel.addEventListener("click", () => { openEditId = null; render(); });
  const actions = el("div", { class: "actions" }, save, cancel);
  let back = null;
  if (rec.status !== "inbox") { back = el("button", { type: "button", class: "link" }, "Move back to Inbox"); actions.append(back); }
  form.append(err, actions);

  const submit = async (status) => {
    err.hidden = true;
    const picked = form.querySelector('input[name="tempo-' + id + '"]:checked');
    const bpmText = bpm.value.trim();
    const payload = {
      title: title.value.trim() || autoTitle(new Date(rec.recorded_at)),   // blank title = regenerate it
      tags: [...tagBox.querySelectorAll('.tagbtn[aria-pressed="true"]')].map((b) => b.dataset.tag),
      tempo: picked && picked.value ? picked.value : null,
      bpm: bpmText === "" ? null : Number(bpmText),
      key_root: root.value || null,
      key_mode: mode.value || null,
      notes: notes.value,
      status,
    };
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

async function loadList() {
  clearTimeout(pollTimer);
  const [recs, tags] = await Promise.all([api("recordings"), api("tags")]);
  if (recs.status === 401) { show("login"); return; }
  allRecs = (await recs.json()).recordings;
  if (tags.ok) allTags = (await tags.json()).tags;
  if (openEditId !== null) updateTabs();     // never rebuild the list under a form someone is typing in
  else render();
  schedulePoll();
}

// While the server is still converting something, check again shortly so the chip clears itself
// (but not while a form is open: that would throw away what is being typed).
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!allRecs.some((rec) => rec.play_status === "pending")) return;
  pollTimer = setTimeout(() => { if (openEditId !== null) schedulePoll(); else loadList(); }, 3000);
}

// ---- upload ------------------------------------------------------------------
function uploadOne(file, row) {
  return new Promise((resolve) => {
    const bar = row.querySelector("progress");
    const state = row.querySelector(".state");
    const fd = new FormData();
    fd.append("file", file, file.name);
    const recorded = file.lastModified ? new Date(file.lastModified) : new Date();
    if (file.lastModified) fd.append("recorded_at", recorded.toISOString());
    fd.append("title", autoTitle(recorded));
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
