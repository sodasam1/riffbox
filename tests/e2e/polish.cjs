// Layout and polish regressions found in the second review (player bar vs long titles, the Library table at
// 900-1120px, the date field, tap targets, scrolling past the player, text contrast). Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/polish.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8201, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-polish-"));

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

const LONG = "Averyveryveryverylongtitlewithoutanyspacesatalleveryletterrunstogetherandkeepsgoingforaverylongtimeindeed1234567890";
function lum(hex) { hex = hex.replace("#", ""); if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
  const c = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const titles = [LONG, "Second idea", "Third idea", "Fourth idea", "Fifth idea", "Sixth idea", "Seventh idea", "Eighth idea", "Ninth idea", "Tenth idea"];
    for (const [i, title] of titles.entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 19) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (let id = 1; id <= titles.length; id++) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${id}`, { data: { status: "tagged", tags: ["bass", "keys"], notes: "notes " + id, rating: id % 2 ? "heart" : null } })).status(), 200);
    }
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-library");
    await page.waitForSelector("#list > li");
    const pageOver = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // 1. a long unbroken title must not push the player's time, Download and collapse button off the screen
    await page.locator("#list > li", { hasText: LONG.slice(0, 20) }).locator("button.play").click();
    await page.waitForFunction((t) => document.querySelector("#pb-title").textContent.startsWith(t), LONG.slice(0, 20));
    for (const w of [320, 390, 768]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(150);
      const r = await page.evaluate(() => Object.fromEntries(["#pb-title", "#pb-time", "#pb-dl", "#pb-toggle", "#wave", "#pb-play"].map((s) =>
        [s, (({ left, right }) => [Math.round(left), Math.round(right)])(document.querySelector(s).getBoundingClientRect())])));
      for (const [sel, [l, rt]] of Object.entries(r)) assert.ok(l >= 0 && rt <= w, `player bar at ${w}px: ${sel} is at ${l}..${rt}`);
      assert.ok((await pageOver()) <= 1, `player bar widens the page at ${w}px`);
    }
    console.log("ok  a long unbroken title no longer pushes the player's controls off a phone screen");

    // 2. the Library table never overflows, from 900 to 1280px, cozy or compact
    for (const mode of ["#dens-cozy", "#dens-compact"]) {
      await page.click(mode);
      for (const w of [900, 1000, 1024, 1100, 1149, 1150, 1200, 1280]) {
        await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
        const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          resultsRight: document.querySelector("#results").getBoundingClientRect().right,
          sides: [...document.querySelectorAll("#list > li .side")].map((s) => s.getBoundingClientRect().right), vw: innerWidth }));
        assert.ok(m.over <= 1, `${mode} at ${w}px: the page is ${m.over}px wider than the screen`);
        assert.ok(m.sides.every((r) => r <= m.resultsRight + 14 && r <= m.vw), `${mode} at ${w}px: Edit/Download/marks stick out past the table (${Math.max(...m.sides)} vs ${m.resultsRight})`);
      }
    }
    await page.click("#dens-cozy");
    console.log("ok  the Library table fits at every width from 900 to 1280px (cozy and compact)");

    // 3. sizes never split ("94 KB" stays together)
    await page.setViewportSize({ width: 390, height: 800 });
    assert.ok(/\d KB/.test(await page.locator("#list > li").first().innerText()), "sizes use a non-breaking space");

    // 4. the edit form: date field looks like the others, BPM and Tap tempo share a line
    await page.locator("#list > li button.edit-btn").first().click();
    await page.waitForSelector("#list form.edit");
    const f = await page.evaluate(() => { const q = (s) => document.querySelector("#list form.edit " + s).getBoundingClientRect(), cs = (s) => getComputedStyle(document.querySelector("#list form.edit " + s));
      return { dateH: q("input[type=date]").height, textH: q("input[type=text]").height, dateBorder: cs("input[type=date]").borderTopWidth,
               bpmTop: q("input[type=number]").top, tapTop: q(".bpm button").top, bpmW: q("input[type=number]").width }; });
    assert.ok(f.dateH >= f.textH - 1, `the date field is ${f.dateH}px tall, the text fields ${f.textH}px`);
    assert.ok(Math.abs(f.bpmTop - f.tapTop) < 8 && f.bpmW < 160, `BPM and Tap tempo are not on one line (tops ${f.bpmTop}/${f.tapTop}, width ${f.bpmW})`);
    await page.click("#list form.edit button:has-text('Cancel')");
    console.log("ok  the date field matches the other fields; BPM and Tap tempo sit on one line");

    // 5. tap targets: text links have a finger-sized hit area
    const small = await page.evaluate(() => [...document.querySelectorAll("header nav a, header nav button, #list .side .dl, #list .side .edit-btn")]
      .filter((e) => e.getBoundingClientRect().width).map((e) => [e.textContent.trim(), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 30));
    assert.deepStrictEqual(small, [], "links with a hit area under 30px: " + JSON.stringify(small));
    console.log("ok  header and row links have at least a 30px-tall hit area");

    // 6. opening Edit with the player expanded keeps the form clear of the player (desktop)
    await page.setViewportSize({ width: 1280, height: 650 });
    await page.waitForTimeout(150);
    const bar = await page.evaluate(() => document.querySelector("#playerbar").getBoundingClientRect().top);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#list > li").nth(7).locator("button.edit-btn").click();
    await page.waitForSelector("#list form.edit");
    await page.waitForTimeout(250);
    const cover = await page.evaluate(() => { const r = document.querySelector("#list form.edit input[type=text]").getBoundingClientRect(); return { bottom: r.bottom, bar: document.querySelector("#playerbar").getBoundingClientRect().top }; });
    assert.ok(cover.bottom <= cover.bar + 1, `the form's Title field (bottom ${cover.bottom}) is hidden behind the player (top ${cover.bar}); bar was at ${bar}`);
    await page.click("#list form.edit button:has-text('Cancel')");
    console.log("ok  opening Edit scrolls the form clear of the expanded player");

    // 7. no keyboard hint in the Trash
    await ctx.request.delete(BASE + "api/recordings/10");
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-trash"); await page.waitForSelector("#list > li");
    assert.ok(await page.isHidden("#kbd-hint"), "the keyboard hint shows in the Trash");
    console.log("ok  the arrow-key hint is not shown in the Trash");

    // 8. text colours have enough contrast in both colour schemes
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      const v = await page.evaluate(() => Object.fromEntries(["bg", "panel", "text", "muted", "accent", "accent-text", "err", "ok", "warn"].map((n) =>
        [n, getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim()])));
      for (const [fg, bg] of [["text", "bg"], ["muted", "bg"], ["muted", "panel"], ["accent", "bg"], ["accent", "panel"], ["accent-text", "accent"], ["err", "bg"], ["err", "panel"], ["ok", "bg"], ["warn", "bg"]]) {
        const rr = ratio(v[fg], v[bg]);
        assert.ok(rr >= 4.5, `${scheme}: ${fg} (${v[fg]}) on ${bg} (${v[bg]}) has contrast ${rr.toFixed(2)}, under 4.5`);
      }
    }
    console.log("ok  text colours reach a 4.5:1 contrast in light and dark");
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
