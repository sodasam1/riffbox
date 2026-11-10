"use strict";
// The player bar: waveform, scrubbing, speed, loop, download.
// Loaded after app.js (see index.html): the files share one set of top-level names, and everything here runs only once the
// page has started, so it may use anything app.js defines.

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
  if (loopOn && loopA !== null && loopB !== null) { player.currentTime = loopA; player.play().catch(() => {}); return; }
  if (current && current.rec && player.ended) {   // an idea with several recordings plays on to the next one (only when the loaded recording really ended)
    const parts = current.rec.parts, i = parts.findIndex((p) => p.id === current.id);
    if (i >= 0 && i < parts.length - 1) startPlay(current.rec, parts[i + 1]);
  }
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
// Tell the page how tall the floating player is, so scrolling a row or form into view keeps it clear of the player.
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--bar-h", (playerBar.offsetHeight ? playerBar.offsetHeight + 28 : 0) + "px");
  const a = document.activeElement;                       // a taller bar must not cover the field being typed in
  if (a && a.closest && a.closest("#list form")) reveal(a);
}).observe(playerBar);
document.addEventListener("focusin", syncTyping);
document.addEventListener("focusout", syncTyping);
setInterval(syncTyping, 1000);                                                // safety net: a field removed while focused
applyBar();
