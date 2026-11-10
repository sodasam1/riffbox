// Groups, stage 4: arrow keys through ideas and their parts (auto-open, auto-close, hand-opened stays open), Random, select, triage. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/speed.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8217, name: "speed", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push((await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(120 + i * 7, 1) }, title: "Idea " + i } })).json()).group_id);
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const g of ids) await ctx.request.patch(BASE + `api/groups/${g}`, { data: { status: "tagged", bpm: 100 } });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#tab-library");
    await page.click("#tab-library");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 40);
    await page.evaluate(() => { for (const li of document.querySelectorAll("#list > li")) li.__same = true; });
    const same = () => page.evaluate(() => [...document.querySelectorAll("#list > li")].every((li) => li.__same === true) && document.querySelectorAll("#list > li").length === 40);

    await page.click("#select-toggle");
    assert.ok(await same(), "Select mode did not redraw the rows");
    assert.ok(await page.locator(".rowsel:visible").count() >= 10, "the tick boxes are shown");
    await page.check("#bulk-all");
    assert.ok(await same(), "Select all did not redraw the rows");
    assert.match(await page.textContent("#bulk-count"), /^40 selected/);
    assert.strictEqual(await page.locator("#list > li.picked").count(), 40);
    await page.uncheck("#bulk-all");
    assert.strictEqual(await page.locator("#list > li.picked").count(), 0);
    await page.locator("#list > li .rowsel").nth(2).check();
    await page.locator("#list > li .rowsel").nth(4).click({ modifiers: ["Shift"] });
    assert.match(await page.textContent("#bulk-count"), /^3 selected/);
    await page.click("#bulk-done");
    assert.ok(await same(), "leaving Select mode did not redraw the rows");
    assert.strictEqual(await page.locator(".rowsel:visible").count(), 0);
    assert.strictEqual(await page.locator("#list > li.picked").count(), 0, "leaving Select mode clears the selection");
    await page.click("#dens-compact"); await page.click("#dens-cozy");
    assert.ok(await same(), "changing row size did not redraw the rows");
    console.log("ok  Select mode, Select all, shift-select, Done and Cozy/Compact work on the rows already drawn");

    // the work that remains is quick even with a long list (not a hard limit: this is a laboratory check on whatever machine runs it)
    const ms = await page.evaluate(async () => { const t = performance.now(); document.querySelector("#select-toggle").click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const d = performance.now() - t; document.querySelector("#select-toggle").click(); return d; });
    assert.ok(ms < 400, "Select mode took " + ms.toFixed(0) + " ms");
    console.log("ok  Select mode on 40 rows took " + ms.toFixed(0) + " ms");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("speed.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
