"use strict";
// Runs in the <head>, before the page is drawn, so the chosen theme is there from the first paint (no flash).
// "standard" is the default and needs no attribute; "minimal" sets data-theme on <html>. Chosen in the Menu.
try {
  if (localStorage.getItem("riffbox.theme") === "minimal") document.documentElement.dataset.theme = "minimal";
} catch (e) { /* storage blocked: the standard theme */ }
