"use strict";
// The two private pages: "How this works" and "Backup and export".
// Loaded after app.js (see index.html): the files share one set of top-level names, and everything here runs only once the
// page has started, so it may use anything app.js defines.

// ---- "How this works": a private page, fetched from the server only after login ---------------
// (It describes the server setup, so it is not part of the public page files.) Reached through
// the link in the header; the address gets "#how", so the browser's Back button works.
async function route() {
  const how = location.hash === "#how", data = location.hash === "#data";
  $("#how-view").hidden = !how;
  $("#data-view").hidden = !data;
  $("#main-view").hidden = how || data;
  if (data) { window.scrollTo(0, 0); loadData(); return; }
  clearTimeout(dataTimer);
  if (!how) return;
  window.scrollTo(0, 0);
  const body = $("#how-body");
  try {
    const r = await api("about");
    if (loggedOut(r)) return;
    if (r.ok) body.innerHTML = await r.text();      // our own file from our own server, never user input
    else body.textContent = "Could not load this page (error " + r.status + ").";
  } catch (e) {
    body.textContent = NETWORK_ERROR;
  }
}
window.addEventListener("hashchange", route);

// ---- "Backup and export": download the export, see the server backup, start one -----------------------
// The downloads are plain links (the browser shows the progress); only the backup status needs script.
let dataTimer = null;
function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 2) return "just now";
  if (mins < 120) return mins + " minutes ago";
  if (mins < 2880) return Math.round(mins / 60) + " hours ago";
  return Math.round(mins / 1440) + " days ago";
}
async function loadData() {
  clearTimeout(dataTimer);
  const err = $("#data-err");
  err.hidden = true;
  let r;
  try { r = await api("data"); } catch (e) { err.textContent = NETWORK_ERROR; err.hidden = false; return; }
  if (loggedOut(r)) return;
  if (!r.ok) { err.textContent = "Could not load this page (error " + r.status + ")."; err.hidden = false; return; }
  const d = await r.json();
  if (location.hash !== "#data") return;                 // the user already left
  const st = d.health, box = $("#data-status");
  box.hidden = false;
  box.className = "status-line " + st.level;
  $("#status-head").textContent = (st.level === "ok" ? "✓ " : st.level === "warn" ? "⚠ " : "✖ ") + st.headline;
  $("#status-sum").textContent = st.summary;
  const list = $("#status-items");
  list.replaceChildren(...st.items.filter((i) => i.text !== st.headline).map((i) => el("li", { class: i.level }, i.text)));
  $("#data-summary").textContent = d.recordings + (d.recordings === 1 ? " recording" : " recordings") +
    (d.trashed ? " (plus " + d.trashed + " in the Trash)" : "") + " · " + fmtSize(d.audio_bytes) + " of original audio";
  $("#data-trash-n").textContent = d.trashed ? "(" + d.trashed + ")" : "";
  $("#data-trash").disabled = d.trashed === 0;
  $("#backup-off").hidden = d.backup !== null;
  $("#backup-on").hidden = d.backup === null;
  if (!d.backup) return;
  const b = d.backup, job = b.job;
  $("#backup-state").textContent = b.latest
    ? "Last backup: " + ago(b.latest) + " (" + new Date(b.latest).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) + "). " +
      b.copies + " database " + (b.copies === 1 ? "copy" : "copies") + " kept. " +
      (b.audio_missing ? b.audio_missing + " of " + b.audio_total + " audio files are not backed up yet." : "All " + b.audio_total + " audio files are backed up.")
    : "No backup yet. " + b.audio_total + " audio files are waiting to be backed up.";
  $("#backup-now").disabled = job.running;
  $("#backup-msg").textContent = job.running ? "Backing up… this page updates when it finishes."
    : job.message ? job.message + (job.problems.length ? " Problems: " + job.problems.join("; ") : "") : "";
  if (job.running) dataTimer = setTimeout(loadData, 1500);
}
$("#data-trash").addEventListener("change", (e) => { $("#data-zip").setAttribute("href", "api/export.zip" + (e.target.checked ? "?trash=1" : "")); });
$("#backup-now").addEventListener("click", async () => {
  $("#backup-now").disabled = true;
  try {
    const r = await api("backup", { method: "POST" });
    if (loggedOut(r)) return;
    if (!r.ok && r.status !== 409) {
      const body = await r.json().catch(() => ({}));
      $("#backup-msg").textContent = body.error || "Could not start the backup (error " + r.status + ").";
      $("#backup-now").disabled = false;
      return;
    }
  } catch (e) { $("#backup-msg").textContent = NETWORK_ERROR; $("#backup-now").disabled = false; return; }
  loadData();
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;
  let r;
  try {
    r = await sendJson("login", "POST", { passphrase: $("#pass").value });
  } catch (e) {
    err.textContent = NETWORK_ERROR;
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
  try { await api("logout", { method: "POST" }); }
  catch (e) { notify("Could not log out: " + NETWORK_ERROR); return; }       // still logged in, so do not pretend otherwise
  history.replaceState(null, "", location.pathname + location.search);   // leave "#how" behind
  show("login");
});
