// The Trash: Restore still works, "Delete forever" removes one idea after a confirmation, "Empty Trash" removes the rest after a confirmation, and
// cancelling a confirmation changes nothing. Run:  RIFFBOX_PY=/path/to/python node tests/e2e/trash.cjs
const { setup } = require("./_helpers.cjs");

const { BASE, wav, server, waitUp, launch: launchBrowser, assert } = setup({ port: 8237, name: "trash", wavSeconds: 3 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp(BASE);
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    for (const [i, title] of ["Alpha", "Beta", "Gamma", "Delta"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const id of [1, 2, 3]) await ctx.request.delete(BASE + "api/recordings/" + id);          // Delta stays in the Inbox
    const trashed = async () => (await (await ctx.request.get(BASE + "api/trash")).json()).groups.map((g) => g.title);
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForSelector("#tab-trash:not([hidden])");
    await page.click("#tab-trash");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 3);
    assert.match(await page.textContent("#trash-empty"), /Empty Trash \(3\)/);
    console.log("ok  the Trash lists the three deleted ideas, and Empty Trash shows how many");

    // cancelling a confirmation changes nothing
    const dialogs = [];
    page.on("dialog", async (d) => { dialogs.push(d.message()); if (dialogs.length === 1) await d.dismiss(); else await d.accept(); });
    const row = page.locator("#list > li", { hasText: "Alpha" });
    await row.locator("button.purge-btn").click();
    await page.waitForTimeout(400);
    assert.strictEqual((await trashed()).length, 3, "cancel keeps everything");
    assert.match(dialogs[0], /forever/);
    console.log("ok  cancelling the confirmation deletes nothing");

    // Delete forever on one idea
    await row.locator("button.purge-btn").click();
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 2);
    assert.deepStrictEqual((await trashed()).sort(), ["Beta", "Gamma"]);
    assert.strictEqual((await ctx.request.get(BASE + "api/audio/1")).status(), 404, "its audio is gone");
    assert.match(await page.textContent("#notice"), /Deleted forever/);
    console.log("ok  Delete forever removes that one idea and its audio");

    // Restore still works
    await page.locator("#list > li", { hasText: "Beta" }).locator("button.restore-btn").click();
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 1);
    console.log("ok  Restore still brings an idea back");

    // Empty Trash
    await page.click("#trash-empty");
    await page.waitForFunction(() => /The Trash is empty/.test(document.querySelector("#empty").textContent));
    assert.deepStrictEqual(await trashed(), []);
    assert.ok(await page.isDisabled("#trash-empty"), "nothing left to empty");
    assert.match(dialogs[dialogs.length - 1], /Delete everything in the Trash forever/);
    const d = await (await ctx.request.get(BASE + "api/data")).json();
    assert.strictEqual(d.trashed, 0);
    assert.strictEqual((await ctx.request.get(BASE + "api/audio/3")).status(), 404);
    console.log("ok  Empty Trash removes everything in it, and only that (the Inbox idea and the restored one are still there)");
    assert.ok((await ctx.request.get(BASE + "api/audio/4")).ok(), "Delta is untouched");
    assert.ok((await ctx.request.get(BASE + "api/audio/2")).ok(), "the restored Beta is untouched");

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
