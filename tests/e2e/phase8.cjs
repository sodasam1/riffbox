// Phase 8 browser test: delete (two presses), the Trash tab, restore. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase8.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8196, name: "8", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const ids = {};
    for (const [i, title] of ["Keeper", "Doomed", "Inbox one"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const t of ["Keeper", "Doomed"]) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${ids[t]}`, { data: { status: "tagged", tags: ["bass"], notes: "keep my notes" } })).status(), 200);
    }
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    assert.ok(await page.isHidden("#tab-trash"), "no Trash tab while the Trash is empty");
    await page.click("#tab-library");
    const row = (t) => page.locator("#list > li", { hasText: t });

    // one press only asks
    await row("Doomed").locator("button.edit-btn").click();
    const del = page.locator("#list form.edit button.danger");
    await del.click();
    assert.match(await del.textContent(), /again/);
    await page.waitForTimeout(4300);
    assert.strictEqual((await del.textContent()).trim(), "Delete", "the question times out");
    assert.ok(await row("Doomed").count(), "one press must not delete");
    console.log("ok  one press on Delete only asks; it times out");

    // two presses delete
    await del.click(); await del.click();
    await page.waitForFunction(() => !document.querySelector("#list").innerText.includes("Doomed"));
    assert.ok(await row("Keeper").count(), "other recordings stay");
    assert.match(await page.textContent("#notice"), /Trash/);
    assert.strictEqual((await page.textContent("#tab-trash")).trim(), "Trash (1)");
    assert.match(await page.textContent("#tab-library"), /Library \(1\)/);
    console.log("ok  two presses move it to the Trash; counts update");

    // the Trash tab
    await page.click("#tab-trash");
    await page.waitForSelector("#list > li");
    assert.strictEqual(await page.locator("#list > li").count(), 1);
    assert.ok(await row("Doomed").locator("button.restore-btn").count());
    assert.strictEqual(await page.locator("#list .play").count(), 0, "nothing to play in the Trash");
    assert.ok(await page.locator("#filters").isHidden());
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, "Trash page is wider than the screen by " + over);
    for (const w of [320, 375, 430, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(100);
      const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        side: document.querySelector("#list .side").getBoundingClientRect().right, vw: innerWidth }));
      assert.ok(o.over <= 1 && o.side <= o.vw - 4, `Trash at ${w}px: page ${o.over}px too wide, Restore ends at ${Math.round(o.side)}`);
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Space");           // keys on a Trash row do nothing and do not crash
    console.log("ok  the Trash lists it with Restore only, no player and no filters");

    // restore
    await row("Doomed").locator("button.restore-btn").click();
    await page.waitForFunction(() => document.querySelector("#empty") && !document.querySelector("#empty").hidden);
    assert.match(await page.textContent("#notice"), /Restored to the Library/);
    await page.click("#tab-library");
    await page.waitForSelector("#list > li");
    assert.ok(await row("Doomed").count());
    const back = (await (await ctx.request.get(BASE + "api/groups?status=tagged")).json()).groups.find((r) => r.title === "Doomed");
    assert.deepStrictEqual([back.tags, back.notes], [["bass"], "keep my notes"]);
    assert.ok(await page.isHidden("#tab-trash"));
    console.log("ok  restore brings it back with its tags and notes");

    // an Inbox item can be deleted too, and the open form closes
    await page.click("#tab-inbox");
    await row("Inbox one").locator("button.edit-btn").click();
    await page.locator("#list form.edit button.danger").dblclick();
    await page.waitForFunction(() => document.querySelector("#empty") && !document.querySelector("#empty").hidden);
    assert.strictEqual((await page.textContent("#tab-trash")).trim(), "Trash (1)");
    console.log("ok  an Inbox recording can be deleted too");
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
