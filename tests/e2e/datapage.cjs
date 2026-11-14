// Backup and export page: header link, zip download, trash switch, Back up now, phone layout. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/datapage.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, wav, server, waitUp, launch: launchBrowser, assert, fs, os, path, startServer } = setup({
  port: 8197, name: "data", wavSeconds: 6, env: (tmp, path) => ({ RIFFBOX_BACKUP_DIR: path.join(tmp, "backup") }) });
const PORT2 = 8198, BASE2 = `http://127.0.0.1:${PORT2}/ideas/`;
const server2 = startServer({ port: PORT2, data: path.join(tmp, "data2") });   // a second server with no backup folder

(async () => {
  let browser, failed = false;
  try {
    await waitUp(BASE); await waitUp(BASE2);
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US", acceptDownloads: true });
    for (const [i, title] of ["Alpha riff", "Beta riff", "Deleted riff"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    await ctx.request.patch(BASE + "api/recordings/1", { data: { status: "tagged", tags: ["bass"], notes: "first notes" } });
    await ctx.request.delete(BASE + "api/recordings/3");
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");

    // the link sits in the Menu, with "How this works" and "Log out"
    await page.click("#menu-btn");
    const order = await page.evaluate(() => [...document.querySelectorAll("#menu > *")].map((n) => n.textContent.trim()));
    assert.deepStrictEqual(order.map((s) => s.replace(/\s+/g, "")), ["Backupandexport", "Howthisworks", "StyleStandardMinimal", "ColorsAutoLightDark", "Logout"]);
    await page.click("#data-link");
    assert.ok(await page.isHidden("#menu"), "choosing an item closes the menu");
    await page.waitForSelector("#data-view:not([hidden])");
    assert.ok(await page.isHidden("#main-view") && await page.isHidden("#how-view"));
    assert.strictEqual(new URL(page.url()).hash, "#data");
    await page.waitForFunction(() => /2 recordings/.test(document.querySelector("#data-summary").textContent));
    assert.match(await page.textContent("#data-summary"), /2 recordings \(plus 1 in the Trash\)/);
    console.log("ok  header link opens the page; it shows the library size");

    // the zip download
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#data-zip")]);
    assert.match(dl.suggestedFilename(), /^riffbox-export-\d{8}\.zip$/);
    const zipPath = path.join(tmp, "dl.zip");
    await dl.saveAs(zipPath);
    const listing = require("child_process").execFileSync(PY, ["-I", "-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(z.namelist()))", zipPath]).toString();
    assert.ok(/index\.html/.test(listing) && /riffbox\.db/.test(listing) && /manifest-sha256\.txt/.test(listing));
    assert.strictEqual((listing.match(/\.md$/gm) || []).length, 2, "trash is left out by default");
    await page.check("#data-trash");
    assert.match(await page.getAttribute("#data-zip", "href"), /trash=1/);
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#data-zip")]);
    await dl2.saveAs(path.join(tmp, "dl2.zip"));
    const n2 = require("child_process").execFileSync(PY, ["-I", "-c",
      "import sys,zipfile;print(sum(n.endswith('.md') for n in zipfile.ZipFile(sys.argv[1]).namelist()))", path.join(tmp, "dl2.zip")]).toString().trim();
    assert.strictEqual(n2, "3", "the switch adds the Trash");
    const [dl3] = await Promise.all([page.waitForEvent("download"), page.click("#data-db")]);
    assert.match(dl3.suggestedFilename(), /^riffbox-\d{8}\.db$/);
    console.log("ok  zip downloads work (with and without the Trash); so does the database-only download");

    // Back up now
    assert.match(await page.textContent("#backup-state"), /No backup yet\. 3 audio files/);
    await page.click("#backup-now");
    await page.waitForFunction(() => /Last backup: just now/.test(document.querySelector("#backup-state").textContent), null, { timeout: 15000 });
    assert.match(await page.textContent("#backup-state"), /All 3 audio files are backed up/);
    assert.match(await page.textContent("#backup-msg"), /3 new audio/);
    assert.ok(await page.isEnabled("#backup-now"));
    console.log("ok  Back up now runs and the page reports it");

    // phone widths
    for (const w of [320, 375, 430]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(100);
      const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        navRight: document.querySelector("#menu-btn").getBoundingClientRect().right, vw: innerWidth }));
      assert.ok(o.over <= 1 && o.navRight <= o.vw, `data page at ${w}px: ${o.over}px too wide, nav ends at ${Math.round(o.navRight)}`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("ok  no sideways scrolling at 320, 375 and 430 px (header included)");

    // navigation: Back, reload, logout
    await page.reload();
    await page.waitForSelector("#data-view:not([hidden])");
    await page.click("#data-back");
    await page.waitForSelector("#main-view:not([hidden])");
    assert.ok(await page.isHidden("#data-view"));
    await page.goto(BASE + "#data"); await page.reload();
    await page.waitForSelector("#data-view:not([hidden])");
    await page.click("#menu-btn"); await page.click("#logout");
    await page.waitForSelector("#login:not([hidden])");
    assert.strictEqual(new URL(page.url()).hash, "");
    console.log("ok  Back link, reload and log out behave");

    // a server with no backup folder: the button is replaced by an explanation
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx2.request.post(BASE2 + "api/login", { data: { passphrase: "open sesame" } });
    const page2 = await ctx2.newPage();
    await page2.goto(BASE2 + "#data");
    await page2.waitForSelector("#data-view:not([hidden])");
    await page2.waitForSelector("#backup-off:not([hidden])");
    assert.ok(await page2.isHidden("#backup-on"));
    console.log("ok  without a backup folder the page explains how to switch the button on");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill(); server2.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
