// Groups, stage 4: arrow keys through ideas and their parts (auto-open, auto-close, hand-opened stays open), Random, select, triage. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/groups5.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8215, name: "groups5", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const up = async (title, freq) => (await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `${title}.wav`, mimeType: "audio/wav", buffer: wav(freq, 2) }, title } })).json());
    const u = {};
    for (const [i, t] of ["Kick drum", "Bass line", "Lead", "Solo hit"].entries()) u[t] = await up(t, 150 + i * 31);
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const t of Object.keys(u)) await ctx.request.patch(BASE + `api/groups/${u[t].group_id}`, { data: { status: "tagged", rating: "heart", bpm: 100 } });
    const song = (await (await ctx.request.post(BASE + "api/groups", { data: { ids: [u["Kick drum"].group_id, u["Bass line"].group_id, u.Lead.group_id], title: "Chorus", bpm: 100, rating: "heart" } })).json()).group;
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#tab-resurface");

    // Resurface: a hearted idea comes back whole, with every part, and no caret to fold it
    await page.click("#tab-resurface");
    await page.waitForSelector('#list > li[data-title="Chorus"]');
    assert.strictEqual(await page.locator("#list > li.part").count(), 3, "every part is shown");
    assert.strictEqual(await page.locator('#list > li[data-title="Chorus"] .caret').count(), 0, "there is nothing to fold");
    assert.strictEqual(await page.locator("#list > li:not(.part)").count(), 2, "the idea counts once, beside the lone hearted one");
    console.log("ok  Resurface shows a hearted group whole, with all its parts, counted once");

    // arrows walk the parts there too
    await page.click('#list > li[data-title="Solo hit"] .title');
    await page.locator("#list").focus();
    const sel = () => page.evaluate(() => { const s = document.querySelector("#list > li.selected"); return s ? s.dataset.title : null; });
    const order = await page.locator("#list > li").evaluateAll((l) => l.map((x) => x.dataset.title));
    const at = order.indexOf("Solo hit");
    if (at === order.length - 1) { await page.keyboard.press("ArrowUp"); assert.strictEqual(await sel(), "Lead"); }
    else { await page.keyboard.press("ArrowDown"); assert.strictEqual(await sel(), "Kick drum"); }
    console.log("ok  arrow keys move through the parts in Resurface");

    // Surprise me plays an idea from its first part
    let saw = false;
    for (let i = 0; i < 20 && !saw; i++) {
      await page.click("#surprise"); await page.waitForTimeout(100);
      if (/^Chorus/.test(await page.textContent("#pb-title"))) { saw = true; assert.match(await page.textContent("#pb-title"), /part 1 of 3/); }
    }
    assert.ok(saw, "Surprise me picked the idea at least once");
    console.log("ok  Surprise me starts a group at its first part");

    // Library search: the idea is found by a part's name, and the row says which part matched
    await page.click("#tab-library");
    await page.waitForSelector('#list > li[data-title="Chorus"]');
    await page.fill("#f-q", "bass");
    await page.waitForFunction(() => document.querySelectorAll("#list > li:not(.part)").length === 1);
    assert.match(await page.textContent('#list > li[data-title="Chorus"] .notes'), /Matches part: Bass line/);
    await page.fill("#f-q", "chorus");
    await page.waitForFunction(() => document.querySelector('#list > li[data-title="Chorus"]') && !document.querySelector('#list > li[data-title="Chorus"] .notes'),
      null, { timeout: 5000 }).catch(() => { throw new Error("a part note stayed although the idea's own name matched"); });
    console.log("ok  search finds an idea by a part's name and says which part matched");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("groups5.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
