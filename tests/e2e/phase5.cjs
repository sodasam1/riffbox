// Phase 5 browser test: the Library browser (filters, search, sort, keyboard). Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase5.cjs
const { launch } = require("./_browser.cjs");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8196, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e5-"));

function wav(freq, seconds = 4, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}

// title, recorded, tags, tempo, bpm, key_root, key_mode, notes, status
const SEED = [
  ["Funky bass riff", "2026-03-01T10:00:00Z", ["bass", "rhythmic idea"], "fast", 118, "D", "minor", "hummed over Dm", "tagged"],
  ["Dreamy keys", "2026-03-05T10:00:00Z", ["keys", "harmony"], "slow", 70, "C", "major", "pad with 100% reverb", "tagged"],
  ["Drum loop", "2026-02-20T10:00:00Z", ["drums", "rhythmic idea"], "medium", 100, null, null, "snare_roll idea", "tagged"],
  ["Vocal hook", "2026-03-10T10:00:00Z", ["vocal", "melody"], "medium", null, "D", "major", "", "tagged"],
  ["Full demo", "2026-01-15T10:00:00Z", ["full song", "bass", "drums", "keys"], "fast", 140, "Eb", "minor", "everything", "tagged"],
  ["Guitar lick", "2026-03-12T10:00:00Z", ["guitar", "melody"], "fast", 130, "E", "minor", "", "tagged"],
  ["Untagged scrap", "2026-03-15T10:00:00Z", [], null, null, null, null, "", "inbox"],
];

const server = spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${PORT}`, "wsgi:app"], {
  cwd: path.join(ROOT, "app"),
  env: { ...process.env, RIFFBOX_DATA_DIR: path.join(tmp, "data"), RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok",
         RIFFBOX_PASSPHRASE: "open sesame", RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas",
         RIFFBOX_STATIC_DIR: path.join(ROOT, "static"), RIFFBOX_FFMPEG: "" },
  stdio: "inherit",
});
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "health")).ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });

    // --- seed through the API (fast and deterministic), then drive the real UI
    const ids = {};
    for (let i = 0; i < SEED.length; i++) {
      const [title, rec] = SEED[i];
      const r = await ctx.request.post(BASE + "api/upload", {
        headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(100 + i * 37) }, title, recorded_at: rec },
      });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    assert.strictEqual((await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } })).status(), 200);
    for (const [title, , tags, tempo, bpm, key_root, key_mode, notes, status] of SEED) {
      const r = await ctx.request.patch(BASE + `api/recordings/${ids[title]}`,
        { data: { tags, tempo, bpm, key_root, key_mode, notes, status } });
      assert.strictEqual(r.status(), 200);
    }

    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });

    const titles = () => page.locator("#list > li .title").allTextContents();
    const waitTitles = async (expected, label) => {
      await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll("#list > li .title")].map((n) => n.textContent)) === JSON.stringify(exp),
        expected, { timeout: 8000 }).catch(async () => { throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(await titles())}`); });
    };
    const sorted = (a) => [...a].sort();
    const waitSet = async (expected, label) => {
      await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll("#list > li .title")].map((n) => n.textContent).sort()) === JSON.stringify(exp),
        sorted(expected), { timeout: 8000 }).catch(async () => { throw new Error(`${label}: expected ${JSON.stringify(sorted(expected))}, got ${JSON.stringify(sorted(await titles()))}`); });
    };
    const clearFilters = async () => { await page.click("#f-clear"); await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 6); };

    await page.goto(BASE);
    // the page shares the session cookie from the API login above, so it normally opens already logged in
    await page.waitForSelector("#app:not([hidden]), #login:not([hidden])");
    if (await page.isVisible("#login")) { await page.fill("#pass", "open sesame"); await page.click("#login-form button"); }
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() => /Inbox \(1\)/.test(document.querySelector("#tab-inbox").textContent));
    assert.strictEqual((await page.textContent("#tab-library")).trim(), "Library (6)");

    // --- the Library browser
    await page.click("#tab-library");
    await waitTitles(["Guitar lick", "Full demo", "Vocal hook", "Drum loop", "Dreamy keys", "Funky bass riff"], "default order: newest upload first");
    assert.ok(await page.isVisible("#filters-panel"), "sidebar visible on desktop");
    assert.ok(await page.isHidden("#filters-toggle"), "no toggle button on desktop");
    assert.ok(await page.isVisible("#colhead"), "column headings on desktop");
    assert.strictEqual((await page.textContent("#f-count")).trim(), "6 recordings");
    assert.ok(await page.locator("#f-clear").isDisabled(), "Clear is disabled when nothing is filtered");
    console.log("ok  Library lists the six saved recordings newest first, with the sidebar and column headings");

    // search
    await page.fill("#f-q", "bass");
    await waitSet(["Funky bass riff", "Full demo"], "search bass");
    assert.strictEqual((await page.textContent("#f-count")).trim(), "2 of 6 recordings");
    await page.fill("#f-q", "bass riff"); await waitSet(["Funky bass riff"], "two words");
    await page.fill("#f-q", "100%"); await waitSet(["Dreamy keys"], "percent is literal");
    await page.fill("#f-q", "rhythmic"); await waitSet(["Funky bass riff", "Drum loop"], "tag names are searched");
    await page.fill("#f-q", "zzzz");
    await page.waitForFunction(() => /No recordings match/.test(document.querySelector("#empty").textContent));
    assert.ok(await page.isHidden("#kbd-hint"), "keyboard hint hidden when there is nothing to move through");
    await clearFilters();
    assert.strictEqual(await page.inputValue("#f-q"), "");
    console.log("ok  search finds titles, notes and tag names; % is literal; empty results say so; Clear resets");

    // tags: all / any
    const tag = (t) => page.locator(`#f-tags button[data-tag="${t}"]`);
    await tag("bass").click(); await waitSet(["Funky bass riff", "Full demo"], "bass");
    assert.strictEqual(await tag("bass").getAttribute("aria-pressed"), "true");
    await tag("drums").click(); await waitSet(["Full demo"], "bass AND drums");
    await page.check("#f-match-any"); await waitSet(["Funky bass riff", "Drum loop", "Full demo"], "bass OR drums");
    await tag("bass").click(); await waitSet(["Drum loop", "Full demo"], "drums only");
    await clearFilters();
    console.log("ok  tag filters: all-selected narrows, any-selected widens, toggling off restores");

    // BPM range slider (two thumbs; a thumb at its end of the track means "no limit" on that side)
    const setRange = (sel, v) => page.$eval(sel, (el, val) => { el.value = String(val); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    const readout = async () => (await page.textContent("#f-bpm-readout")).trim();
    assert.strictEqual(await readout(), "Any BPM");
    assert.ok(await page.isHidden("#f-bpm-note"));
    await setRange("#f-bpm-min", 100);
    await waitSet(["Funky bass riff", "Drum loop", "Full demo", "Guitar lick"], "100 BPM and up");
    assert.strictEqual(await readout(), "100 BPM and up");
    assert.ok(await page.isVisible("#f-bpm-note"), "note says recordings with no BPM are hidden");
    await setRange("#f-bpm-max", 120);
    await waitSet(["Funky bass riff", "Drum loop"], "100 to 120 BPM");
    assert.strictEqual(await readout(), "100–120 BPM");
    await setRange("#f-bpm-min", 130);                                    // pushing the low thumb past the high one
    assert.strictEqual(await page.inputValue("#f-bpm-min"), "120", "the thumbs cannot cross");
    await setRange("#f-bpm-min", 118); await setRange("#f-bpm-max", 118);
    await waitSet(["Funky bass riff"], "exactly 118 (both ends are inclusive)");
    await setRange("#f-bpm-min", 40); await setRange("#f-bpm-max", 80);
    await waitSet(["Dreamy keys"], "up to 80 BPM");
    assert.strictEqual(await readout(), "Up to 80 BPM");
    await setRange("#f-bpm-max", 240);
    await waitSet(SEED.slice(0, 6).map((s) => s[0]), "both thumbs at the ends = no limit");
    assert.strictEqual(await readout(), "Any BPM");
    assert.ok(await page.locator("#f-clear").isDisabled(), "nothing is filtered, so Clear is disabled");
    // keyboard: the thumbs are real range inputs
    await page.focus("#f-bpm-min");
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowRight");
    await waitSet(["Funky bass riff", "Drum loop", "Full demo", "Guitar lick"], "keyboard: 100 and up from the arrow keys (100 is included)");
    assert.strictEqual(await readout(), "100 BPM and up");
    await page.keyboard.press("Home");
    await waitSet(SEED.slice(0, 6).map((s) => s[0]), "Home returns the thumb to 'no limit'");

    // key
    await page.selectOption("#f-root", "D"); await waitSet(["Funky bass riff", "Vocal hook"], "key D");
    await page.selectOption("#f-mode", "minor"); await waitSet(["Funky bass riff"], "D minor");
    assert.match((await page.textContent("#filters-toggle")), /Filters \(2 active\)/);
    await clearFilters();
    await tag("melody").click(); await setRange("#f-bpm-min", 120); await page.fill("#f-q", "lick");
    await waitSet(["Guitar lick"], "tag + BPM + search together");
    assert.match((await page.textContent("#filters-toggle")), /Filters \(3 active\)/);
    await clearFilters();
    assert.strictEqual(await page.inputValue("#f-bpm-min"), "40"); assert.strictEqual(await page.inputValue("#f-bpm-max"), "240");
    assert.strictEqual(await readout(), "Any BPM");
    assert.strictEqual(await page.locator("#filters input[id^='f-tempo']").count(), 0, "the slow/medium/fast filters are gone");
    console.log("ok  BPM range slider (mouse-free and by script), key, and combined filters; tempo-word filters removed");

    // sorting
    await page.selectOption("#f-sort", "title");
    await waitTitles(["Dreamy keys", "Drum loop", "Full demo", "Funky bass riff", "Guitar lick", "Vocal hook"], "title A-Z");
    assert.match(await page.textContent("#f-order"), /A to Z/);
    await page.click("#f-order");
    await waitTitles(["Vocal hook", "Guitar lick", "Funky bass riff", "Full demo", "Drum loop", "Dreamy keys"], "title Z-A");
    await page.selectOption("#f-sort", "bpm");
    await waitTitles(["Full demo", "Guitar lick", "Funky bass riff", "Drum loop", "Dreamy keys", "Vocal hook"], "bpm high first, none last");
    await page.click("#f-order");
    await waitTitles(["Dreamy keys", "Drum loop", "Funky bass riff", "Guitar lick", "Full demo", "Vocal hook"], "bpm low first, none still last");
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-library");
    await waitTitles(["Dreamy keys", "Drum loop", "Funky bass riff", "Guitar lick", "Full demo", "Vocal hook"], "sort remembered after reload");
    await page.selectOption("#f-sort", "recorded");
    await waitTitles(["Guitar lick", "Vocal hook", "Dreamy keys", "Funky bass riff", "Drum loop", "Full demo"], "back to newest recorded first");
    console.log("ok  sort by title, BPM (missing last both ways), recorded; direction button; remembered across reload");

    // --- keyboard and auto-preview
    const state = () => page.evaluate(() => {
      const a = document.querySelector("#player");
      const sel = document.querySelector("#list > li.selected");
      return { src: a.currentSrc.split("/").pop(), paused: a.paused, time: a.currentTime,
               selected: sel ? Number(sel.dataset.id) : null, current: document.querySelector('#list > li[aria-current="true"]')?.dataset.id };
    });
    const idAt = async (n) => Number(await page.locator("#list > li").nth(n).getAttribute("data-id"));
    await page.locator("#list > li").nth(0).locator(".title").click();            // click a row: select + audition
    await page.waitForFunction(() => { const a = document.querySelector("#player"); return !a.paused && a.currentTime > 0.1; }, null, { timeout: 8000 });
    let s = await state();
    assert.strictEqual(s.selected, await idAt(0)); assert.strictEqual(s.src, String(await idAt(0)));
    assert.strictEqual(String(s.selected), s.current, "aria-current marks the selected row");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "list", "list holds keyboard focus after a click");

    await page.keyboard.press("ArrowDown");
    await page.waitForFunction((id) => document.querySelector("#player").currentSrc.endsWith("/" + id) && !document.querySelector("#player").paused, String(await idAt(1)), { timeout: 8000 });
    assert.strictEqual((await state()).selected, await idAt(1));
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction((id) => document.querySelector("#player").currentSrc.endsWith("/" + id), String(await idAt(0)));
    await page.keyboard.press("ArrowUp");                                          // already at the top: stays there
    assert.strictEqual((await state()).selected, await idAt(0));
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("#player").paused);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    console.log("ok  click selects and plays; Up/Down move and play; Space pauses and resumes; stops at the ends");

    // auto-preview off: moving only highlights
    await page.uncheck("#f-preview");
    const before = (await state()).src;
    await page.locator("#list").focus();
    await page.keyboard.press("ArrowDown");
    assert.strictEqual((await state()).selected, await idAt(1));
    assert.strictEqual((await state()).src, before, "audio source unchanged when 'play as I move' is off");
    await page.keyboard.press("Space");
    await page.waitForFunction((id) => document.querySelector("#player").currentSrc.endsWith("/" + id), String(await idAt(1)));
    await page.check("#f-preview");
    console.log("ok  with 'play as I move' off, arrows only highlight and Space plays the highlighted recording");

    // typing in a form field is never taken over; filters wait while a form is open
    await page.locator("#list > li").nth(1).locator("button.edit-btn").click();
    const form = page.locator("#list form.edit");
    await form.waitFor();
    const hold = await state();
    const gaps = await page.evaluate(() => {          // the highlighted row's bar must not sit on the form's left edge
      const li = document.querySelector("#list > li.selected");
      const l = li.getBoundingClientRect().left;
      return { selected: li.classList.contains("selected"),
               field: document.querySelector("#list form.edit input[type=text]").getBoundingClientRect().left - l,
               play: li.querySelector(".play").getBoundingClientRect().left - l };
    });
    assert.ok(gaps.selected && gaps.field >= 8 && gaps.play >= 8, "content is inset from the highlight bar: " + JSON.stringify(gaps));
    const keySelect = form.locator("select[id^=f-root-]");
    await keySelect.focus();
    await keySelect.press("ArrowDown");                                           // a drop-down uses the arrow keys
    assert.notStrictEqual(await keySelect.inputValue(), "", "the arrow key changed the drop-down, not the list selection");
    assert.strictEqual((await state()).selected, hold.selected);
    assert.strictEqual((await state()).src, hold.src);
    await form.locator("textarea").fill("a note with spaces");                     // Space inside a field types a space
    assert.strictEqual((await state()).paused, hold.paused);
    await page.fill("#f-q", "bass");
    await page.waitForFunction(() => /Filters apply when you save or cancel/.test(document.querySelector("#notice").textContent));
    assert.ok(await form.isVisible(), "form left open");
    assert.strictEqual(await form.locator("textarea").inputValue(), "a note with spaces");
    await form.locator("button", { hasText: "Cancel" }).click();
    await waitSet(["Funky bass riff", "Full demo"], "filters apply after the form closes");
    assert.ok(await page.isHidden("#notice"), "the 'filters wait' notice goes away once the form is closed");
    await clearFilters();
    console.log("ok  arrows and Space inside a form are left alone; filters wait for an open form to close");

    // --- phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#filters-toggle")).display !== "none");
    assert.ok(await page.isHidden("#filters-panel"), "filters start collapsed on a phone");
    assert.ok(await page.isHidden("#colhead"), "no column headings on a phone");
    await page.click("#filters-toggle");
    assert.ok(await page.isVisible("#filters-panel"));
    assert.strictEqual(await page.getAttribute("#filters-toggle", "aria-expanded"), "true");
    await page.fill("#f-q", "keys");
    await waitSet(["Dreamy keys", "Full demo"], "search on a phone");
    assert.match(await page.textContent("#filters-toggle"), /Filters \(1 active\)/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, "no sideways scrolling on a phone, got " + overflow);
    await page.screenshot({ path: path.join(tmp, "library-mobile.png") });
    await page.click("#filters-toggle");
    assert.ok(await page.isHidden("#filters-panel"));
    console.log("ok  phone: filters collapse behind a button, still work, show how many are active, no sideways scroll");

    // desktop screenshot for the eye
    await page.setViewportSize({ width: 1280, height: 800 });
    await clearFilters();
    await page.screenshot({ path: path.join(tmp, "library-desktop.png") });

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
    console.log("screenshots in", tmp);
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
