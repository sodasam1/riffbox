// Phase 6 browser test: the transport bar (waveform, scrubbing, speed, loop, download), lengths in the list,
// the "played" marker, and sorting by length / last played. Needs ffmpeg on this machine. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/phase6.cjs
const { launch } = require("./_browser.cjs");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8194, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e6-"));

if (spawnSync("ffmpeg", ["-version"]).status !== 0) { console.log("skip: ffmpeg is not installed here"); process.exit(0); }
function makeAudio(name, args) {
  const out = path.join(tmp, name);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", ...args, "-ac", "2", out]);
  assert.strictEqual(r.status, 0, "could not make " + name + ": " + r.stderr);
  return fs.readFileSync(out);
}
// 6 s: a loud tone for the first 3 s, then silence. 3 s: a plain tone.
const LONG = makeAudio("long.wav", ["aevalsrc='if(lt(t,3),0.8*sin(2*PI*440*t),0)':d=6:s=44100"]);
const SHORT = makeAudio("short.wav", ["sine=frequency=330:duration=3"]);

const server = spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${PORT}`, "wsgi:app"], {
  cwd: path.join(ROOT, "app"),
  env: { ...process.env, RIFFBOX_DATA_DIR: path.join(tmp, "data"), RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok",
         RIFFBOX_PASSPHRASE: "open sesame", RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas",
         RIFFBOX_STATIC_DIR: path.join(ROOT, "static") },     // ffmpeg is found on PATH, as on the real server
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });

    // --- seed: two recordings, saved to the Library, and wait for the server to measure them
    const ids = {};
    for (const [title, buf, when] of [["Long idea", LONG, "2026-03-01T10:00:00Z"], ["Short idea", SHORT, "2026-03-02T10:00:00Z"]]) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: title + ".wav", mimeType: "audio/wav", buffer: buf }, title, recorded_at: when } });
      assert.strictEqual(r.status(), 201);
      ids[title] = (await r.json()).id;
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (const title of Object.keys(ids)) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${ids[title]}`, { data: { status: "tagged" } })).status(), 200);
    }
    let analysed = {};
    for (let i = 0; i < 100 && Object.keys(analysed).length < 2; i++) {
      for (const [title, id] of Object.entries(ids)) {
        const a = await (await ctx.request.get(BASE + `api/recordings/${id}/analysis`)).json();
        if (a.peaks && a.peaks.length) analysed[title] = a;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(Object.keys(analysed).length, 2, "the server measured both recordings");
    assert.ok(Math.abs(analysed["Long idea"].duration_s - 6) < 0.1 && Math.abs(analysed["Short idea"].duration_s - 3) < 0.1);
    console.log("ok  server measured both uploads in the background (6 s and 3 s)");

    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    const P = (fn, arg) => page.evaluate(fn, arg);
    const playerState = () => P(() => { const a = document.querySelector("#player");
      return { t: a.currentTime, paused: a.paused, rate: a.playbackRate, loop: a.loop, dur: a.duration, src: a.currentSrc }; });
    const waveBox = async () => (await page.locator("#wave").boundingBox());
    const clickWave = async (fraction) => { const b = await waveBox(); await page.mouse.click(b.x + b.width * fraction, b.y + b.height / 2); };
    const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected about ${expected}, got ${actual}`);

    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden]), #login:not([hidden])");
    if (await page.isVisible("#login")) { await page.fill("#pass", "open sesame"); await page.click("#login-form button"); }
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-library");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 2);

    // --- idle state, and lengths in the list
    assert.strictEqual((await page.textContent("#pb-title")).trim(), "Nothing playing");
    assert.ok(await page.locator("#pb-play").isDisabled());
    assert.ok(await page.isHidden("#pb-dl"));
    assert.strictEqual((await page.textContent("#pb-time")).trim(), "0:00 / 0:00");
    const listText = await page.locator("#list").innerText();
    assert.match(listText, /0:06/); assert.match(listText, /0:03/);
    console.log("ok  idle player bar is disabled and empty; the list shows each recording's length");

    // --- play the long one
    const longRow = page.locator("#list > li", { hasText: "Long idea" });
    await longRow.locator(".play").click();
    await page.waitForFunction(() => { const a = document.querySelector("#player"); return !a.paused && a.currentTime > 0.2; }, null, { timeout: 8000 });
    assert.strictEqual((await page.textContent("#pb-title")).trim(), "Long idea");
    assert.strictEqual(await page.getAttribute("#pb-play", "aria-label"), "Pause");
    assert.ok(await page.isVisible("#pb-dl"));
    assert.strictEqual(await page.getAttribute("#pb-dl", "href"), `api/audio/${ids["Long idea"]}?download=1`);
    await page.waitForFunction(() => /\/ 0:0[56]/.test(document.querySelector("#pb-time").textContent));
    await page.locator("#pb-play").click();                                     // pause from the bar
    await page.waitForFunction(() => document.querySelector("#player").paused);
    console.log("ok  playing shows the title, a Download link to the original, the time, and Pause");

    // --- the waveform: loud first half, near-flat second half
    await page.waitForTimeout(300);
    const ink = await P(() => { const c = document.querySelector("#wave"), x = c.getContext("2d");
      const count = (x0, w) => { const d = x.getImageData(x0, 0, w, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
      return { left: count(0, c.width / 2 - 4), right: count(c.width / 2 + 4, c.width / 2 - 4) }; });
    assert.ok(ink.left > ink.right * 3 && ink.right > 0, "waveform drawn: loud left half, quiet right half " + JSON.stringify(ink));
    console.log("ok  waveform is drawn from the measured peaks (loud half vs silent half)");

    // --- scrubbing: click, drag, keyboard
    await clickWave(0.5); near((await playerState()).t, 3, 0.4, "click at 50%");
    await clickWave(0.9); near((await playerState()).t, 5.4, 0.4, "click at 90%");
    const b = await waveBox();
    await page.mouse.move(b.x + b.width * 0.1, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.45, b.y + b.height / 2, { steps: 6 });
    await page.mouse.move(b.x + b.width * 0.8, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up(); near((await playerState()).t, 4.8, 0.4, "drag to 80%");
    await page.locator("#wave").focus();
    await page.keyboard.press("Home"); near((await playerState()).t, 0, 0.2, "Home");
    await page.keyboard.press("ArrowRight"); near((await playerState()).t, 5, 0.3, "Right = +5 s");
    await page.keyboard.press("ArrowLeft"); near((await playerState()).t, 0, 0.3, "Left = -5 s");
    await page.keyboard.press("End"); near((await playerState()).t, 6, 0.3, "End");
    assert.match(await page.getAttribute("#wave", "aria-valuetext"), /0:0[56] of 0:0[56]/);
    await page.keyboard.press("Home");
    console.log("ok  scrubbing by click, by drag and by keyboard (arrows, Home, End), with a spoken position");

    // --- speed (pitch preserved), remembered, kept for the next recording
    await page.selectOption("#pb-speed", "2");
    let st = await playerState(); assert.strictEqual(st.rate, 2);
    assert.strictEqual(await P(() => document.querySelector("#player").preservesPitch), true, "pitch is preserved");
    await page.locator("#list > li", { hasText: "Short idea" }).locator(".play").click();
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    assert.strictEqual((await playerState()).rate, 2, "the speed carries over to the next recording");
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    assert.strictEqual(await page.inputValue("#pb-speed"), "2", "speed remembered after a reload");
    await page.selectOption("#pb-speed", "1");
    console.log("ok  speed 2x keeps pitch, carries to the next recording, and is remembered");

    // --- A-B loop
    await page.click("#tab-library");
    await page.locator("#list > li", { hasText: "Long idea" }).locator(".play").click();
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    await page.locator("#pb-play").click(); await page.waitForFunction(() => document.querySelector("#player").paused);
    await clickWave(1 / 6); await page.click("#pb-a");                         // A at about 1 s
    await clickWave(2 / 6); await page.click("#pb-b");                         // B at about 2 s
    assert.strictEqual(await page.getAttribute("#pb-loop", "aria-pressed"), "true", "setting A and B turns looping on");
    await clickWave(1.5 / 6); await page.locator("#pb-play").click();
    const trace = await P(() => new Promise((res) => { const a = document.querySelector("#player"), out = [];
      const id = setInterval(() => out.push(a.currentTime), 40); setTimeout(() => { clearInterval(id); res(out); }, 3600); }));
    const wraps = trace.filter((t, i) => i && t < trace[i - 1] - 0.5).length;
    assert.ok(Math.min(...trace) >= 0.8 && Math.max(...trace) <= 2.35, `stays inside 1-2 s (saw ${Math.min(...trace).toFixed(2)}..${Math.max(...trace).toFixed(2)})`);
    assert.ok(wraps >= 2, "wrapped back to A at least twice in 3.6 s (saw " + wraps + ")");
    await page.click("#pb-clear");
    assert.strictEqual(await page.getAttribute("#pb-loop", "aria-pressed"), "false");
    await clickWave(1.8 / 6);
    await page.waitForFunction(() => document.querySelector("#player").currentTime > 2.5, null, { timeout: 4000 });
    console.log("ok  A-B loop repeats just that section (wrapped " + wraps + "x), and Clear lets playback run on");

    // Shift + drag selects a section too; Loop with no section repeats the whole recording
    await page.locator("#pb-play").click(); await page.waitForFunction(() => document.querySelector("#player").paused);
    const bb = await waveBox();
    await page.keyboard.down("Shift");
    await page.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height / 2); await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * 0.4, bb.y + bb.height / 2, { steps: 8 }); await page.mouse.up();
    await page.keyboard.up("Shift");
    assert.strictEqual(await page.getAttribute("#pb-loop", "aria-pressed"), "true", "Shift+drag turns looping on");
    await page.click("#pb-clear");
    await page.click("#pb-loop");
    assert.strictEqual((await playerState()).loop, true, "Loop with no section repeats the whole recording");
    await page.click("#pb-loop");
    assert.strictEqual((await playerState()).loop, false);
    console.log("ok  Shift+drag selects a loop section; Loop alone repeats the whole recording");

    // --- "played" is only counted for a real listen, not for skipping past
    const lastPlayed = async (title) => (await (await ctx.request.get(BASE + "api/groups?status=tagged")).json()).groups.find((r) => r.title === title).last_played_at;
    assert.strictEqual(await lastPlayed("Short idea"), null, "premise: Short idea has not been listened to");
    await page.locator("#list > li", { hasText: "Short idea" }).locator(".play").click();   // audition for under a second...
    await page.waitForTimeout(600);
    await page.locator("#list > li", { hasText: "Long idea" }).locator(".play").click();    // ...then move on
    await page.waitForTimeout(500);
    assert.strictEqual(await lastPlayed("Short idea"), null, "a brief audition is not a listen");
    await page.locator("#list > li", { hasText: "Short idea" }).locator(".play").click();   // now really listen (> 1.5 s of 3 s)
    await page.waitForFunction(() => document.querySelector("#player").currentTime > 1.7, null, { timeout: 8000 });
    await page.waitForTimeout(400);
    assert.ok(await lastPlayed("Short idea"), "a real listen is recorded");
    console.log("ok  last played is recorded after a real listen, not after a quick audition");

    // --- sort by length and by last played
    await page.locator("#pb-play").click().catch(() => {});
    await page.selectOption("#f-sort", "length");
    await page.waitForFunction(() => [...document.querySelectorAll("#list > li .title")].map((n) => n.textContent).join() === "Long idea,Short idea");
    await page.click("#f-order");
    await page.waitForFunction(() => [...document.querySelectorAll("#list > li .title")].map((n) => n.textContent).join() === "Short idea,Long idea");
    await page.selectOption("#f-sort", "played");                              // most recent first: Short idea was just listened to
    await page.waitForFunction(() => [...document.querySelectorAll("#list > li .title")].map((n) => n.textContent).join() === "Short idea,Long idea");
    assert.match(await page.textContent("#f-order"), /Most recent first/);
    await page.click("#f-order");
    assert.match(await page.textContent("#f-order"), /Longest ago first/);
    await page.selectOption("#f-sort", "recorded");
    console.log("ok  Library sorts by length and by last played");

    // --- phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#list > li", { hasText: "Long idea" }).locator(".play").click();
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    const phone = await P(() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
      const bar = r("#playerbar"), btns = ["#pb-play", "#pb-a", "#pb-b", "#pb-loop", "#pb-clear", "#pb-speed"].map((s) => ({ s, w: r(s).width, h: r(s).height }));
      return { barH: bar.height, vh: innerHeight, barRight: bar.right, vw: innerWidth, btns,
               overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
    assert.ok(phone.overflow <= 1, "no sideways scroll with the player bar, got " + phone.overflow);
    assert.ok(phone.barH <= phone.vh * 0.32, `bar height ${phone.barH} of ${phone.vh}`);
    for (const x of phone.btns) assert.ok(x.h >= 38 && x.w >= 38, "tap target " + JSON.stringify(x));
    await page.screenshot({ path: path.join(tmp, "player-phone.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(tmp, "player-desktop.png") });
    console.log("ok  phone: player bar fits, controls are at least 38 px, no sideways scroll");

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
