// The Menu, the compact upload bar, sortable column headings, the Compact table (short key, ISO dates, whole tags),
// Select mode with bulk actions, and the Random button. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase10.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8202, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e10-"));

function wav(freq, seconds = 6, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}

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

// title, recorded, seconds, bpm, key, tags, rating
const SEED = [
  ["Alpha riff", "2026-03-01T10:00:00Z", 3, 120, ["A", "minor"], ["bass"], null],
  ["Bravo hook", "2026-03-09T10:00:00Z", 9, 90, ["C", "major"], ["vocal", "melody"], "heart"],
  ["Charlie loop", "2026-02-11T10:00:00Z", 5, null, [null, null], ["drums", "rhythmic idea"], null],
  ["Delta chords", "2026-03-20T10:00:00Z", 7, 140, ["Eb", "major"], ["keys", "harmony", "guitar", "bass", "drums", "vocal"], "check"],
  ["Echo demo", "2026-01-05T10:00:00Z", 12, 70, ["F#", "minor"], [], null],
  ["Foxtrot lick", "2026-03-15T10:00:00Z", 4, 105, [null, null], ["guitar"], "heart"],
];

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" });
    const ids = {};
    for (const [i, [title, rec, secs]] of SEED.entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 21, secs) }, title, recorded_at: rec } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const [title, , , bpm, [root, mode], tags, rating] of SEED) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${ids[title]}`, { data: { status: "tagged", bpm, key_root: root, key_mode: mode, tags, rating, notes: "n" } })).status(), 200);
    }
    const api = async (q = "") => (await (await ctx.request.get(BASE + "api/groups" + q)).json()).groups;
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    const titles = () => page.locator("#list > li .title").allTextContents();
    const waitTitles = (exp, label) => page.waitForFunction((e) => JSON.stringify([...document.querySelectorAll("#list > li .title")].map((n) => n.textContent)) === JSON.stringify(e), exp, { timeout: 8000 })
      .catch(async () => { throw new Error(`${label}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(await titles())}`); });

    // ---- the Menu
    assert.ok(await page.isHidden("#menu"), "the menu starts closed");
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute("#menu-btn", "aria-expanded"), "true");
    assert.deepStrictEqual((await page.locator("#menu > *").allTextContents()).map((s) => s.trim()), ["Backup and export", "How this works", "Switch to the minimal theme", "Log out"]);
    await page.click("header h1");                                              // a click elsewhere closes it
    assert.ok(await page.isHidden("#menu"));
    await page.click("#menu-btn"); await page.keyboard.press("Escape");
    assert.ok(await page.isHidden("#menu") && (await page.evaluate(() => document.activeElement.id)) === "menu-btn", "Escape closes it and returns to the button");
    console.log("ok  the Menu opens from the button, closes on Escape, on an outside click, and holds its four items");

    // ---- compact upload bar
    const dropH = await page.evaluate(() => document.querySelector("#drop").getBoundingClientRect().height);
    assert.ok(dropH < 60, "the upload bar is " + dropH + "px tall");
    assert.strictEqual(await page.locator("#up-h").count(), 0);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#pick")]);
    assert.ok(chooser.isMultiple(), "the button opens the file chooser");
    await chooser.setFiles([]);
    const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["not really audio"], "dropped.wav", { type: "audio/wav" })); return d; });
    await page.dispatchEvent("body", "dragenter", { dataTransfer: dt });
    assert.ok(await page.isVisible("#dropveil"), "dragging a file over the page shows the veil");
    await page.dispatchEvent("body", "drop", { dataTransfer: dt });
    assert.ok(await page.isHidden("#dropveil"));
    await page.waitForSelector("#queue li");                              // dropped anywhere: it was taken for upload
    assert.match(await page.textContent("#queue li .name"), /dropped\.wav/);
    console.log("ok  a one-line upload bar; its button opens the chooser; files dropped anywhere on the page are taken");

    // ---- the Library table: no heading, date-only columns with timestamp tooltips
    await page.click("#tab-library"); await page.waitForSelector("#list > li");
    assert.strictEqual(await page.locator("#lib-h").count(), 0);
    const first = page.locator("#list > li").first();
    const dates = await first.evaluate((li) => ({ rec: li.querySelector(".c-rec").innerText, up: li.querySelector(".c-up").innerText,
      recTip: li.querySelector(".c-rec").title, upTip: li.querySelector(".c-up").title, len: li.querySelector(".c-len").innerText }));
    assert.match(dates.rec, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/, "recorded shows a date only: " + dates.rec);
    assert.match(dates.up, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    assert.match(dates.upTip, /\d{1,2}:\d{2}:\d{2}.*\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/, "the tooltip has the full timestamp: " + dates.upTip);
    assert.match(dates.recTip, /\d{1,2}:\d{2}:\d{2}/);
    assert.match(dates.len, /^\d+:\d{2}$/);
    for (const h of ["Title", "Tags", "Tempo · key", "Length", "Recorded", "Uploaded"]) assert.ok((await page.textContent("#colhead")).includes(h), "heading " + h);
    console.log("ok  the table has Length, Recorded and Uploaded columns showing the date only, with the full timestamp on hover");

    // ---- sorting by the headings: ascending, descending, default
    const caret = (c) => page.textContent(`#colhead button[data-sort="${c}"] .caret`);
    assert.strictEqual(await caret("uploaded"), "▼", "default: newest upload first");
    await waitTitles(["Foxtrot lick", "Echo demo", "Delta chords", "Charlie loop", "Bravo hook", "Alpha riff"], "default order");
    await page.click('#colhead button[data-sort="bpm"]');
    await waitTitles(["Echo demo", "Bravo hook", "Foxtrot lick", "Alpha riff", "Delta chords", "Charlie loop"], "tempo ascending (no tempo last)");
    assert.strictEqual(await caret("bpm"), "▲"); assert.strictEqual(await caret("uploaded"), "");
    assert.strictEqual(await page.getAttribute('#colhead button[data-sort="bpm"]', "aria-sort"), "ascending");
    await page.click('#colhead button[data-sort="bpm"]');
    await waitTitles(["Delta chords", "Alpha riff", "Foxtrot lick", "Bravo hook", "Echo demo", "Charlie loop"], "tempo descending (no tempo still last)");
    assert.strictEqual(await caret("bpm"), "▼");
    await page.click('#colhead button[data-sort="bpm"]');
    await waitTitles(["Foxtrot lick", "Echo demo", "Delta chords", "Charlie loop", "Bravo hook", "Alpha riff"], "third click: back to the default");
    assert.strictEqual(await caret("uploaded"), "▼");
    await page.click('#colhead button[data-sort="recorded"]');
    await waitTitles(["Echo demo", "Charlie loop", "Alpha riff", "Bravo hook", "Foxtrot lick", "Delta chords"], "recorded ascending");
    await page.click('#colhead button[data-sort="title"]');
    await waitTitles(["Alpha riff", "Bravo hook", "Charlie loop", "Delta chords", "Echo demo", "Foxtrot lick"], "title ascending");
    await page.click('#colhead button[data-sort="length"]'); await page.click('#colhead button[data-sort="length"]');
    await waitTitles(["Echo demo", "Bravo hook", "Delta chords", "Charlie loop", "Foxtrot lick", "Alpha riff"], "length descending");
    await page.click('#colhead button[data-sort="uploaded"]');                    // the default column: ascending first
    await waitTitles(["Alpha riff", "Bravo hook", "Charlie loop", "Delta chords", "Echo demo", "Foxtrot lick"], "uploaded ascending");
    await page.click('#colhead button[data-sort="uploaded"]');
    await waitTitles(["Foxtrot lick", "Echo demo", "Delta chords", "Charlie loop", "Bravo hook", "Alpha riff"], "uploaded descending, which is the default");
    assert.strictEqual(await page.inputValue("#f-sort"), "uploaded");              // the sidebar menu follows the headings
    console.log("ok  clicking a heading sorts ascending, then descending, then back to newest upload; carets and aria-sort follow");

    // ---- Compact: short tempo and key, ISO dates, whole tags
    await page.click("#dens-compact");
    await page.waitForTimeout(300);
    const row = (t) => page.locator("#list > li", { hasText: t });
    const dText = (t) => row(t).locator(".details").innerText();
    assert.strictEqual((await dText("Alpha riff")).trim(), "120 · A m");
    assert.strictEqual((await dText("Bravo hook")).trim(), "90 · C M");
    assert.strictEqual((await dText("Delta chords")).trim(), "140 · Eb M");
    assert.strictEqual((await dText("Echo demo")).trim(), "70 · F# m");
    assert.strictEqual((await dText("Foxtrot lick")).trim(), "105");
    assert.ok(!/BPM|minor|major/.test((await page.locator("#list").innerText())), "compact has no 'BPM', 'minor' or 'major'");
    assert.strictEqual((await row("Alpha riff").locator(".c-rec").innerText()).trim(), "2026-03-01");
    assert.match(await row("Alpha riff").locator(".c-up").innerText(), /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(await row("Alpha riff").locator(".details").getAttribute("title"), "120 BPM · A minor");        // the long form on hover
    const tagsW = await row("Alpha riff").locator(".tags").evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(tagsW >= 150, "the tags column is only " + tagsW + "px wide");
    const six = row("Delta chords").locator(".tags");
    const info = await six.evaluate((box) => { const chips = [...box.querySelectorAll(".chip.tag:not(.more)")], more = box.querySelector(".more");
      return { shown: chips.filter((c) => !c.hidden).map((c) => [c.textContent, c.scrollWidth <= c.clientWidth + 1]), hidden: chips.filter((c) => c.hidden).map((c) => c.textContent),
               more: more ? [more.textContent, more.title] : null, overflow: box.scrollHeight - box.clientHeight }; });
    assert.ok(info.shown.length >= 2 && info.shown.every(([, whole]) => whole), "tags are cut off: " + JSON.stringify(info.shown));
    if (info.hidden.length) { assert.strictEqual(info.more[0], "+" + info.hidden.length); assert.strictEqual(info.more[1], info.hidden.join(", ")); }
    assert.ok(info.shown.map(([t]) => t).concat(info.hidden).sort().join() === ["keys", "harmony", "guitar", "bass", "drums", "vocal"].sort().join(), "tags went missing");
    assert.ok(info.shown.every(([t]) => t.length > 1), "an abbreviated tag: " + JSON.stringify(info.shown));
    const shownNow = () => six.evaluate((box) => [...box.querySelectorAll(".chip.tag:not(.more)")].filter((c) => !c.hidden).length);
    const narrow = await shownNow();
    await page.setViewportSize({ width: 1600, height: 800 }); await page.waitForTimeout(400);
    assert.ok((await shownNow()) > narrow, "a wider screen shows more tags (" + narrow + " -> " + (await shownNow()) + ")");
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("ok  Compact: '120 · A m', ISO dates, long form on hover, and tags are whole words with a +N for the rest");
    await page.click("#dens-cozy");

    // ---- Select mode and bulk actions
    assert.ok(await page.isHidden("#bulkbar") && (await page.locator(".rowsel").count()) === 0, "nothing to tick until Select is pressed");
    await page.click("#select-toggle");
    await page.waitForSelector(".rowsel");
    assert.ok(await page.isVisible("#bulkbar"));
    assert.ok(await page.isDisabled("#bulk-add") && await page.isDisabled("#bulk-trash"), "actions wait for a selection");
    await page.locator("#list > li .rowsel").nth(0).check();
    await page.locator("#list > li .rowsel").nth(2).click({ modifiers: ["Shift"] });                // a shift-click range
    assert.strictEqual((await page.textContent("#bulk-count")).trim(), "3 selected");
    await page.locator("#list > li").first().evaluate((li) => li.classList.contains("picked") || (() => { throw new Error("not highlighted"); })());
    const overflowAt = async (w) => { await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(150);
      return page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, side: Math.max(...[...document.querySelectorAll("#list > li .side")].map((s) => s.getBoundingClientRect().right)), res: document.querySelector("#results").getBoundingClientRect().right })); };
    for (const w of [1240, 1280, 1600]) { const o = await overflowAt(w); assert.ok(o.over <= 1 && o.side <= o.res + 2, `selecting at ${w}px overflows (${JSON.stringify(o)})`); }
    await page.setViewportSize({ width: 1280, height: 800 });
    const bulkTitles = await titles();                                                                 // default order: Foxtrot, Echo, Delta, ...
    await page.selectOption("#bulk-add", "melody");
    await page.waitForFunction(() => /Added tag/.test(document.querySelector("#notice").textContent));
    assert.match(await page.textContent("#notice"), /Added tag “melody” on 3 recordings\./);
    let rows = await api("?status=tagged&rating=heart,check,x,none");
    assert.deepStrictEqual(rows.filter((r) => r.tags.includes("melody")).map((r) => r.title).sort(), ["Bravo hook", "Delta chords", "Echo demo", "Foxtrot lick"].filter((t) => bulkTitles.slice(0, 3).includes(t) || t === "Bravo hook").sort());
    assert.strictEqual((await page.textContent("#bulk-count")).trim(), "0 selected", "the selection clears after an action");
    await page.locator("#list > li .rowsel").nth(0).check(); await page.locator("#list > li .rowsel").nth(1).check();
    const removable = await page.locator("#bulk-remove option").allTextContents();
    assert.ok(removable.includes("melody") && !removable.includes("harmony") === !(await api("?status=tagged&rating=heart,check,x,none")).slice(0, 2).some((r) => r.tags.includes("harmony")), "Remove offers only the tags the selection has");
    await page.selectOption("#bulk-remove", "melody");
    await page.waitForFunction(() => /Removed tag/.test(document.querySelector("#notice").textContent));
    await page.locator("#list > li .rowsel").nth(0).check(); await page.locator("#list > li .rowsel").nth(1).check();
    await page.selectOption("#bulk-mark", "heart");
    await page.waitForFunction(() => /Marked 2 recordings/.test(document.querySelector("#notice").textContent));
    rows = await api("?status=tagged&rating=heart,check,x,none");
    assert.ok(rows.filter((r) => bulkTitles.slice(0, 2).includes(r.title)).every((r) => r.rating === "heart"));
    await page.locator("#list > li .rowsel").nth(0).check();
    await page.click("#bulk-trash");
    assert.match(await page.textContent("#bulk-trash"), /Press again to trash 1/, "the first press only asks");
    assert.strictEqual((await api("?status=tagged&rating=heart,check,x,none")).length, 6);
    await page.click("#bulk-trash");
    await page.waitForFunction(() => /to the Trash/.test(document.querySelector("#notice").textContent));
    assert.strictEqual((await api("?status=tagged&rating=heart,check,x,none")).length, 5);
    assert.match((await page.textContent("#tab-trash")).trim(), /Trash \(1\)/);
    await page.locator("#list > li .rowsel").nth(0).check();
    await page.click("#bulk-inbox");
    await page.waitForFunction(() => /back to the Inbox/.test(document.querySelector("#notice").textContent));
    assert.match((await page.textContent("#tab-inbox")).trim(), /Inbox \(2\)/);
    // select all, and a filter that hides ticked rows un-ticks them
    await page.check("#bulk-all");
    assert.strictEqual((await page.textContent("#bulk-count")).trim(), "4 selected");
    await page.fill("#f-q", "bravo");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 1);
    assert.strictEqual((await page.textContent("#bulk-count")).trim(), "1 selected", "rows hidden by a filter are no longer selected");
    await page.fill("#f-q", "");
    await page.click("#bulk-done");
    assert.ok(await page.isHidden("#bulkbar") && (await page.locator(".rowsel").count()) === 0);
    await page.click("#select-toggle"); await page.waitForSelector(".rowsel");
    await page.click("#tab-inbox"); await page.click("#tab-library");
    assert.strictEqual(await page.locator(".rowsel").count(), 0, "leaving the Library ends Select mode");
    console.log("ok  Select mode: ranges, add/remove tag, mark, move to Inbox, two-press trash, select all, filters un-tick hidden rows");

    // ---- Random
    await page.click("#tab-library"); await page.waitForSelector("#list > li");
    const playing = () => page.evaluate(() => (document.querySelector("#player").getAttribute("src") || "").match(/play\/(\d+)/)?.[1] || null);
    const seen = [];
    for (let i = 0; i < 6; i++) { await page.click("#random"); await page.waitForTimeout(120); seen.push(await playing()); }
    assert.ok(seen.every((x, i) => i === 0 || x !== seen[i - 1]), "Random repeated the recording that was already playing: " + seen);
    assert.ok(new Set(seen).size >= 2, "Random always plays the same one: " + seen);
    assert.match(await page.textContent("#notice"), /^Playing “/);
    const shownIds = (await api("?status=tagged")).map((r) => String(r.id));
    assert.ok(seen.every((x) => shownIds.includes(x)), "Random played something not in the list");
    await page.fill("#f-q", "Alpha");                                                                  // it draws from the filtered list
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 1);
    await page.click("#random");
    assert.strictEqual(await playing(), String(ids["Alpha riff"]));
    assert.match(await page.textContent("#notice"), /filtered list/);
    await page.fill("#f-q", "zzz-nothing");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 0);
    await page.click("#random");
    assert.match(await page.textContent("#notice"), /empty/);
    console.log("ok  Random plays a different recording each press, drawn from the filtered list");

    // ---- Random also works in the Inbox (a big backlog), and only where there is a list to draw from
    await page.fill("#f-q", "");
    await page.click("#tab-inbox"); await page.waitForSelector("#list > li");
    assert.ok(await page.isVisible("#random") && await page.isHidden("#density") && await page.isVisible("#select-toggle"), "Random and Select show in the Inbox, the row-size control does not");
    const inboxIds = (await api("?status=inbox")).map((r) => String(r.id));
    assert.ok(inboxIds.length >= 2, "the Inbox needs two recordings for this check");
    const inboxSeen = [];
    for (let i = 0; i < 5; i++) { await page.click("#random"); await page.waitForTimeout(120); inboxSeen.push(await playing()); }
    assert.ok(inboxSeen.every((x) => inboxIds.includes(x)), "Random played something that is not in the Inbox: " + inboxSeen);
    assert.ok(inboxSeen.every((x, i) => i === 0 || x !== inboxSeen[i - 1]), "Random repeated itself in the Inbox: " + inboxSeen);
    assert.match(await page.textContent("#notice"), /^Playing “/);
    await page.click("#triage-start"); await page.waitForSelector("#triage-card h4");
    assert.ok(await page.isHidden("#random"), "no Random button while triaging");
    await page.keyboard.press("Escape"); await page.waitForSelector("#browser:not([hidden])");
    assert.ok(await page.isVisible("#random"), "Random is back after triage");
    await page.click("#tab-resurface"); assert.ok(await page.isHidden("#random"), "Resurface has its own Surprise me");
    console.log("ok  Random works in the Inbox too (not during triage, and not on Resurface, which has Surprise me)");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
