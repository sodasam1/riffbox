// The player can be collapsed to one slim row: with a button (remembered), and automatically while typing on a
// small screen (a phone keyboard). Run:  RIFFBOX_PY=/path/to/python node tests/e2e/collapse.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8191, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-collapse-"));

function wav(freq, seconds = 8, rate = 8000) {
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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: "a.wav", mimeType: "audio/wav", buffer: wav(220) }, title: "A recording" } });
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });

    const bar = () => page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const shown = (s) => { const n = document.querySelector(s); return !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0; };
      return { h: r("#playerbar").height, wave: shown("#wave"), speed: shown("#pb-speed"), loop: shown(".pb-loop"),
               play: shown("#pb-play"), title: shown("#pb-title"), time: shown("#pb-time"), toggle: shown("#pb-toggle"),
               label: document.querySelector("#pb-toggle").getAttribute("aria-label"),
               expanded: document.querySelector("#pb-toggle").getAttribute("aria-expanded"),
               playing: !document.querySelector("#player").paused, vw: innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    const waitHeight = (test) => page.waitForFunction((src) => { const h = document.querySelector("#playerbar").getBoundingClientRect().height; return new Function("h", "return " + src)(h); }, test, { timeout: 4000 });

    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden]), #login:not([hidden])");
    if (await page.isVisible("#login")) { await page.fill("#pass", "open sesame"); await page.click("#login-form button"); }
    await page.waitForSelector("#list > li");
    await page.locator("#list > li .play").click();
    await page.waitForFunction(() => { const a = document.querySelector("#player"); return !a.paused && a.currentTime > 0.2; }, null, { timeout: 8000 });

    // --- full by default; the button collapses it, playback carries on
    let b = await bar();
    assert.ok(b.h > 150 && b.wave && b.speed && b.loop, "starts full-size: " + JSON.stringify(b));
    const fullBarH = b.h;                                              // how tall the expanded player is
    assert.strictEqual(b.label, "Collapse the player"); assert.strictEqual(b.expanded, "true");
    await page.click("#pb-toggle");
    await waitHeight("h <= 72");
    b = await bar();
    assert.ok(!b.wave && !b.speed && !b.loop, "waveform and extra controls fold away");
    assert.ok(b.play && b.title && b.time && b.toggle, "play, title, time and the button stay: " + JSON.stringify(b));
    assert.strictEqual(b.label, "Expand the player"); assert.strictEqual(b.expanded, "false");
    assert.ok(b.playing, "the music did not stop");
    assert.ok(b.over <= 1, "no sideways scroll");
    await page.screenshot({ path: path.join(tmp, "mini-phone.png") });
    console.log("ok  the button collapses the player to one slim row (" + Math.round(b.h) + "px) and the music carries on");

    // --- the slim bar still plays and pauses; the choice is remembered
    await page.click("#pb-play"); await page.waitForFunction(() => document.querySelector("#player").paused);
    await page.click("#pb-play"); await page.waitForFunction(() => !document.querySelector("#player").paused);
    await page.reload(); await page.waitForSelector("#list > li");
    await waitHeight("h <= 72");
    assert.strictEqual((await bar()).label, "Expand the player", "still collapsed after a reload");
    await page.click("#pb-toggle"); await waitHeight("h > 150");
    await page.reload(); await page.waitForSelector("#list > li");
    await waitHeight("h > 150");
    console.log("ok  the slim bar plays and pauses; collapsed or expanded is remembered across reloads");

    // --- typing on a small screen collapses it by itself, and it comes back afterwards
    await page.locator("#list > li button.edit-btn").click();
    await page.waitForSelector("#list form.edit");
    await page.locator("#list form.edit input[type=text]").first().blur();                   // (a mouse user lands in the Title box)
    await waitHeight("h > 150");
    assert.ok((await bar()).h > 150, "the form being open does not collapse it by itself");
    await page.locator("#list form.edit textarea").focus();
    await waitHeight("h <= 72");
    b = await bar();
    assert.ok(!b.wave && b.play, "typing collapses the player: " + JSON.stringify(b));
    await page.keyboard.type("typing a note");
    // regression: pressing a button right after typing must still register (the bar used to jump up over it)
    const tag = page.locator('#list form.edit button.tagbtn[data-tag="keys"]');
    // a short window, with the button placed where the expanded player would sit, so a jump would swallow the tap
    await page.setViewportSize({ width: 390, height: 600 });
    await tag.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - (innerHeight - 170)));
    const where = await tag.evaluate((el) => { const r = el.getBoundingClientRect(); return { centre: r.top + r.height / 2, vh: innerHeight }; });
    assert.ok(where.centre > where.vh - 14 - fullBarH, "premise: the button's centre is under where the full player would be: " + JSON.stringify(where) + " bar " + fullBarH);
    await tag.click();
    assert.strictEqual(await tag.getAttribute("aria-pressed"), "true", "a tag pressed straight after typing is toggled");
    await tag.click();
    assert.strictEqual(await tag.getAttribute("aria-pressed"), "false");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#list form.edit input[type=text]").first().focus();                  // field to field: stays collapsed
    await page.waitForTimeout(450);
    assert.ok((await bar()).h <= 72, "moving between fields does not bring it back");
    await page.locator("#list form.edit input[type=text]").first().blur();
    await waitHeight("h > 150");
    assert.ok((await bar()).wave, "back to full size once typing stops");
    console.log("ok  typing collapses the player on a small screen, and it expands again when you stop");

    // --- the speed drop-down inside the player is not treated as 'typing'
    await page.evaluate(() => {                                   // record whether the bar collapses even for an instant
      window.__sawMini = false;
      new MutationObserver(() => { if (document.querySelector("#playerbar").classList.contains("mini")) window.__sawMini = true; })
        .observe(document.querySelector("#playerbar"), { attributes: true, attributeFilter: ["class"] });
    });
    await page.focus("#pb-speed");
    await page.waitForTimeout(450);
    assert.strictEqual(await page.evaluate(() => window.__sawMini), false, "using the player's own controls never collapses it");
    assert.ok((await bar()).h > 150 && (await bar()).speed, "and it is still open");

    // --- a manual collapse stays collapsed after typing ends; the button expands it even mid-typing
    await page.click("#pb-toggle"); await waitHeight("h <= 72");
    await page.locator("#list form.edit textarea").focus(); await page.waitForTimeout(300);
    await page.locator("#list form.edit textarea").blur(); await page.waitForTimeout(450);
    assert.ok((await bar()).h <= 72, "a bar you collapsed stays collapsed");
    await page.locator("#list form.edit textarea").focus(); await page.waitForTimeout(300);
    await page.click("#pb-toggle");                                                           // expands, and drops the keyboard
    await waitHeight("h > 150");
    assert.ok((await bar()).wave);
    assert.notStrictEqual(await page.evaluate(() => document.activeElement.tagName), "TEXTAREA", "the field let go of the keyboard");
    console.log("ok  your own collapse is respected; the button expands the bar even while typing");

    // --- on a touch screen, opening the form does not put the cursor (and the keyboard) in the Title box
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    await touch.addCookies(await ctx.cookies());
    const tp = await touch.newPage();
    await tp.goto(BASE);
    await tp.waitForSelector("#list > li");
    assert.ok(await tp.evaluate(() => matchMedia("(pointer: coarse)").matches), "premise: the emulated phone has a coarse pointer");
    await tp.locator("#list > li button.edit-btn").tap();
    await tp.waitForSelector("#list form.edit");
    await tp.waitForTimeout(450);
    assert.notStrictEqual(await tp.evaluate(() => document.activeElement.tagName), "INPUT", "no keyboard pops up on its own");
    assert.ok((await tp.evaluate(() => document.querySelector("#playerbar").getBoundingClientRect().height)) > 150, "so the player stays as it was");
    await tp.locator("#list form.edit textarea").tap();                                       // tapping a field collapses it
    await tp.waitForFunction(() => document.querySelector("#playerbar").getBoundingClientRect().height <= 72, null, { timeout: 4000 });
    await touch.close();
    console.log("ok  on a touch screen opening the form no longer raises the keyboard; tapping a field then collapses the player");

    // --- a wide screen with a mouse: typing does not collapse it automatically
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator("#list form.edit textarea").focus();
    await page.waitForTimeout(450);
    b = await bar();
    assert.ok(b.h > 100 && b.wave, "wide screen: typing leaves the player alone: " + JSON.stringify(b));
    await page.click("#pb-toggle"); await waitHeight("h <= 72");
    console.log("ok  on a wide screen it only collapses when asked");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
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
