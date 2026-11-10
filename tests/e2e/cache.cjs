// Groups, stage 4: arrow keys through ideas and their parts (auto-open, auto-close, hand-opened stays open), Random, select, triage. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/cache.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8216, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-cache-"));

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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const gids = [];
    for (const [i, t] of Array.from({ length: 40 }, (_, k) => "Idea number " + k).entries()) gids.push((await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `${t}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 13, 1) }, title: t } })).json()).group_id);
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const g of gids.slice(5)) await ctx.request.patch(BASE + `api/groups/${g}`, { data: { status: "tagged", bpm: 100, notes: require("crypto").randomBytes(150).toString("hex"), tags: ["keys", "bass"] } });
    // let the server's background work on the new uploads settle, so the lists are not changing under the test
    let last = "";
    for (let i = 0; i < 40; i++) {
      const tag = (await ctx.request.get(BASE + "api/groups?status=tagged")).headers()["etag"] + (await ctx.request.get(BASE + "api/groups?status=inbox")).headers()["etag"];
      if (tag === last) break;
      last = tag; await new Promise((r) => setTimeout(r, 500));
    }
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    let served = [];
    const net = new Map();
    cdp.on("Network.requestServedFromCache", (e) => served.push(e.requestId));
    cdp.on("Network.responseReceived", (e) => net.set(e.requestId, { url: e.response.url, enc: Object.entries(e.response.headers).find(([k]) => k.toLowerCase() === "content-encoding")?.[1], type: e.response.mimeType, status: e.response.status, cached: Boolean(e.response.fromDiskCache || e.response.fromPrefetchCache) }));
    const sent = new Map(), raw = new Map(), reqh = new Map();
    cdp.on("Network.requestWillBeSentExtraInfo", (e) => reqh.set(e.requestId, Object.keys(e.headers).filter((k) => /if-none|cache-control|pragma/i.test(k)).join(",")));
    cdp.on("Network.responseReceivedExtraInfo", (e) => raw.set(e.requestId, e.statusCode));
    cdp.on("Network.loadingFinished", (e) => sent.set(e.requestId, e.encodedDataLength));
    cdp.on("Network.requestWillBeSent", (e) => net.set(e.requestId, { ...(net.get(e.requestId) || {}), url: e.request.url }));

    // first visit: everything compressed, the page files fingerprinted
    await page.goto(BASE);
    await page.waitForSelector("#list > li");
    const first = [...net.values()].filter((r) => r.status);
    const get = (arr, part) => arr.find((r) => r.url.includes(part));
    for (const part of ["static/app.js?v=", "static/style.css?v=", "static/theme.js?v=", "api/groups"]) {
      const r = get(first, part);
      assert.ok(r, "requested " + part);
      assert.strictEqual(r.enc, "gzip", part + " is compressed");
    }
    assert.strictEqual(get(first, "/ideas/").enc, "gzip", "the page itself is compressed");
    console.log("ok  the page, its files and the lists arrive gzip-compressed");

    // second visit: the page files come from the browser's cache (no request goes out for them)
    served = []; net.clear();
    await page.goto(BASE + "?again");
    await page.waitForSelector("#list > li");
    const second = [...net.entries()].filter(([id, r]) => r.status && !r.cached && !served.includes(id)).map(([, r]) => r);          // what really went to the server
    assert.ok(!second.some((r) => /static\/app\.js/.test(r.url)), "app.js was not fetched again: " + JSON.stringify(second.map((r) => r.url)));
    assert.ok(!second.some((r) => /static\/style\.css/.test(r.url)), "style.css was not fetched again");
    console.log("ok  on the next visit the page files come from the browser's cache");
    // and the lists are re-checked but not sent again when nothing changed
    const statuses = [...net.entries()].filter(([id, r]) => /api\/groups\?status=/.test(r.url)).map(([id]) => raw.get(id));
    assert.ok(statuses.length >= 2 && statuses.every((c) => c === 304), "the lists were re-checked and answered 'not modified' (what the network saw: " + JSON.stringify([...net.entries()].filter(([id, r]) => /api\/groups\?status=/.test(r.url)).map(([id, r]) => [r.url.slice(-40), raw.get(id), reqh.get(id)])) + ")");
    console.log("ok  unchanged lists come back as 'not modified' (no body)");

    // a new version of a file is picked up at once: the page names a new fingerprint
    const before = await page.evaluate(() => document.querySelector('script[src*="app.js"]').getAttribute("src"));
    const fs = require("fs");
    const file = path.join(ROOT, "static", "app.js");
    const original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, original + "\n// a new version\n");
      await page.reload();
      await page.waitForSelector("#list > li");
      const after = await page.evaluate(() => document.querySelector('script[src*="app.js"]').getAttribute("src"));
      assert.notStrictEqual(before, after, "the fingerprint changed with the file");
    } finally { fs.writeFileSync(file, original); }
    console.log("ok  a changed file has a new address, so it is fetched straight away");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("cache.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
