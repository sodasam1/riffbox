// Editing in the Inbox: Save keeps the recording there (half-filled forms are fine); Save and move to Library moves it. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/inboxedit.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8205, name: "inboxedit", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    for (const [i, title] of ["First memo", "Second memo"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 19) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    const api = async (q) => (await (await ctx.request.get(BASE + "api/groups" + q)).json()).groups;
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#list > li");
    const tab = (id) => page.waitForFunction((a) => document.querySelector(a[0]).textContent.trim() === a[1], [id[0], id[1]]);
    const notice = () => page.textContent("#notice").then((t) => t.trim());

    // the row button says Edit (not Tag), and the form offers both ways to save
    const row = page.locator("#list > li", { hasText: "Second memo" });
    assert.strictEqual((await row.locator("button.edit-btn").textContent()).trim(), "Edit");
    await row.locator("button.edit-btn").click();
    const form = page.locator("#list form.edit");
    await form.waitFor();
    const buttons = (await form.locator(".actions button").allTextContents()).map((s) => s.trim());
    assert.deepStrictEqual(buttons, ["Save", "Save and move to Library", "Cancel", "Delete"]);
    console.log("ok  an Inbox row says Edit, and its form offers Save and Save and move to Library");

    // a half-filled form saved with plain Save stays in the Inbox, and everything typed is kept
    await form.locator("input[id^=f-title-]").fill("Half-done chorus");
    await form.locator('button.tagbtn[data-tag="bass"]').click();
    await form.locator("input[type=number]").fill("96");
    await form.locator("textarea").fill("still need the key");
    await form.locator("button", { hasText: /^Save$/ }).click();
    await page.locator("#list > li", { hasText: "Half-done chorus" }).waitFor();
    assert.strictEqual(await notice(), "Saved. Still in the Inbox.");
    await tab(["#tab-inbox", "Inbox (2)"]); await tab(["#tab-library", "Library"]);
    const saved = (await api("?status=inbox")).find((r) => r.title === "Half-done chorus");
    assert.deepStrictEqual([saved.status, saved.tags, saved.bpm, saved.notes, saved.key_root], ["inbox", ["bass"], 96, "still need the key", null]);
    const shown = await page.locator("#list > li", { hasText: "Half-done chorus" }).innerText();
    assert.ok(/96 BPM/.test(shown) && /bass/.test(shown) && /still need the key/.test(shown), "the Inbox row shows what was saved: " + shown);
    console.log("ok  Save keeps a half-filled recording in the Inbox, and the row shows what was saved");

    // reopening shows the saved values; Enter in a field is a plain Save too
    await page.locator("#list > li", { hasText: "Half-done chorus" }).locator("button.edit-btn").click();
    const f2 = page.locator("#list form.edit");
    assert.strictEqual(await f2.locator("input[id^=f-title-]").inputValue(), "Half-done chorus");
    assert.strictEqual(await f2.locator("input[type=number]").inputValue(), "96");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="bass"]').getAttribute("aria-pressed"), "true");
    await f2.locator("select[id^=f-root-]").selectOption("A");
    await f2.locator("input[id^=f-title-]").press("Enter");
    await page.waitForFunction(() => /Still in the Inbox/.test(document.querySelector("#notice").textContent));
    await tab(["#tab-inbox", "Inbox (2)"]);
    assert.strictEqual((await api("?status=inbox")).find((r) => r.title === "Half-done chorus").key_root, "A");
    console.log("ok  reopening shows the saved values; Enter saves without moving it");

    // Cancel discards; Save and move to Library moves it with all its details
    await page.locator("#list > li", { hasText: "Half-done chorus" }).locator("button.edit-btn").click();
    await page.locator("#list form.edit textarea").fill("typed but cancelled");
    await page.locator("#list form.edit button", { hasText: "Cancel" }).click();
    assert.strictEqual((await api("?status=inbox")).find((r) => r.title === "Half-done chorus").notes, "still need the key");
    await page.locator("#list > li", { hasText: "Half-done chorus" }).locator("button.edit-btn").click();
    await page.locator("#list form.edit button", { hasText: "Save and move to Library" }).click();
    await tab(["#tab-inbox", "Inbox (1)"]); await tab(["#tab-library", "Library (1)"]);
    assert.strictEqual(await notice(), "Saved. Moved to Library.");
    const lib = (await api("?status=tagged"))[0];
    assert.deepStrictEqual([lib.title, lib.bpm, lib.key_root, lib.tags], ["Half-done chorus", 96, "A", ["bass"]]);
    console.log("ok  Cancel discards; Save and move to Library moves it with everything entered");

    // a Library recording: Save stays in the Library, Move back to Inbox is still there
    await page.click("#tab-library"); await page.waitForSelector("#list > li");
    await page.locator("#list > li button.edit-btn").first().click();
    const f3 = page.locator("#list form.edit");
    assert.deepStrictEqual((await f3.locator(".actions button").allTextContents()).map((s) => s.trim()), ["Save", "Cancel", "Move back to Inbox", "Delete"]);
    await f3.locator("button", { hasText: /^Save$/ }).click();
    await page.waitForFunction(() => /^Saved\.$/.test(document.querySelector("#notice").textContent.trim()));
    console.log("ok  a Library recording still has Save and Move back to Inbox");

    // phone: the form fits and both save buttons are reachable
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#tab-inbox"); await page.waitForSelector("#list > li");
    await page.locator("#list > li button.edit-btn").first().click(); await page.waitForSelector("#list form.edit");
    const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      right: Math.max(...[...document.querySelectorAll("#list form.edit .actions button")].map((b) => b.getBoundingClientRect().right)), vw: innerWidth }));
    assert.ok(m.over <= 1 && m.right <= m.vw, "the save buttons overflow on a phone: " + JSON.stringify(m));
    console.log("ok  on a phone the form and both save buttons fit");

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
