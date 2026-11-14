"use strict";
// Triage: work through the Inbox one recording at a time, keyboard first.
// Loaded after app.js (see index.html): the files share one set of top-level names, and everything here runs only once the
// page has started, so it may use anything app.js defines.

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
  $("#random").classList.add("slot-off");
  $("#triage").hidden = false;
  $("#triage-start").hidden = true;
  renderTriage();
}

function exitTriage() {
  if (!triage) return;
  triage = null;
  $("#triage").hidden = true;
  $("#browser").hidden = false;
  $("#random").classList.toggle("slot-off", view !== "inbox" && view !== "library");
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
  if (rec.parts && rec.parts.length > 1) {                     // an idea of several recordings: they play one after the other
    card.append(el("div", { class: "meta triage-parts" }, rec.parts.length + " parts, played in order: " + rec.parts.map((p) => p.title).join(" · ")));
  }

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
    r = await sendJson("groups/" + (recById(id) || { gid: id }).gid, "PATCH", { tags: data.tags, rating: data.rating, notes: data.notes, status: "tagged",
                                                      used_in: data.rating === "check" ? (data.used_in || null) : null });
  } catch (e) {
    err.textContent = NETWORK_ERROR;
    err.hidden = false;
    return;
  }
  if (session !== triage) return;               // triage was closed while this was saving
  if (loggedOut(r)) return;
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    err.textContent = body.error || "Could not save (error " + r.status + ").";
    err.hidden = false;
    return;
  }
  const saved = (await r.json()).group;
  if (session !== triage) return;
  triage.recs.set(id, asRec(saved));
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
