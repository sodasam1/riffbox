// Stable layout on desktop: moving between Inbox, Library and Resurface must not move the header, the upload bar, the tab
// row (including Random), or the list column. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/stable.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8204, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-stable-"));

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
    const titles = ["Inbox one", "Inbox two", "Lib one", "Lib two", "Lib three", "Heart one", "Trashed one"];
    for (const [i, title] of titles.entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 19) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (let id = 3; id <= 6; id++) await ctx.request.patch(BASE + `api/recordings/${id}`, { data: { status: "tagged", tags: ["bass", "keys"], notes: "n", bpm: 100 + id, rating: id === 6 ? "heart" : null } });
    await ctx.request.delete(BASE + "api/recordings/7");
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");

    const SELECTORS = ["header h1", "#menu-btn", "#pick", "#tab-inbox", "#tab-library", "#tab-resurface", "#dens-cozy", "#dens-compact", "#select-toggle", "#random", "#tab-trash", "#browser", "#results"];
    const measure = () => page.evaluate((sels) => Object.fromEntries(sels.map((s) => { const r = document.querySelector(s).getBoundingClientRect();
      return [s, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]]; })), SELECTORS);
    for (const w of [900, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width: w, height: 900 });
      const seen = {};
      for (const view of ["inbox", "library", "resurface", "inbox", "library"]) {
        await page.click("#tab-" + view);
        await page.waitForFunction((v) => document.querySelector("#tab-" + v).getAttribute("aria-pressed") === "true", view);
        await page.waitForTimeout(250);
        seen[view + "@" + Object.keys(seen).length] = await measure();
      }
      const all = Object.values(seen);
      for (const sel of SELECTORS) {
        const first = all[0][sel];
        for (const [i, m] of all.entries()) {
          for (let k = 0; k < (sel === "#browser" || sel === "#results" ? 3 : 4); k++) {          // a list's height is its content
            assert.ok(Math.abs(m[sel][k] - first[k]) <= 1, `at ${w}px, ${sel} moved between tabs: ${JSON.stringify(first)} -> ${JSON.stringify(m[sel])} (view ${Object.keys(seen)[i]})`);
          }
        }
      }
    }
    console.log("ok  header, upload bar, tab row (Random and the Library tools included), and the list column stay put when switching tabs, from 900 to 1920px");

    // the controls that do not apply to a tab are invisible placeholders on desktop, not gaps that move things
    await page.setViewportSize({ width: 1280, height: 900 });
    const vis = {};
    for (const view of ["inbox", "library", "resurface"]) {
      await page.click("#tab-" + view); await page.waitForTimeout(150);
      vis[view] = await page.evaluate(() => Object.fromEntries(["#random", "#dens-cozy", "#select-toggle"].map((s) => [s, getComputedStyle(document.querySelector(s)).visibility])));
    }
    assert.deepStrictEqual(vis, {
      inbox: { "#random": "visible", "#dens-cozy": "hidden", "#select-toggle": "hidden" },
      library: { "#random": "visible", "#dens-cozy": "visible", "#select-toggle": "visible" },
      resurface: { "#random": "hidden", "#dens-cozy": "hidden", "#select-toggle": "hidden" } });
    for (const s of ["#random", "#dens-cozy"]) assert.ok(await page.isHidden(s), s + " should not be usable on Resurface");
    console.log("ok  Random shows on Inbox and Library, the row-size and Select controls on Library only, always in the same slots");

    // the left column holds each tab's own controls, in the same place
    const left = {};
    for (const [view, sel] of [["inbox", "#side-inbox"], ["library", "#filters"], ["resurface", "#side-resurface"]]) {
      await page.click("#tab-" + view); await page.waitForTimeout(150);
      assert.ok(await page.isVisible(sel), view + " has its left-column panel");
      left[view] = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; }, sel);
    }
    assert.deepStrictEqual(left.inbox, left.library); assert.deepStrictEqual(left.resurface, left.library);
    assert.ok(await page.isVisible("#surprise") === true, "Surprise me lives in the Resurface panel");
    await page.click("#tab-inbox"); assert.ok(await page.isVisible("#triage-start"), "the triage button lives in the Inbox panel");
    await page.click("#tab-trash"); await page.waitForTimeout(150);
    assert.ok(await page.isVisible("#trash-note") && await page.isVisible("#side-trash"));
    console.log("ok  each tab keeps its own controls in the same left column (filters, triage, Surprise me, the Trash note)");

    // phone: the tabs stack as before and nothing overflows
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ["inbox", "library", "resurface", "trash"]) {
      await page.click("#tab-" + view); await page.waitForTimeout(120);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1, `${view} overflows on a phone`);
    }
    console.log("ok  phone layout still stacks and does not overflow");
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
