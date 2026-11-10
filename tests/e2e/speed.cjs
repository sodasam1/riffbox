// Groups, stage 4: arrow keys through ideas and their parts (auto-open, auto-close, hand-opened stays open), Random, select, triage. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/speed.cjs
const { launch } = require("./_browser.cjs");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8217, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-speed-"));

function wav(freq, seconds = 6, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}

const server = spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${PORT}`, "wsgi:app"], {
  cwd: path.join(ROOT, "app"),
  env: { ...process.env, RIFFBOX_DATA_DIR: path.join(tmp, "data"), RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok",
         RIFFBOX_PASSPHRASE: "open sesame", RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas",
         RIFFBOX_STATIC_DIR: path.join(ROOT, "static"), RIFFBOX_FFMPEG: "" },
  stdio: "inherit",
});
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "health")).ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

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
