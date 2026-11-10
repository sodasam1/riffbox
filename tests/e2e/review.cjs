// Review regression: a held-down or doubled Save key in triage must save one card, not skip the next. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/review.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8195, name: "review", wavSeconds: 6 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    for (let i = 0; i < 4; i++) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title: "Card " + (i + 1) } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    await page.goto(BASE);
    await page.waitForSelector("#triage-start:not([hidden])");
    let patches = 0;
    await page.route("**/api/groups/*", async (route) => {      // a slow server: the save is still in flight when the keys repeat
      if (route.request().method() === "PATCH") { patches++; await new Promise((r) => setTimeout(r, 600)); }
      await route.continue();
    });
    await page.click("#triage-start");
    await page.waitForSelector("#triage-card h4");
    const first = (await page.textContent("#triage-card h4")).trim();
    await page.evaluate(() => {                                    // key auto-repeat: three presses before the first answer
      for (let i = 0; i < 3; i++) document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await page.waitForFunction((t) => document.querySelector("#triage-card h4") && document.querySelector("#triage-card h4").textContent.trim() !== t, first);
    await page.waitForTimeout(1500);
    assert.strictEqual((await page.textContent("#triage-pos")).trim(), "2 of 4", "repeated Save keys skipped a card");
    assert.strictEqual(patches, 1, "the same card was saved " + patches + " times");
    console.log("ok  holding the Save key saves one card and shows the next");
    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
