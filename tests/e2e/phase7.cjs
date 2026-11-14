// Phase 7 browser test: marks (heart / check / x), the Show filter, and keyboard triage of the Inbox. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase7.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8192, name: "7", wavSeconds: 6 });

// title, recorded, status, tags, rating, used_in
const SEED = [
  ["Lib heart A", "2026-03-05T10:00:00Z", "tagged", ["bass"], "heart", null],
  ["Lib heart B", "2026-03-04T10:00:00Z", "tagged", [], "heart", null],
  ["Lib check", "2026-03-03T10:00:00Z", "tagged", [], "check", "Song A"],
  ["Lib x", "2026-03-02T10:00:00Z", "tagged", [], "x", null],
  ["Lib plain", "2026-03-01T10:00:00Z", "tagged", [], null, null],
  ["Inbox one", "2026-03-14T10:00:00Z", "inbox", [], null, null],
  ["Inbox two", "2026-03-13T10:00:00Z", "inbox", [], null, null],
  ["Inbox three", "2026-03-12T10:00:00Z", "inbox", [], null, null],
  ["Inbox four", "2026-03-11T10:00:00Z", "inbox", [], null, null],
];

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const ids = {};
    for (let i = 0; i < SEED.length; i++) {
      const [title, when] = SEED[i];
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title, recorded_at: when } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const [title, , status, tags, rating, used_in] of SEED) {
      const r = await ctx.request.patch(BASE + `api/recordings/${ids[title]}`, { data: { status, tags, rating, used_in } });
      assert.strictEqual(r.status(), 200, title + ": " + (await r.text()));
    }
    const api = async (q = "") => (await (await ctx.request.get(BASE + "api/groups" + q)).json()).groups;
    const byTitle = async (title) => (await api()).find((r) => r.title === title);

    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    const titles = () => page.locator("#list > li .title").allTextContents();
    const waitSet = (expected, label) => page.waitForFunction((exp) =>
      JSON.stringify([...document.querySelectorAll("#list > li .title")].map((n) => n.textContent).sort()) === JSON.stringify(exp),
      [...expected].sort(), { timeout: 8000 }).catch(async () => { throw new Error(`${label}: expected ${JSON.stringify([...expected].sort())}, got ${JSON.stringify((await titles()).sort())}`); });
    const row = (title) => page.locator("#list > li", { hasText: title });
    const label = async (id) => (await page.textContent(`label[for="${id}"]`)).replace(/\s+/g, " ").trim();

    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden]), #login:not([hidden])");
    if (await page.isVisible("#login")) { await page.fill("#pass", "open sesame"); await page.click("#login-form button"); }
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-library");

    // --- the Show filter: All leaves out the ✗ ones; each mark on its own; counts
    await waitSet(["Lib heart A", "Lib heart B", "Lib check", "Lib plain"], "All hides the one marked ✗");
    assert.strictEqual(await label("f-show-all"), "All (hides ✗) · 4");
    assert.strictEqual(await label("f-show-heart"), "♥ Interesting · 2");
    assert.strictEqual(await label("f-show-check"), "✓ Used in a song · 1");
    assert.strictEqual(await label("f-show-x"), "✗ No longer interesting · 1");
    assert.strictEqual(await label("f-show-none"), "No mark · 1");
    assert.strictEqual((await page.textContent("#f-count")).trim(), "4 recordings (1 marked ✗ hidden)");
    assert.ok(await page.locator("#f-clear").isDisabled(), "the default view counts as nothing filtered");
    await page.check("#f-show-heart"); await waitSet(["Lib heart A", "Lib heart B"], "only ♥");
    await page.check("#f-show-check"); await waitSet(["Lib check"], "only ✓");
    assert.match(await row("Lib check").innerText(), /used in Song A/);
    await page.check("#f-show-x"); await waitSet(["Lib x"], "only ✗");
    assert.strictEqual((await page.textContent("#f-count")).trim(), "1 of 5 recordings");
    await page.check("#f-show-none"); await waitSet(["Lib plain"], "only unmarked");
    await page.check("#f-show-heart");
    await page.locator('#f-tags button[data-tag="bass"]').click(); await waitSet(["Lib heart A"], "♥ together with a tag");
    assert.ok(await page.locator("#f-clear").isEnabled());
    await page.click("#f-clear"); await waitSet(["Lib heart A", "Lib heart B", "Lib check", "Lib plain"], "Clear returns to All (still hiding ✗)");
    assert.strictEqual(await page.isChecked("#f-show-all"), true);
    console.log("ok  Show filter: All hides ✗, each mark on its own, counts, combined with a tag, Clear resets");

    // --- marking from the list
    const mark = (title, key) => row(title).locator(`.side .ratebtn[data-rating="${key}"]`);
    await mark("Lib plain", "heart").click();
    await page.waitForFunction(() => document.querySelector("#f-show-heart").nextElementSibling.textContent.includes("· 3"));
    assert.strictEqual((await byTitle("Lib plain")).rating, "heart");
    assert.strictEqual(await mark("Lib plain", "heart").getAttribute("aria-pressed"), "true");
    await mark("Lib plain", "heart").click();                                             // pressing it again removes it
    await page.waitForFunction(() => document.querySelector("#f-show-heart").nextElementSibling.textContent.includes("· 2"));
    assert.strictEqual((await byTitle("Lib plain")).rating, null);
    await mark("Lib plain", "x").click();                                                  // ✗ leaves "All" at once
    await waitSet(["Lib heart A", "Lib heart B", "Lib check"], "marking ✗ hides it from All");
    assert.strictEqual((await byTitle("Lib plain")).rating, "x");
    assert.strictEqual((await page.textContent("#f-count")).trim(), "3 recordings (2 marked ✗ hidden)");
    await page.check("#f-show-x"); await waitSet(["Lib x", "Lib plain"], "both ✗ ones");
    await mark("Lib plain", "x").click();                                                  // un-cross it
    await waitSet(["Lib x"], "un-marking drops it out of the ✗ list");
    await page.check("#f-show-all");
    await waitSet(["Lib heart A", "Lib heart B", "Lib check", "Lib plain"], "and it is back in All");
    console.log("ok  row buttons mark, un-mark, and move recordings in and out of the filtered view; counts follow");

    // --- keys on the list: h, c, x
    await row("Lib plain").locator(".title").click();
    await page.keyboard.press("h");
    await page.waitForFunction(() => document.querySelector("#list > li.selected .ratebtn[data-rating=heart]").getAttribute("aria-pressed") === "true");
    assert.strictEqual((await byTitle("Lib plain")).rating, "heart");
    await page.keyboard.press("c");
    await page.waitForFunction(() => document.querySelector("#list > li.selected .ratebtn[data-rating=check]").getAttribute("aria-pressed") === "true");
    assert.strictEqual((await byTitle("Lib plain")).rating, "check");
    await page.keyboard.press("c");
    await page.waitForFunction(() => !document.querySelector("#list > li.selected .ratebtn[aria-pressed=true]"));
    assert.strictEqual((await byTitle("Lib plain")).rating, null);
    console.log("ok  h / c / x on the highlighted row mark it; pressing again removes the mark");

    // --- the edit form: marks and the song name
    await row("Lib heart A").locator("button.edit-btn").click();
    const form = page.locator("#list form.edit");
    await form.waitFor();
    assert.ok(await form.locator('input[id^="f-used-"]').isHidden(), "no song-name box until it is a ✓");
    assert.strictEqual(await form.locator('.ratebtn[data-rating="heart"]').getAttribute("aria-pressed"), "true");
    await form.locator('.ratebtn[data-rating="check"]').click();
    assert.ok(await form.locator('input[id^="f-used-"]').isVisible());
    assert.strictEqual(await form.locator('.ratebtn[data-rating="heart"]').getAttribute("aria-pressed"), "false", "one mark at a time");
    await form.locator('input[id^="f-used-"]').fill("  My Song  ");
    await form.locator("button[type=submit]").click();
    await page.waitForFunction(() => [...document.querySelectorAll("#list > li")].some((li) => li.innerText.includes("used in My Song")));
    let rec = await byTitle("Lib heart A");
    assert.deepStrictEqual([rec.rating, rec.used_in], ["check", "My Song"]);
    await row("Lib heart A").locator("button.edit-btn").click();
    const form2 = page.locator("#list form.edit");
    assert.strictEqual(await form2.locator('input[id^="f-used-"]').inputValue(), "My Song", "the form shows the saved song");
    await form2.locator('.ratebtn[data-rating="check"]').click();                         // remove the ✓
    assert.ok(await form2.locator('input[id^="f-used-"]').isHidden());
    await form2.locator("button[type=submit]").click();
    await page.waitForFunction(() => ![...document.querySelectorAll("#list > li")].some((li) => li.innerText.includes("used in My Song")));
    rec = await byTitle("Lib heart A");
    assert.deepStrictEqual([rec.rating, rec.used_in], [null, null], "removing the ✓ also removes the song name");
    console.log("ok  form: marks, the song-name box only for ✓, saved and cleared together");

    // --- triage
    await page.click("#tab-inbox");
    assert.strictEqual((await page.textContent("#triage-start")).trim(), "Triage the Inbox (4)");
    await page.click("#triage-start");
    await page.waitForSelector("#triage:not([hidden])");
    assert.ok(await page.isHidden("#browser"), "the list gives way to the card");
    assert.strictEqual((await page.textContent("#triage-pos")).trim(), "1 of 4");
    assert.strictEqual((await page.textContent("#triage-card h4")).trim(), "Inbox one");
    await page.waitForFunction(() => { const a = document.querySelector("#player"); return !a.paused && a.currentTime > 0.1; }, null, { timeout: 8000 });
    assert.ok((await page.evaluate(() => document.querySelector("#player").currentSrc)).endsWith("/" + ids["Inbox one"]), "the card is playing");
    const pressed = (sel) => page.locator(sel).getAttribute("aria-pressed");
    const card = page.locator("#triage-card");
    await page.keyboard.press("1");
    assert.strictEqual(await pressed("#triage-card .tagbtn >> nth=0"), "true", "1 toggles the first tag");
    await page.keyboard.press("h");
    assert.strictEqual(await pressed('#triage-card .ratebtn[data-rating="heart"]'), "true");
    await page.keyboard.press("n");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "t-notes", "n jumps to the notes");
    await page.keyboard.type("a 1 h c x s u note");                                         // typing must not trigger shortcuts
    assert.strictEqual(await pressed("#triage-card .tagbtn >> nth=0"), "true", "typing '1' did not toggle the tag");
    assert.strictEqual(await pressed('#triage-card .ratebtn[data-rating="heart"]'), "true", "typing 'h' did not change the mark");
    assert.strictEqual(await pressed('#triage-card .ratebtn[data-rating="x"]'), "false");
    assert.strictEqual((await page.textContent("#triage-pos")).trim(), "1 of 4", "typing 's' did not skip the card");
    await page.keyboard.press("Escape");                                                    // leaves the box, not triage
    assert.ok(await page.isVisible("#triage"));
    await page.keyboard.press("ArrowRight");                                                // save and next
    await page.waitForFunction(() => document.querySelector("#triage-pos").textContent.trim() === "2 of 4");
    let r1 = await byTitle("Inbox one");
    assert.deepStrictEqual([r1.status, r1.tags, r1.rating, r1.notes], ["tagged", ["bass"], "heart", "a 1 h c x s u note"]);
    // card 2: Space pauses and resumes, then skip
    assert.strictEqual((await page.textContent("#triage-card h4")).trim(), "Inbox two");
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    await page.keyboard.press("Space"); await page.waitForFunction(() => document.querySelector("#player").paused);
    await page.keyboard.press("Space"); await page.waitForFunction(() => !document.querySelector("#player").paused);
    await page.keyboard.press("s");
    await page.waitForFunction(() => document.querySelector("#triage-pos").textContent.trim() === "3 of 4");
    assert.strictEqual((await byTitle("Inbox two")).status, "inbox", "skipping changes nothing");
    // card 3: ✓, song name, Enter inside the box saves
    await page.keyboard.press("c");
    assert.ok(await page.locator("#t-used").isVisible());
    await page.keyboard.press("u");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "t-used");
    await page.keyboard.type("Triage Song");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#triage-pos").textContent.trim() === "4 of 4");
    let r3 = await byTitle("Inbox three");
    assert.deepStrictEqual([r3.status, r3.rating, r3.used_in], ["tagged", "check", "Triage Song"]);
    // go back: card 3 shows what was saved; card 2 can still be saved
    await page.keyboard.press("ArrowLeft");
    assert.strictEqual((await page.textContent("#triage-card h4")).trim(), "Inbox three");
    assert.strictEqual(await pressed('#triage-card .ratebtn[data-rating="check"]'), "true");
    assert.strictEqual(await page.inputValue("#t-used"), "Triage Song");
    await page.keyboard.press("ArrowLeft");
    assert.strictEqual((await page.textContent("#triage-card h4")).trim(), "Inbox two");
    await page.keyboard.press("ArrowRight");                                                 // save card 2 now
    await page.waitForFunction(() => document.querySelector("#triage-card h4").textContent.trim() === "Inbox three");
    assert.strictEqual((await byTitle("Inbox two")).status, "tagged");
    await page.keyboard.press("ArrowRight");                                                 // card 3 again (unchanged), on to card 4
    await page.waitForFunction(() => document.querySelector("#triage-card h4").textContent.trim() === "Inbox four");
    await page.keyboard.press("x");                                                          // marked, but then skipped: not saved
    await page.keyboard.press("s");
    await page.waitForFunction(() => /whole Inbox/.test(document.querySelector("#triage-card").textContent));
    assert.match(await card.innerText(), /Saved 3 recordings to the Library, left 1 in the Inbox\./);
    assert.strictEqual((await byTitle("Inbox four")).rating, null, "a skipped card is left exactly as it was");
    await page.click("#triage-card button.primary");
    await page.waitForSelector("#browser:not([hidden])");
    assert.ok(await page.isHidden("#triage"));
    await page.waitForFunction(() => document.querySelector("#tab-inbox").textContent.trim() === "Inbox (1)");
    await waitSet(["Inbox four"], "only the skipped one is left in the Inbox");
    assert.strictEqual((await page.textContent("#triage-start")).trim(), "Triage the Inbox (1)");
    console.log("ok  triage: autoplay, tag/mark/notes keys, typing is safe, save/skip/back, summary, only the skipped card remains");

    // Escape leaves triage
    await page.click("#triage-start");
    await page.waitForSelector("#triage:not([hidden])");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#browser:not([hidden])");
    assert.ok(await page.isHidden("#triage"));
    assert.ok(await page.evaluate(() => document.querySelector("#player").paused), "leaving triage stops the audio");
    console.log("ok  Escape leaves triage and stops the audio");

    // --- phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#triage-start");
    await page.waitForSelector("#triage:not([hidden])");
    const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: [...document.querySelectorAll("#triage-card button")].filter((b) => b.getBoundingClientRect().height < 34).length }));
    assert.ok(m.over <= 1, "triage card widens the page by " + m.over);
    assert.strictEqual(m.small, 0, "every triage button is at least 34px tall");
    await page.screenshot({ path: path.join(tmp, "triage-phone.png") });
    await page.click("#triage-exit");
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("ok  triage card fits a phone screen");

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
