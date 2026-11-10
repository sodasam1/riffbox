// Groups, stage 4: arrow keys through ideas and their parts (auto-open, auto-close, hand-opened stays open), Random, select, triage. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/groups4.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8214, name: "groups4", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const up = async (title, freq) => (await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `${title}.wav`, mimeType: "audio/wav", buffer: wav(freq, 2) }, title } })).json());
    const u = {};
    for (const [i, t] of ["Z", "K1", "K2", "K3", "A", "I1", "I2"].entries()) u[t] = await up(t, 150 + i * 29);   // newest upload first: I, A, Song, Z
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const t of ["Z", "K1", "K2", "K3", "A"]) await ctx.request.patch(BASE + `api/groups/${u[t].group_id}`, { data: { status: "tagged", bpm: 100 } });
    const song = (await (await ctx.request.post(BASE + "api/groups", { data: { ids: [u.K1.group_id, u.K2.group_id, u.K3.group_id], title: "Song", bpm: 100 } })).json()).group;
    await ctx.request.post(BASE + "api/groups", { data: { ids: [u.I1.group_id, u.I2.group_id], title: "Inbox pair" } });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#tab-library");
    await page.click("#tab-library");
    await page.waitForSelector('#list > li[data-title="Song"]');
    await page.selectOption("#f-sort", "title");                          // A, Song, Z
    await page.waitForFunction(() => document.querySelector("#list > li").dataset.title === "A");
    assert.deepStrictEqual(await page.locator("#list > li").evaluateAll((l) => l.map((x) => x.dataset.title)), ["A", "Song", "Z"]);
    const parts = page.locator("#list > li.part");
    const title = () => page.textContent("#pb-title");
    const press = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(120); };
    const selectedText = () => page.evaluate(() => { const s = document.querySelector("#list > li.selected"); return s ? s.dataset.title : null; });

    // down through the list: a closed idea opens as you arrive, goes part by part, and closes when you leave
    await page.click('#list > li[data-title="A"] .title');
    await page.locator("#list").focus();
    await press("ArrowDown");
    assert.strictEqual(await parts.count(), 3, "arriving on Song opens it");
    assert.strictEqual(await selectedText(), "K1");
    assert.match(await title(), /part 1 of 3/);
    await press("ArrowDown"); assert.strictEqual(await selectedText(), "K2"); assert.match(await title(), /part 2 of 3/);
    await press("ArrowDown"); assert.strictEqual(await selectedText(), "K3"); assert.match(await title(), /part 3 of 3/);
    assert.strictEqual(await parts.count(), 3);
    await press("ArrowDown");
    assert.strictEqual(await selectedText(), "Z");
    assert.strictEqual(await parts.count(), 0, "leaving Song closes it again");
    console.log("ok  going down: a closed idea opens, steps through its parts one by one, and closes when you move on");

    // and up: it opens on its last part
    await press("ArrowUp");
    assert.strictEqual(await parts.count(), 3);
    assert.strictEqual(await selectedText(), "K3"); assert.match(await title(), /part 3 of 3/);
    await press("ArrowUp"); await press("ArrowUp");
    assert.strictEqual(await selectedText(), "K1");
    await press("ArrowUp");
    assert.strictEqual(await selectedText(), "A");
    assert.strictEqual(await parts.count(), 0);
    console.log("ok  going up: it opens on the last part, walks back to the first, then on to the previous idea");

    // opened by hand with the caret: it stays open when you move off it
    await page.locator('#list > li[data-title="Song"] .caret').click();
    assert.strictEqual(await parts.count(), 3);
    await page.click('#list > li[data-title="A"] .title');
    await page.locator("#list").focus();
    for (let i = 0; i < 5; i++) await press("ArrowDown");
    assert.strictEqual(await selectedText(), "Z");
    assert.strictEqual(await parts.count(), 3, "a hand-opened idea stays open");
    await press("ArrowUp");
    assert.strictEqual(await selectedText(), "K3");
    console.log("ok  an idea you opened by hand stays open after you move off it");

    // Space follows the highlighted part; marks go to the idea
    await press("Space");
    await page.waitForTimeout(200);
    await press("h");
    await page.waitForFunction(() => document.querySelector('#list > li[data-title="Song"] .ratebtn[data-rating=heart][aria-pressed=true]'));
    assert.strictEqual(await parts.count(), 3);
    console.log("ok  h hearts the whole idea while a part is highlighted; the list stays as it was");

    // closing by hand also wins over a hand-open
    await page.locator('#list > li[data-title="Song"] .caret').click();
    assert.strictEqual(await parts.count(), 0);

    // Random counts an idea once and starts it at its first part
    let sawSong = 0;
    for (let i = 0; i < 24 && !sawSong; i++) {
      await page.click("#random"); await page.waitForTimeout(80);
      if (/^Song/.test(await title())) { sawSong++; assert.match(await title(), /part 1 of 3/); }
    }
    assert.ok(sawSong, "Random picked the grouped idea at least once");
    console.log("ok  Random picks ideas (a group counts once) and starts a group at its first part");

    // Select: ticking a part ticks the idea; Select all counts ideas
    await page.click("#select-toggle");
    await page.locator('#list > li[data-title="Song"] .caret').click();
    await page.locator("#list > li.part").first().locator(".rowsel").check();
    assert.match(await page.textContent("#bulk-count"), /^1 selected/);
    assert.strictEqual(await page.locator("#list > li.part.picked").count(), 3, "every part of a picked idea shows as picked");
    await page.locator("#bulk-all").check();
    assert.match(await page.textContent("#bulk-count"), /^3 selected/);
    await page.click("#bulk-done");
    console.log("ok  ticking one part selects the whole idea; Select all counts ideas, not recordings");

    // triage shows the parts of an idea and plays them in order
    await page.click("#tab-inbox");
    await page.click("#triage-start");
    await page.waitForSelector("#triage-card h4");
    assert.match(await page.textContent("#triage-card"), /2 parts, played in order: I1 · I2/);
    await page.waitForFunction(() => /part 1 of 2/.test(document.querySelector("#pb-title").textContent));
    await page.waitForFunction(() => /part 2 of 2/.test(document.querySelector("#pb-title").textContent), null, { timeout: 15000 });
    console.log("ok  a triage card lists the parts and they play in order");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("groups4.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
