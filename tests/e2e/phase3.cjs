// Phase 3 browser test. Run:  RIFFBOX_PY=/path/to/python node tests/e2e/phase3.cjs
// Serves the app under /ideas (like production) and drives it with Chromium.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8199, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-"));

function wav(freq, seconds = 3, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const files = { a: path.join(tmp, "Bass riff.wav"), b: path.join(tmp, "Hummed melody.wav"), dup: path.join(tmp, "copy of bass.wav") };
fs.writeFileSync(files.a, wav(110)); fs.writeFileSync(files.b, wav(440)); fs.copyFileSync(files.a, files.dup);

const server = spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${PORT}`, "wsgi:app"], {
  cwd: path.join(ROOT, "app"),
  env: { ...process.env, RIFFBOX_DATA_DIR: path.join(tmp, "data"), RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok",
         RIFFBOX_PASSPHRASE: "open sesame", RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas",
         RIFFBOX_STATIC_DIR: path.join(ROOT, "static") },
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
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    let expected401 = 0, expected429 = 0;   // deliberate failures: see the comments where they happen
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (m.text().includes("401")) { expected401++; return; }
      if (m.text().includes("429")) { expected429++; return; }
      problems.push("console: " + m.text());
    });

    // login
    await page.goto(BASE.slice(0, -1));                      // /ideas (no slash) must redirect
    assert.ok(page.url().endsWith("/ideas/"), "bare /ideas redirects to /ideas/");
    await page.waitForSelector("#login:not([hidden])");
    await page.fill("#pass", "wrong"); await page.click("#login-form button");
    await page.waitForSelector("#login-error:not([hidden])");
    await page.fill("#pass", "open sesame"); await page.click("#login-form button");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForSelector("#empty:not([hidden])");
    console.log("ok  login (wrong then right passphrase), empty state");

    // upload: two new files and one byte-identical duplicate
    await page.setInputFiles("#file", [files.a, files.b, files.dup]);
    await page.waitForFunction(() => document.querySelectorAll("#queue .state.ok, #queue .state.bad").length === 3);
    const states = await page.$$eval("#queue li", (lis) => lis.map((l) => l.querySelector(".name").textContent + "=" + l.querySelector(".state").textContent));
    assert.deepStrictEqual(states.sort(), ["Bass riff.wav=Uploaded", "Hummed melody.wav=Uploaded", "copy of bass.wav=Already have it"].sort());
    await page.waitForFunction(() => document.querySelectorAll("#list li").length === 2);
    assert.strictEqual(await page.textContent("#count"), "(2)");
    console.log("ok  upload 2 files + duplicate detected; list shows 2");

    // titles come from the generated default, status chip shows inbox
    const titles = await page.$$eval("#list .title", (n) => n.map((x) => x.textContent));
    assert.ok(titles.every((t) => t.startsWith("Idea, ")), "default titles: " + titles);
    assert.strictEqual((await page.$$("#list .chip")).length, 2);

    // playback
    const first = page.locator("#list li").first().locator(".play");
    await first.click();
    await page.waitForFunction(() => { const a = document.querySelector("#player"); return !a.paused && a.currentTime > 0.2; }, null, { timeout: 5000 });
    assert.match(await first.getAttribute("aria-label"), /^Pause /);
    await first.click();
    await page.waitForFunction(() => document.querySelector("#player").paused);
    console.log("ok  play advances currentTime; pause works");

    // download link
    const href = await page.locator("#list li").first().locator("a.dl").getAttribute("href");
    assert.ok(href.endsWith("?download=1"));
    const dl = await ctx.request.get(new URL(href, BASE).toString());
    assert.match(dl.headers()["content-disposition"], /attachment/);
    console.log("ok  download link returns attachment");

    // persistence + logout
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#list li").length === 2);
    await page.screenshot({ path: path.join(tmp, "mobile.png") });
    await page.click("#logout"); await page.waitForSelector("#login:not([hidden])");
    assert.strictEqual((await ctx.request.get(BASE + "api/recordings")).status(), 401);
    console.log("ok  reload keeps session; logout ends it");

    // lockout: a successful login clears the failure count, so five fresh wrong attempts reach the
    // limit; the next attempt (even with the right passphrase) must be refused with a clear message.
    const attempt = async (pass) => {
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("api/login")),
        (async () => { await page.fill("#pass", pass); await page.click("#login-form button"); })(),
      ]);
      return resp.status();
    };
    for (let i = 0; i < 5; i++) assert.strictEqual(await attempt("wrong"), 401);
    assert.strictEqual(await attempt("open sesame"), 429);
    await page.waitForFunction(() => /Too many wrong attempts/.test(document.querySelector("#login-error").textContent));
    assert.ok(await page.isHidden("#app"), "still logged out while locked");
    console.log("ok  lockout after 5 wrong attempts shows a message and refuses even the right passphrase");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    // 401s: logged-out session check on load, first wrong passphrase, five more wrong ones.
    assert.strictEqual(expected401, 7, "expected exactly seven 401s, got " + expected401);
    assert.strictEqual(expected429, 1, "expected exactly one 429, got " + expected429);
    console.log("ok  no unexpected console or page errors");
    console.log("screenshot:", path.join(tmp, "mobile.png"));
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
