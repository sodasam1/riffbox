"use strict";
// All URLs are relative ("api/..."), so the app works under any prefix such as /ideas/.
// No inline handlers, data: or blob: URLs, no third-party hosts (relayd's CSP is strict).

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
}

async function boot() {
  let ok = false;
  try { ok = (await api("session")).ok; } catch (e) { /* offline: fall through to login */ }
  if (ok) { show("app"); await loadList(); } else { show("login"); $("#pass").focus(); }
}

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

let pollTimer = null;

async function loadList() {
  clearTimeout(pollTimer);
  const r = await api("recordings");
  if (r.status === 401) { show("login"); return; }
  const { recordings } = await r.json();
  const ul = $("#list");
  ul.replaceChildren();
  $("#empty").hidden = recordings.length > 0;
  $("#count").textContent = recordings.length ? "(" + recordings.length + ")" : "";
  playStatus = new Map(recordings.map((rec) => [rec.id, rec.play_status]));
  for (const rec of recordings) {
    const btn = el("button", { class: "play", type: "button" }, "▶");
    btn.addEventListener("click", () => togglePlay(rec));
    const meta = el("div", { class: "meta" }, fmtDate(rec.recorded_at) + " · " + fmtSize(rec.size));
    if (rec.status === "inbox") meta.append(el("span", { class: "chip" }, "inbox"));
    if (rec.play_status === "pending") meta.append(el("span", { class: "chip" }, "preparing playback…"));
    if (rec.play_status === "failed") meta.append(el("span", { class: "chip" }, "no play copy"));
    const dl = el("a", { class: "dl", href: "api/audio/" + rec.id + "?download=1" }, "Download");
    const li = el("li", { "data-id": String(rec.id), "data-title": rec.title },
      btn, el("div", {}, el("div", { class: "title" }, rec.title), meta), dl);
    ul.append(li);
  }
  markPlaying();
  // While the server is still converting something, check again shortly so the chip clears itself.
  if (recordings.some((rec) => rec.play_status === "pending")) pollTimer = setTimeout(loadList, 3000);
}

// ---- upload ------------------------------------------------------------------
function uploadOne(file, row) {
  return new Promise((resolve) => {
    const bar = row.querySelector("progress");
    const state = row.querySelector(".state");
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (file.lastModified) fd.append("recorded_at", new Date(file.lastModified).toISOString());
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
