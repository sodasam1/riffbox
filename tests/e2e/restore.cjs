// Restoring from the Backup and export page: find a backup folder in the drop folder, restore into an empty library, then switch off.
//   RIFFBOX_PY=/path/to/python node tests/e2e/restore.cjs
const { setup } = require("./_helpers.cjs");
const { spawnSync } = require("child_process");

const { BASE, PY, ROOT, tmp, wav, server, waitUp, launch: launchBrowser, assert, fs, path, startServer } = setup({ port: 8233, name: "restore", wavSeconds: 3 });
const PORT2 = 8234, BASE2 = `http://127.0.0.1:${PORT2}/ideas/`;
const drop = path.join(tmp, "drop");
let server2;

(async () => {
  let browser, failed = false;
  try {
    await waitUp(BASE);
    const ctx0 = await (await launchBrowser()).newContext();
    for (const [i, title] of ["Alpha riff", "Beta riff"].entries()) {
      const r = await ctx0.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx0.browser().close();
    // the "old server": back it up the way deploy/backup.py does, into a folder inside the drop folder
    const b = spawnSync(PY, [path.join(ROOT, "deploy", "backup.py"), path.join(tmp, "data"), path.join(drop, "my-backup")], { encoding: "utf8" });
    assert.strictEqual(b.status, 0, b.stderr);
    server.kill();
    // the "new server": an empty library, with the drop folder set
    server2 = startServer({ port: PORT2, data: path.join(tmp, "data2"), env: { RIFFBOX_RESTORE_DIR: drop } });
    await waitUp(BASE2);

    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await ctx.request.post(BASE2 + "api/login", { data: { passphrase: "open sesame" } });     // signed in before the page loads, as the other scripts do
    await page.goto(BASE2);
    await page.waitForSelector("#app:not([hidden])");
    await page.goto(BASE2 + "#data");
    await page.waitForSelector("#restore-on:not([hidden])");
    await page.waitForFunction(() => /Found a backup with 2 recordings/.test(document.querySelector("#restore-state").textContent));
    assert.ok(await page.isEnabled("#restore-now"), "restoring is allowed into an empty library");
    console.log("ok  the page finds the backup and the library is empty");

    page.once("dialog", (d) => d.accept());
    await page.click("#restore-now");
    await page.waitForFunction(() => /Restored 2 recording/.test(document.querySelector("#restore-msg").textContent), null, { timeout: 20000 });
    await page.waitForFunction(() => /The library already has recordings|already has recordings/.test(document.querySelector("#restore-state").textContent));
    assert.ok(await page.isDisabled("#restore-now"), "after a restore the button is switched off");
    const d = await (await ctx.request.get(BASE2 + "api/data")).json();
    assert.strictEqual(d.recordings, 2);
    console.log("ok  restore ran, 2 recordings are back, and the button is now off");

    await page.goto(BASE2 + "#");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() => /Alpha riff/.test(document.body.textContent) && /Beta riff/.test(document.body.textContent));
    console.log("ok  the restored ideas are in the library");
    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill(); if (server2) server2.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
