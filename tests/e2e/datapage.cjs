// Backup and export page: header link, zip download, trash switch, Back up now, phone layout. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/datapage.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8197, PORT2 = 8198, BASE = `http://127.0.0.1:${PORT}/ideas/`, BASE2 = `http://127.0.0.1:${PORT2}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-data-"));

function wav(freq, seconds = 6, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}

function launch(port, dataDir, extra) {
  return spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${port}`, "wsgi:app"], {
    cwd: path.join(ROOT, "app"),
    env: { ...process.env, RIFFBOX_DATA_DIR: dataDir, RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok",
           RIFFBOX_PASSPHRASE: "open sesame", RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas",
           RIFFBOX_STATIC_DIR: path.join(ROOT, "static"), RIFFBOX_FFMPEG: "", ...extra },
    stdio: "inherit",
  });
}
const server = launch(PORT, path.join(tmp, "data"), { RIFFBOX_BACKUP_DIR: path.join(tmp, "backup") });
const server2 = launch(PORT2, path.join(tmp, "data2"), {});
async function waitUp(base) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "health")).ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

(async () => {
  let browser, failed = false;
  try {
    await waitUp(BASE); await waitUp(BASE2);
    browser = await chromium.launch();
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

    // the link sits at the top, right next to "How this works"
    const order = await page.evaluate(() => [...document.querySelectorAll("header nav > *")].map((n) => n.textContent.trim()));
    assert.deepStrictEqual(order, ["Backup and export", "How this works", "Log out"]);
    await page.click("#data-link");
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
        navRight: document.querySelector("header nav").getBoundingClientRect().right, vw: innerWidth }));
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
    await page.click("#logout");
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
