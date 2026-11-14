"use strict";
// Runs in the <head>, before the page is drawn, so the chosen look is there from the first paint (no flash).
// Two independent choices, both made in the Menu:
//   style  : "standard" (default, no attribute) or "minimal"      -> <html data-theme="minimal">
//   colors : "auto" (default, follows the device), "light", "dark" -> <html data-colors="light|dark">
try {
  if (localStorage.getItem("riffbox.theme") === "minimal") document.documentElement.dataset.theme = "minimal";
  const c = localStorage.getItem("riffbox.colors");
  if (c === "light" || c === "dark") document.documentElement.dataset.colors = c;
} catch (e) { /* storage blocked: standard style, device colours */ }
// Chromium only (it has navigator.userAgentData): the long-list speed-up in style.css (content-visibility) is switched on for it.
if (navigator.userAgentData) document.documentElement.dataset.cv = "1";
