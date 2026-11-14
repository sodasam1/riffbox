// Regression test: very long titles, notes and tag names must not stretch the page or push the Edit and
// Download links off the right edge (it did, on a phone). Run:  RIFFBOX_PY=/path/to/python node tests/e2e/longtitles.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8193, name: "long", wavSeconds: 1 });

const LONG_WORDS = "A really long title with plenty of ordinary words that just keeps going and going until it cannot possibly fit on one line of a phone screen";
const LONG_UNBROKEN = "Averyveryveryverylongtitlewithoutanyspacesatalleveryletterrunstogetherandkeepsgoingforaverylongtimeindeed1234567890";
const LONG_NOTE = "Averyveryveryverylongnotewordwithoutspacesthatalsokeepsgoingandgoingandgoingandgoingandgoing";
const SEED = [[LONG_WORDS, "tagged"], [LONG_UNBROKEN, "tagged"], ["Short one", "tagged"], [LONG_UNBROKEN + " (inbox)", "inbox"]];

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 1 });   // not "mobile": keeps the width fixed
    const ids = [];
    for (let i = 0; i < SEED.length; i++) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(200 + i * 40) }, title: SEED[i][0] } });
      ids.push((await r.json()).id);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    const LONG_TAG = "a tag with a rather long name";                                  // 29 characters: the most a tag may have
    assert.strictEqual((await ctx.request.post(BASE + "api/tags", { data: { name: LONG_TAG } })).status(), 201);
    for (let i = 0; i < SEED.length; i++) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${ids[i]}`, { data: {
        status: SEED[i][1], notes: LONG_NOTE, tags: ["bass", LONG_TAG], bpm: 123 } })).status(), 200);
    }

    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");

    const measure = () => page.evaluate(() => {
      const vw = innerWidth;
      const rows = [...document.querySelectorAll("#list > li")].map((li) => {
        const side = li.querySelector(".side").getBoundingClientRect();
        const info = li.querySelector(".info").getBoundingClientRect();
        const title = li.querySelector(".title");
        const lh = parseFloat(getComputedStyle(title).lineHeight) || 24;
        return { sideLeft: side.left, sideRight: side.right, infoRight: info.right, titleLines: title.getBoundingClientRect().height / lh,
                 liRight: li.getBoundingClientRect().right };
      });
      return { vw, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, rows };
    });

    for (const view of ["library", "inbox"]) {
      await page.click(view === "library" ? "#tab-library" : "#tab-inbox");
      await page.waitForSelector("#list > li");
      for (const w of [320, 375, 430, 1280]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(150);
        const m = await measure();
        const label = `${view} at ${w}px`;
        assert.ok(m.over <= 1, `${label}: the page is ${m.over}px wider than the screen`);
        for (const r of m.rows) {
          assert.ok(r.sideRight <= m.vw - 4, `${label}: Edit/Download run off the right edge (${Math.round(r.sideRight)} of ${m.vw})`);
          assert.ok(r.sideLeft >= r.infoRight - 1, `${label}: Edit/Download overlap the text`);
          if (w < 900) assert.ok(r.titleLines <= 2.2, `${label}: a title takes ${r.titleLines.toFixed(1)} lines`);
        }
        if (w < 900) {                                       // every row's links line up, whatever its title length
          const lefts = new Set(m.rows.map((r) => Math.round(r.sideLeft)));
          assert.strictEqual(lefts.size, 1, `${label}: links are not aligned: ${[...lefts]}`);
        }
        if (view === "library" && w === 375) await page.screenshot({ path: path.join(tmp, "long-library-375.png") });
      }
    }
    console.log("ok  long titles, notes and tag names never widen the page or push Edit/Download off-screen (Library and Inbox, 320 to 1280px)");

    // an open form on a long-titled row
    await page.setViewportSize({ width: 375, height: 800 });
    await page.click("#tab-library");
    await page.locator("#list > li button.edit-btn").first().click();
    await page.waitForSelector("#list form.edit");
    const m = await measure();
    assert.ok(m.over <= 1, "an open form on a long-titled row widens the page by " + m.over);
    console.log("ok  an open form on a long-titled row stays within the screen");

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
