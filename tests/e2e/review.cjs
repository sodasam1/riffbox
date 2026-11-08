// Review regression: a held-down or doubled Save key in triage must save one card, not skip the next. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/review.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8195, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-review-"));

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
    browser = await chromium.launch();
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
    await page.route("**/api/recordings/*", async (route) => {      // a slow server: the save is still in flight when the keys repeat
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
