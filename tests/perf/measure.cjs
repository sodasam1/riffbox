// Lab measurements of the page, to re-run before and after the changes in docs/PLAN-performance-ux-sustainability.md.
//   RIFFBOX_PY=/path/to/python [RIFFBOX_N=300] node tests/perf/measure.cjs
// Seeds N recordings (90% in the Library, 10% in the Inbox), then reports: static file sizes (raw/gzip/brotli), server
// response times and payloads, a throttled page load (4x CPU, about 1.6 Mbps, 150 ms round trip: a mid-range phone)
// with FCP, LCP, CLS, long tasks and the request list, and interaction times (click to next paint) with 4x CPU.
// These are LAB numbers: Core Web Vitals proper are field metrics, and a login-protected private app has no field data.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");

const PORT = 8291, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3", N = Number(process.env.RIFFBOX_N || 300);
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-perf-"));

function wav(freq, seconds = 1, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const server = spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${PORT}`, "--threads=4", "wsgi:app"], {
  cwd: path.join(ROOT, "app"), stdio: "ignore",
  env: { ...process.env, RIFFBOX_DATA_DIR: path.join(tmp, "data"), RIFFBOX_SECRET: "perf", RIFFBOX_UPLOAD_TOKEN: "tok", RIFFBOX_PASSPHRASE: "pw",
         RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas", RIFFBOX_STATIC_DIR: path.join(ROOT, "static"), RIFFBOX_FFMPEG: "" },
});

(async () => {
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "health")).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const sizes = {};
    for (const f of ["index.html", "app.js", "style.css", "theme.js"]) {
      const b = fs.readFileSync(path.join(ROOT, "static", f));
      sizes[f] = { raw: b.length, gzip: zlib.gzipSync(b).length, brotli: zlib.brotliCompressSync(b).length };
    }
    console.log("STATIC FILES (bytes)", JSON.stringify(sizes));
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const tags = ["bass", "drums", "keys", "guitar", "harmony", "vocal", "melody", "rhythmic idea", "full song"];
    for (let i = 0; i < N; i++) await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(100 + i) }, title: "Idea number " + i + " with a moderately long title" } });
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "pw" } });
    for (let i = 1; i <= N; i++) await ctx.request.patch(BASE + "api/recordings/" + i, { data: { status: i % 10 ? "tagged" : "inbox",
      tags: [tags[i % 9], tags[(i * 3) % 9]], notes: "Some notes about idea " + i, rating: i % 3 ? null : "heart", bpm: 60 + (i % 100), key_root: "A", key_mode: "minor" } });
    console.log(`seeded ${N} recordings`);
    for (const [label, url] of [["list library", "api/groups?status=tagged&sort=uploaded&order=desc&rating=heart,check,none"],
                                ["list inbox", "api/groups?status=inbox"], ["tags", "api/tags"], ["data page", "api/data"]]) {
      const runs = []; let body;
      for (let i = 0; i < 5; i++) { const t = performance.now(); body = await (await ctx.request.get(BASE + url)).body(); runs.push(performance.now() - t); }
      runs.sort((a, b) => a - b);
      console.log(`SERVER ${label}: median ${runs[2].toFixed(0)} ms, ${body.length} bytes (gzip ${zlib.gzipSync(body).length})`);
    }
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
    await page.addInitScript(() => {
      window.__cls = 0; window.__lcp = 0; window.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
    });
    const reqs = [];
    page.on("response", async (r) => { try { reqs.push([r.url().replace(BASE, ""), r.status(), Number(r.headers()["content-length"] || (await r.body()).length), r.headers()["cache-control"] || "none", r.headers()["content-encoding"] || "none"]); } catch (e) {} });
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#app:not([hidden])"); await page.waitForSelector("#list > li");
    await page.waitForTimeout(800);
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0], fcp = performance.getEntriesByName("first-contentful-paint")[0];
      return { ttfbMs: Math.round(n.responseStart), loadMs: Math.round(n.loadEventEnd), fcpMs: fcp ? Math.round(fcp.startTime) : null, lcpMs: Math.round(window.__lcp),
               cls: +window.__cls.toFixed(4), longTasksMs: window.__long, domNodes: document.querySelectorAll("*").length }; });
    console.log("PAGE LOAD (4x CPU, ~1.6 Mbps, 150 ms RTT):", JSON.stringify(nav));
    console.log("REQUESTS (bytes on the wire):\n" + reqs.map((r) => `  ${r[1]} ${String(r[2]).padStart(7)} B  ${r[0]}  [cache-control: ${r[3]}] [encoding: ${r[4]}]`).join("\n"));
    console.log("TOTAL ON THE WIRE:", reqs.reduce((a, r) => a + r[2], 0), "bytes in", reqs.length, "requests");
    // a repeat visit in the same browser
    reqs.length = 0;
    await page.goto(BASE + "?repeat", { waitUntil: "load" });
    await page.waitForSelector("#app:not([hidden])"); await page.waitForSelector("#list > li"); await page.waitForTimeout(500);
    const nav2 = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0], fcp = performance.getEntriesByName("first-contentful-paint")[0];
      return { loadMs: Math.round(n.loadEventEnd), fcpMs: fcp ? Math.round(fcp.startTime) : null, lcpMs: Math.round(window.__lcp) }; });
    console.log("REPEAT VISIT (page files and their fingerprints from the browser cache):", JSON.stringify(nav2));
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const inp = async (label, sel) => {
      const ms = await page.evaluate(async (s) => { const t = performance.now(); document.querySelector(s).click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; }, sel);
      console.log(`INTERACTION ${label}: ${ms.toFixed(0)} ms to next paint (good is 200 or less)`);
      await page.waitForTimeout(900);
    };
    await inp("open the Library tab", "#tab-library");
    await inp("switch to Compact", "#dens-compact");
    await inp("switch to Cozy", "#dens-cozy");
    await inp("turn Select mode on", "#select-toggle");
    await inp("Select all", "#bulk-all");
    await inp("open the Menu", "#menu-btn");
    console.log("JS HEAP (MB):", await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
