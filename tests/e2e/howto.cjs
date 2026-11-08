// Browser test for the "How this works" page and the player-bar spacing.
// Run:  RIFFBOX_PY=/path/to/python node tests/e2e/howto.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8197, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-how-"));

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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const problems = [];
    let n401 = 0;
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() !== "error") return; if (m.text().includes("401")) n401++; else problems.push("console: " + m.text()); });

    // --- nothing private is in the public files, and the player is not on the login screen
    await page.goto(BASE);
    await page.waitForSelector("#login:not([hidden])");
    assert.ok(await page.isHidden("#playerbar"), "player bar hidden while logged out");
    for (const file of ["", "static/app.js", "static/index.html", "static/style.css"]) {
      const text = await (await fetch(BASE + file)).text();
      for (const secret of ["permit nopass", "relayd", "/usr/local/riffbox", "Vultr", "doas", "_riffbox"]) {
        assert.ok(!text.includes(secret), `public file "${file || "/"}" must not mention "${secret}"`);
      }
    }
    assert.strictEqual((await fetch(BASE + "api/about")).status, 401, "about page needs a login");
    console.log("ok  public page files contain no server details; the page itself needs a login");

    // --- log in; link is present but unobtrusive
    await page.fill("#pass", "open sesame"); await page.click("#login-form button");
    await page.waitForSelector("#app:not([hidden])");
    const link = page.locator("#how-link");
    assert.strictEqual((await link.textContent()).trim(), "How this works");
    assert.ok(await page.isVisible("#main-view") && await page.isHidden("#how-view"));
    console.log("ok  link sits in the header; recordings are shown by default");

    // --- open it
    await link.click();
    await page.waitForSelector("#how-view:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#how-body h2").length >= 6);
    assert.ok(await page.isHidden("#main-view"));
    assert.strictEqual(new URL(page.url()).hash, "#how");
    const headings = (await page.locator("#how-body h2").allTextContents()).map((s) => s.trim());
    assert.deepStrictEqual(headings, ["Planned features", "Roadmap and progress", "Context",
      "What the guide and ti.sh already gave us", "Architecture", "Data model", "Keeping your data portable"]);
    const text = await page.locator("#how-body").innerText();
    for (const s of ["OpenBSD 7.9", "FreeFileSync", "SQLite", "Phase", "recorded_at"]) assert.ok(text.includes(s), "page mentions " + s);
    assert.strictEqual(await page.locator("#how-body table").count(), 4, "roadmap, location, data and dependency tables render");
    console.log("ok  page opens with the six sections in the requested order, tables included");

    // --- phone: tables must scroll inside their box, not widen the page
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, "no sideways page scroll on a phone, got " + overflow);
    await page.screenshot({ path: path.join(tmp, "how-mobile.png") });
    console.log("ok  no sideways scrolling on a 390px phone");

    // --- back link, browser back, reload, logout
    await page.click("#how-back");
    await page.waitForSelector("#main-view:not([hidden])");
    assert.ok(await page.isHidden("#how-view"));
    await link.click(); await page.waitForSelector("#how-view:not([hidden])");
    await page.goBack();
    await page.waitForSelector("#main-view:not([hidden])");
    await page.goto(BASE + "#how"); await page.reload();
    await page.waitForSelector("#how-view:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#how-body h2").length >= 6);
    await page.click("#logout"); await page.waitForSelector("#login:not([hidden])");
    assert.strictEqual(new URL(page.url()).hash, "", "logging out leaves #how behind");
    await page.fill("#pass", "open sesame"); await page.click("#login-form button");
    await page.waitForSelector("#main-view:not([hidden])");
    console.log("ok  back link, browser Back, reload on #how and logout all behave");

    // --- player bar spacing, phone and desktop
    for (const [w, h] of [[390, 844], [1280, 800]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForSelector("#playerbar:not([hidden])");
      // just after logging in on a phone the bar is still folded away from typing the passphrase; let it settle
      await page.waitForFunction(() => !document.querySelector("#playerbar").classList.contains("mini"), null, { timeout: 5000 });
      const g = await page.evaluate(() => {
        const r = document.querySelector("#playerbar").getBoundingClientRect();
        const top = document.querySelector(".pb-top").getBoundingClientRect();
        const controls = document.querySelector(".pb-controls").getBoundingClientRect();
        const wave = document.querySelector("#wave").getBoundingClientRect();
        const play = document.querySelector("#pb-play").getBoundingClientRect();
        return { gapBottom: innerHeight - r.bottom, gapLeft: r.left, gapRight: innerWidth - r.right,
                 padTop: top.top - r.top, padBottom: r.bottom - controls.bottom, padSide: wave.left - r.left,
                 audioH: play.height, barH: r.height, vh: innerHeight };
      });
      assert.ok(g.gapBottom >= 12, `${w}px: bar is clear of the bottom edge (${g.gapBottom})`);
      assert.ok(g.gapLeft >= 12 && g.gapRight >= 12 || w > 700, `${w}px: bar is clear of the side edges`);
      assert.ok(g.padTop >= 8 && g.padBottom >= 8 && g.padSide >= 8, `${w}px: the controls have padding inside the bar`);
      assert.ok(g.audioH >= 40, `${w}px: controls are tall enough to tap (${g.audioH})`);
      assert.ok(g.barH <= g.vh * 0.32, `${w}px: the player bar does not take over the screen (${g.barH} of ${g.vh}px)`);
      await page.screenshot({ path: path.join(tmp, `bar-${w}.png`) });
    }
    console.log("ok  player bar floats clear of the edges with padding, on phone and desktop widths");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    assert.strictEqual(n401, 1, "exactly one expected 401 (the logged-out session check on first load), got " + n401);
    console.log("ok  no unexpected console or page errors");
    console.log("screenshots in", tmp);
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
