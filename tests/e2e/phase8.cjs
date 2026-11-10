// Phase 8 browser test: delete (two presses), the Trash tab, restore. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase8.cjs
const { launch } = require("./_browser.cjs");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8196, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e8-"));

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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const ids = {};
    for (const [i, title] of ["Keeper", "Doomed", "Inbox one"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const t of ["Keeper", "Doomed"]) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${ids[t]}`, { data: { status: "tagged", tags: ["bass"], notes: "keep my notes" } })).status(), 200);
    }
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    assert.ok(await page.isHidden("#tab-trash"), "no Trash tab while the Trash is empty");
    await page.click("#tab-library");
    const row = (t) => page.locator("#list > li", { hasText: t });

    // one press only asks
    await row("Doomed").locator("button.edit-btn").click();
    const del = page.locator("#list form.edit button.danger");
    await del.click();
    assert.match(await del.textContent(), /again/);
    await page.waitForTimeout(4300);
    assert.strictEqual((await del.textContent()).trim(), "Delete", "the question times out");
    assert.ok(await row("Doomed").count(), "one press must not delete");
    console.log("ok  one press on Delete only asks; it times out");

    // two presses delete
    await del.click(); await del.click();
    await page.waitForFunction(() => !document.querySelector("#list").innerText.includes("Doomed"));
    assert.ok(await row("Keeper").count(), "other recordings stay");
    assert.match(await page.textContent("#notice"), /Trash/);
    assert.strictEqual((await page.textContent("#tab-trash")).trim(), "Trash (1)");
    assert.match(await page.textContent("#tab-library"), /Library \(1\)/);
    console.log("ok  two presses move it to the Trash; counts update");

    // the Trash tab
    await page.click("#tab-trash");
    await page.waitForSelector("#list > li");
    assert.strictEqual(await page.locator("#list > li").count(), 1);
    assert.ok(await row("Doomed").locator("button.restore-btn").count());
    assert.strictEqual(await page.locator("#list .play").count(), 0, "nothing to play in the Trash");
    assert.ok(await page.locator("#filters").isHidden());
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, "Trash page is wider than the screen by " + over);
    for (const w of [320, 375, 430, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(100);
      const o = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        side: document.querySelector("#list .side").getBoundingClientRect().right, vw: innerWidth }));
      assert.ok(o.over <= 1 && o.side <= o.vw - 4, `Trash at ${w}px: page ${o.over}px too wide, Restore ends at ${Math.round(o.side)}`);
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Space");           // keys on a Trash row do nothing and do not crash
    console.log("ok  the Trash lists it with Restore only, no player and no filters");

    // restore
    await row("Doomed").locator("button.restore-btn").click();
    await page.waitForFunction(() => document.querySelector("#empty") && !document.querySelector("#empty").hidden);
    assert.match(await page.textContent("#notice"), /Restored to the Library/);
    await page.click("#tab-library");
    await page.waitForSelector("#list > li");
    assert.ok(await row("Doomed").count());
    const back = (await (await ctx.request.get(BASE + "api/groups?status=tagged")).json()).groups.find((r) => r.title === "Doomed");
    assert.deepStrictEqual([back.tags, back.notes], [["bass"], "keep my notes"]);
    assert.ok(await page.isHidden("#tab-trash"));
    console.log("ok  restore brings it back with its tags and notes");

    // an Inbox item can be deleted too, and the open form closes
    await page.click("#tab-inbox");
    await row("Inbox one").locator("button.edit-btn").click();
    await page.locator("#list form.edit button.danger").dblclick();
    await page.waitForFunction(() => document.querySelector("#empty") && !document.querySelector("#empty").hidden);
    assert.strictEqual((await page.textContent("#tab-trash")).trim(), "Trash (1)");
    console.log("ok  an Inbox recording can be deleted too");
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
