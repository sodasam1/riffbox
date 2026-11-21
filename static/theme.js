"use strict";
// Runs in the <head>, before the page is drawn, so the chosen look is there from the first paint (no flash).
// The colours and the accent are shared with the other apps on the site (same origin, keys site.colors and site.accent; the older riffbox.* keys are still read).
// Two independent choices, both made in the Menu:
//   style  : "minimal" (default) or "original"                    -> <html data-theme="minimal"> (original: no attribute)
//   accent : blue (default, the same on every app of the site), orange, teal, green, purple, pink, ink     -> <html data-accent="...">
//   colors : "auto" (default, follows the device), "light", "dark" -> <html data-colors="light|dark">
try {
  if (localStorage.getItem("riffbox.theme") !== "original") document.documentElement.dataset.theme = "minimal";
  const a = localStorage.getItem("site.accent") || localStorage.getItem("riffbox.accent");
  if (a && /^[a-z]+$/.test(a)) document.documentElement.dataset.accent = a;
  const c = localStorage.getItem("site.colors") || localStorage.getItem("riffbox.colors");
  if (c === "light" || c === "dark") document.documentElement.dataset.colors = c;
} catch (e) { document.documentElement.dataset.theme = "minimal"; /* storage blocked: default style, device colours */ }
// Chromium only (it has navigator.userAgentData): the long-list speed-up in style.css (content-visibility) is switched on for it.
if (navigator.userAgentData) document.documentElement.dataset.cv = "1";
