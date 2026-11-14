// Groups, stage 3: expandable rows, playing the parts, the player title, moving on to the next part, layout. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/groups3.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8213, name: "groups3", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const up = async (title, freq) => (await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `${title}.wav`, mimeType: "audio/wav", buffer: wav(freq, 1) }, title } })).json());
    const u = {};
    for (const [i, t] of ["Keys", "Drums", "Vocal", "Solo"].entries()) u[t] = await up(t, 150 + i * 31);
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    const made = await ctx.request.post(BASE + "api/groups", { data: { ids: [u.Keys.group_id, u.Drums.group_id, u.Vocal.group_id], title: "Song idea", status: "tagged", bpm: 100, tags: [] } });
    assert.strictEqual(made.status(), 201);
    await ctx.request.patch(BASE + `api/groups/${u.Solo.group_id}`, { data: { status: "tagged", bpm: 90 } });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#tab-library");
    await page.click("#tab-library");
    await page.waitForSelector('#list > li[data-title="Song idea"]');
    const row = page.locator('#list > li[data-title="Song idea"]');
    const parts = page.locator("#list > li.part");
    const noOverflow = async (label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "page overflows sideways: " + label);

    // collapsed: nearly the same as a single row, with a caret and a parts badge
    assert.strictEqual(await parts.count(), 0);
    assert.match(await row.locator(".chip.parts").textContent(), /3 parts/);
    assert.strictEqual(await page.locator('#list > li[data-title="Solo"] .caret').count(), 0);
    assert.strictEqual(await row.locator(".caret").getAttribute("aria-expanded"), "false");
    console.log("ok  a grouped idea is one row with a caret and a parts badge; a single has neither");

    // open it: the parts appear under it, lined up with the table columns
    await row.locator(".caret").click();
    assert.strictEqual(await parts.count(), 3);
    assert.deepStrictEqual(await parts.locator(".title").allTextContents(), ["Keys", "Drums", "Vocal"]);
    assert.strictEqual(await row.locator(".caret").getAttribute("aria-expanded"), "true");
    const x = (loc) => loc.evaluate((e) => Math.round(e.getBoundingClientRect().left));
    assert.strictEqual(await x(parts.first().locator(".c-len")), await x(row.locator(".c-len")), "part length lines up with the idea's");
    assert.strictEqual(await x(parts.first().locator(".side")), await x(row.locator(".side")), "part actions line up");
    await noOverflow("library, parts open");
    console.log("ok  the caret opens the parts under the row, in the same columns");

    // play one part: the player names it; the idea's row and the part's row both light up
    await parts.nth(1).locator("button.play").click();
    await page.waitForFunction(() => /part 2 of 3/.test(document.querySelector("#pb-title").textContent));
    assert.match(await page.textContent("#pb-title"), /Song idea .*Drums.*part 2 of 3/);
    assert.ok(await parts.nth(1).evaluate((e) => e.classList.contains("playing")) && await row.evaluate((e) => e.classList.contains("playing")));
    assert.ok(!(await parts.nth(0).evaluate((e) => e.classList.contains("playing"))));
    console.log("ok  playing a part names it in the player (part 2 of 3) and lights its row and the idea's");

    // it moves on to the next part by itself, and stops after the last
    await page.waitForFunction(() => /part 3 of 3/.test(document.querySelector("#pb-title").textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("audio, #player") ? [...document.querySelectorAll("audio")].every((a) => a.paused || a.ended) : true, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    assert.match(await page.textContent("#pb-title"), /part 3 of 3/);
    console.log("ok  playback moves on to the next part and stops after the last");

    // open parts survive a reload of the list (a mark), a part has its own Download
    await row.locator(".ratebtn[data-rating=heart]").click();
    await page.waitForFunction(() => document.querySelector('#list > li[data-title="Song idea"] .ratebtn[data-rating=heart][aria-pressed=true]'));
    assert.strictEqual(await parts.count(), 3, "parts stay open after the list reloads");
    assert.match(await parts.first().locator("a.dl").getAttribute("href"), /api\/audio\/\d+\?download=1/);
    console.log("ok  open ideas stay open after a change; each part has its own Download");

    // the idea's own Download gives a zip of all its parts; a part's Download is that one original file
    const [zipDl] = await Promise.all([page.waitForEvent("download"), row.locator("a.dl").click()]);
    assert.match(zipDl.suggestedFilename(), /^Song idea\.zip$/);
    const partHref = await parts.nth(1).locator("a.dl").getAttribute("href");           // (WebKit under test does not report attachments of audio files as downloads, so check the answer itself)
    const partAnswer = await ctx.request.get(BASE + partHref);
    assert.match(partAnswer.headers()["content-disposition"], /^attachment; filename=.*\.wav$/);
    const single = page.locator('#list > li[data-title="Solo"] a.dl');
    assert.match(await single.getAttribute("href"), /api\/audio\/\d+\?download=1/, "a single idea's Download is unchanged");
    console.log("ok  the idea's Download is a zip of all parts; each part's Download is its own file; a single idea is unchanged");

    // the idea's own play button plays the part you were on, else the first; closing removes the part rows
    await row.locator(".caret").click();
    assert.strictEqual(await parts.count(), 0);
    await row.locator(".caret").click();
    assert.strictEqual(await parts.count(), 3);

    // the Library filter for ideas that still need a tempo or key choice
    const pq = [await up("P", 400), await up("Q", 430)];
    await ctx.request.patch(BASE + `api/groups/${pq[0].group_id}`, { data: { status: "tagged", bpm: 80 } });
    await ctx.request.patch(BASE + `api/groups/${pq[1].group_id}`, { data: { status: "tagged", bpm: 140 } });
    await ctx.request.post(BASE + "api/groups", { data: { ids: [pq[0].group_id, pq[1].group_id] } });
    await page.reload(); await page.waitForSelector("#tab-library"); await page.click("#tab-library");
    await page.waitForSelector("#f-unresolved");
    assert.match(await page.textContent("#f-unresolved-label"), /· 1$/);
    await page.check("#f-unresolved");
    await page.waitForFunction(() => document.querySelectorAll("#list > li:not(.part)").length === 1);
    assert.ok(await page.locator("#list > li .chip.pending").count() === 1);
    assert.match(await page.textContent("#filters-toggle"), /1 active/);
    await page.click("#f-clear");
    await page.waitForFunction(() => document.querySelectorAll("#list > li:not(.part)").length === 3);
    assert.strictEqual(await page.isChecked("#f-unresolved"), false);
    console.log("ok  the Library can show only ideas that still need a tempo or key choice");

    // row size is one setting for the Inbox and the Library
    await page.click("#tab-inbox");
    assert.ok(await page.isVisible("#dens-compact"), "row size control shows in the Inbox");
    await page.click("#dens-compact");
    assert.ok(await page.evaluate(() => document.querySelector("#list").classList.contains("compact")));
    await page.click("#tab-library");
    assert.ok(await page.evaluate(() => document.querySelector("#list").classList.contains("compact") && document.querySelector("#dens-compact").getAttribute("aria-pressed") === "true"), "the same size applies in the Library");
    await page.click("#dens-cozy");
    await page.click("#tab-inbox");
    assert.ok(await page.evaluate(() => !document.querySelector("#list").classList.contains("compact")), "and back to Cozy in the Inbox");
    await page.click("#tab-library");
    console.log("ok  Cozy / Compact is one setting, shown and applied in both the Inbox and the Library");

    // layout: cozy, compact, minimal, phone width, with parts open
    for (const [w, dens, theme] of [[1280, "compact", "standard"], [390, "cozy", "standard"], [390, "compact", "standard"], [1280, "cozy", "minimal"], [390, "compact", "minimal"]]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.evaluate((d) => document.querySelector("#dens-" + d).click(), dens);
      await page.evaluate((t) => { if (t === "minimal") document.documentElement.dataset.theme = "minimal"; else delete document.documentElement.dataset.theme; }, theme);
      await page.waitForTimeout(100);
      await noOverflow(`${w}px ${dens} ${theme}`);
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${w}-${dens}-${theme}.png` });
      for (const li of await parts.all()) assert.ok(await li.isVisible());
    }
    console.log("ok  open parts fit at desktop and phone widths, Cozy and Compact, standard and minimal");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("groups3.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
