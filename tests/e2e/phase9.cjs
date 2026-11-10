// Trash tab styling, Cozy/Compact rows, Resurface and the backup status line. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase9.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8199, PORT2 = 8200, BASE = `http://127.0.0.1:${PORT}/ideas/`, BASE2 = `http://127.0.0.1:${PORT2}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e9-"));

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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const TITLES = ["Never played", "Played 100 days ago", "Played 200 days ago", "Played yesterday", "Check idea", "X idea",
                    "Plain idea", "Another plain", "Long title " + "word ".repeat(20), "Tenth"];
    const RATE = ["heart", "heart", "heart", "heart", "check", "x", null, null, null, null];
    const ids = {};
    for (const [i, title] of TITLES.entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 17) }, title } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const [i, title] of TITLES.entries()) {
      const r = await ctx.request.patch(BASE + `api/recordings/${ids[title]}`, { data: { status: "tagged", tags: ["bass", "keys"],
        notes: "some notes about this idea", rating: RATE[i], bpm: 100 + i } });
      assert.strictEqual(r.status(), 200);
    }
    const gone = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: "t.wav", mimeType: "audio/wav", buffer: wav(900) }, title: "Trashed one" } });
    await ctx.request.delete(BASE + `api/recordings/${(await gone.json()).id}`);
    const dbDir = path.join(tmp, "data", "riffbox.db");
    const iso = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
    require("child_process").execFileSync(PY, ["-I", "-c",
      "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);" +
      "[c.execute('UPDATE recordings SET last_played_at=? WHERE id=?',(t,i)) for i,t in zip(sys.argv[2::2],sys.argv[3::2])];c.execute('UPDATE idea_groups SET last_played_at=(SELECT MAX(last_played_at) FROM recordings r WHERE r.group_id=idea_groups.id)');c.commit()",
      dbDir, String(ids["Played 100 days ago"]), iso(100), String(ids["Played 200 days ago"]), iso(200), String(ids["Played yesterday"]), iso(1)]);

    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");

    // ---- Trash is set apart
    const tabs = await page.evaluate(() => Object.fromEntries(["inbox", "library", "resurface", "trash"].map((n) => {
      const b = document.querySelector("#tab-" + n).getBoundingClientRect(); return [n, { left: b.left, right: b.right, hidden: document.querySelector("#tab-" + n).hidden }]; })));
    assert.ok(!tabs.trash.hidden && tabs.trash.left > tabs.resurface.right + 150, "the Trash tab sits apart from the others: " + JSON.stringify(tabs));
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector("#tab-trash")).borderStyle), "dashed");
    await page.click("#tab-trash");
    await page.waitForSelector("#list > li button.restore-btn");
    assert.strictEqual(await page.locator("#lib-h").count(), 0, "the Recordings heading is gone");
    assert.ok(await page.isVisible("#trash-note"));
    assert.ok(await page.evaluate(() => document.querySelector("#app").classList.contains("in-trash")));
    await page.click("#tab-library");
    assert.ok(await page.isHidden("#trash-note"));
    console.log("ok  the Trash tab is set apart (right-hand end, dashed) and its page has its own heading and note");

    // ---- Cozy / Compact
    await page.waitForSelector("#list > li");
    assert.ok(await page.isVisible("#density"));
    const rowH = () => page.evaluate(() => { const hs = [...document.querySelectorAll("#list > li")].map((li) => li.getBoundingClientRect().height);
      return hs.reduce((a, b) => a + b, 0) / hs.length; });
    const screenfuls = () => page.evaluate(() => { const hs = [...document.querySelectorAll("#list > li")].map((li) => li.getBoundingClientRect().height);
      let sum = 0, n = 0; for (const h of hs) { if (sum + h > innerHeight - 200) break; sum += h; n++; } return n; });
    assert.strictEqual(await page.getAttribute("#dens-cozy", "aria-pressed"), "true");
    const cozy = { h: await rowH(), n: await screenfuls() };
    await page.click("#dens-compact");
    assert.ok(await page.evaluate(() => document.querySelector("#list").classList.contains("compact")));
    const compact = { h: await rowH(), n: await screenfuls() };
    assert.ok(compact.h <= cozy.h * 0.5, `compact rows are not shorter on desktop (${cozy.h} -> ${compact.h})`);
    assert.ok(compact.n > cozy.n, `compact does not show more rows (${cozy.n} -> ${compact.n})`);
    console.log(`ok  desktop: compact rows ${Math.round(cozy.h)}px -> ${Math.round(compact.h)}px; ${cozy.n} -> ${compact.n} rows per screen`);
    await page.reload(); await page.waitForSelector("#app:not([hidden])"); await page.click("#tab-library"); await page.waitForSelector("#list > li");
    assert.ok(await page.evaluate(() => document.querySelector("#list").classList.contains("compact")), "the choice is remembered");
    for (const w of [320, 375, 430, 1280]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
      const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, vw: innerWidth,
        sides: [...document.querySelectorAll("#list > li .side")].map((s) => s.getBoundingClientRect().right) }));
      assert.ok(m.over <= 1 && m.sides.every((r) => r <= m.vw - 4), `compact at ${w}px: page ${m.over}px too wide or links off-screen`);
      const hd = await page.evaluate(() => { const h = document.querySelector("header h1").getBoundingClientRect(), n = document.querySelector("#menu-btn").getBoundingClientRect();
        return { apart: n.left >= h.right + 4 || n.top >= h.bottom - 1, navRight: n.right, vw: innerWidth }; });
      assert.ok(hd.apart && hd.navRight <= hd.vw, `header at ${w}px: the links collide with the title or run off the screen`);
    }
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(120);
    const phoneCompact = await rowH();
    await page.click("#dens-cozy");
    const phoneCozy = await rowH();
    assert.ok(phoneCompact <= phoneCozy * 0.75, `phone: compact rows are not shorter (${phoneCozy} -> ${phoneCompact})`);
    await page.click("#dens-compact");
    console.log(`ok  phone: compact rows ${Math.round(phoneCozy)}px -> ${Math.round(phoneCompact)}px, nothing overflows from 320 to 1280px`);
    await page.locator("#list > li button.edit-btn").first().click();           // a form still opens in a compact row
    await page.waitForSelector("#list form.edit");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, "an open form in compact mode widens the page");
    await page.click("#list form.edit button:has-text('Cancel')");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click("#tab-inbox"); assert.ok(await page.isHidden("#density"), "the switch is only for the Library");
    await page.click("#tab-resurface"); assert.ok(await page.isHidden("#density"));
    await page.click("#tab-library");
    await page.click("#dens-cozy");
    assert.ok(!(await page.evaluate(() => document.querySelector("#list").classList.contains("compact"))));
    console.log("ok  the switch is remembered, shows only in the Library, and an edit form opens inside a compact row");

    // ---- Resurface
    await page.click("#tab-resurface");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 3);
    const names = async () => page.locator("#list > li .title").allTextContents();
    assert.deepStrictEqual(await names(), ["Never played", "Played 200 days ago", "Played 100 days ago"]);
    assert.match(await page.textContent("#resurface-text"), /3 of your 4 hearted ideas have not been played in 30 days/);
    assert.match(await page.textContent("#list > li:nth-child(1) .when"), /never played/);
    assert.match(await page.textContent("#list > li:nth-child(3) .when"), /last played 3 months ago|last played 100 days ago|last played \d+ days ago/);
    await page.selectOption("#resurface-days", "365");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 1);
    await page.selectOption("#resurface-days", "0");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 4);
    await page.selectOption("#resurface-days", "30");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 3);
    console.log("ok  Resurface lists hearted ideas not played lately, never-played first, and the time choice works");
    const playing = () => page.evaluate(() => (document.querySelector("#player").getAttribute("src") || "").match(/play\/(\d+)/)?.[1] || null);
    const pool = [ids["Never played"], ids["Played 200 days ago"], ids["Played 100 days ago"]].map(String);
    await page.click("#surprise");
    await page.waitForFunction(() => /play\/\d+/.test(document.querySelector("#player").getAttribute("src") || ""));
    const first = await playing();
    assert.ok(pool.includes(first), "Surprise me played something outside the Resurface list: " + first);
    assert.match(await page.textContent("#notice"), /Playing/);
    const seen = new Set([first]);
    for (let i = 0; i < 8 && seen.size < 2; i++) { await page.click("#surprise"); await page.waitForTimeout(150); seen.add(await playing()); }
    assert.ok(seen.size >= 2 && [...seen].every((x) => pool.includes(x)), "Surprise me always plays the same idea: " + [...seen]);
    console.log("ok  Surprise me plays a random idea from the list, and a different one the next time");
    // when everything hearted was played lately, the list is empty but Surprise me still works from any heart
    require("child_process").execFileSync(PY, ["-I", "-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE recordings SET last_played_at=? WHERE rating='heart'\",(sys.argv[2],));c.execute('UPDATE idea_groups SET last_played_at=(SELECT MAX(last_played_at) FROM recordings r WHERE r.group_id=idea_groups.id)');c.commit()", dbDir, iso(0)]);
    await page.selectOption("#resurface-days", "7");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 0);
    assert.match(await page.textContent("#empty"), /played recently/);
    await page.click("#surprise");
    await page.waitForFunction(() => /any ♥/.test(document.querySelector("#notice").textContent));
    console.log("ok  with nothing stale, Surprise me still plays any hearted idea and says so");

    // ---- the status line on the Backup and export page
    await page.click("#menu-btn"); await page.click("#data-link");
    await page.waitForSelector("#data-status:not([hidden])");
    const cls = await page.getAttribute("#data-status", "class");
    assert.match(cls, /status-line (ok|warn|bad)/);
    const all = (await page.textContent("#data-status")).replace(/\s+/g, " ");
    assert.match(all, /free of/); assert.match(all, /audio uses/);
    assert.match(all, /No backup has been made yet/);
    await page.click("#backup-now");
    await page.waitForFunction(() => !/No backup has been made yet/.test(document.querySelector("#data-status").textContent), null, { timeout: 15000 });
    console.log("ok  the status line shows disk, audio size and backup state, and updates after a backup");
    const page2 = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page2.context().request.post(BASE2 + "api/login", { data: { passphrase: "open sesame" } });
    await page2.goto(BASE2 + "#data");
    await page2.waitForSelector("#data-status:not([hidden])");
    assert.match(await page2.textContent("#data-status"), /No server backup is set up/);
    await page2.setViewportSize({ width: 320, height: 800 });
    assert.ok((await page2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1, "status line overflows at 320px");
    console.log("ok  with no backup folder it says so (and fits at 320px)");

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
