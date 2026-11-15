// Page start-up order: the Library's ideas are fetched only when its tab opens (a counts-only request at start), and a returning visitor's lists are
// requested at the same moment as the session check. Run:  RIFFBOX_PY=/path/to/python node tests/e2e/startup.cjs
const { setup } = require("./_helpers.cjs");

const { BASE, wav, server, waitUp, launch: launchBrowser, assert } = setup({ port: 8236, name: "startup", wavSeconds: 3 });

(async () => {
  let browser, failed = false;
  try {
    await waitUp(BASE);
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    for (const [i, title] of ["Alpha", "Beta"].entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 31) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    await ctx.request.patch(BASE + "api/recordings/1", { data: { status: "tagged", tags: ["bass"] } });
    await ctx.request.patch(BASE + "api/recordings/2", { data: { status: "tagged", tags: ["keys"] } });

    const sequence = [];
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("request", (r) => { const u = r.url().replace(BASE, ""); if (u.startsWith("api/")) sequence.push("req " + u); });
    page.on("response", (r) => { const u = r.url().replace(BASE, ""); if (u.startsWith("api/")) sequence.push("res " + u); });
    const waitTabs = () => page.waitForFunction(() => /Library \(2\)/.test(document.querySelector("#tab-library").textContent));

    // 1. first visit (no hint in this browser yet): counts only for the Library, and the plain order session -> lists
    await page.goto(BASE);
    await waitTabs();
    assert.ok(sequence.some((s) => s === "req api/groups?status=tagged&limit=0"), "the Library is asked for its counts only: " + sequence.join(" | "));
    assert.ok(!sequence.some((s) => s.startsWith("req api/groups?status=tagged&sort=")), "the Library list is not fetched at start");
    console.log("ok  at start the Library is fetched as counts only (limit=0), and its tab still shows the count");

    // 2. opening the tab fetches the list, and the rows appear
    await page.click("#tab-library");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 2);
    assert.ok(sequence.some((s) => s.startsWith("req api/groups?status=tagged&sort=")), "opening the Library tab fetches its list");
    console.log("ok  opening the Library tab fetches its list and the two ideas appear");

    // 3. back to the Inbox and to the Library again without any change: no second fetch
    const before = sequence.filter((s) => s.startsWith("req api/groups?status=tagged&sort=")).length;
    await page.click("#tab-inbox"); await page.click("#tab-library");
    await page.waitForFunction(() => document.querySelectorAll("#list > li").length === 2);
    assert.strictEqual(sequence.filter((s) => s.startsWith("req api/groups?status=tagged&sort=")).length, before, "no needless second fetch");
    console.log("ok  switching tabs back and forth without a change does not fetch the Library again");

    // 4. a returning visitor (the page remembers it was logged in): the lists are requested BEFORE the session answer arrives
    sequence.length = 0;
    await page.reload();
    await waitTabs();
    const iList = sequence.indexOf("req api/groups?status=inbox&sort=recorded&order=desc");
    const iSession = sequence.indexOf("res api/session");
    assert.ok(iList >= 0 && iSession >= 0 && iList < iSession, "lists requested before the session answer: " + sequence.join(" | "));
    console.log("ok  a returning visitor's lists are requested at the same moment as the session check");

    // 5. logged out: no failed list requests on a fresh visit (a clean console), and the login page shows
    const fresh = await (await launchBrowser()).newContext();
    const p2 = await fresh.newPage();
    const failedCalls = [];
    p2.on("response", (r) => { if (r.url().includes("/api/groups") && r.status() === 401) failedCalls.push(r.url()); });
    await p2.goto(BASE);
    await p2.waitForSelector("#login:not([hidden])");
    assert.deepStrictEqual(failedCalls, [], "a visitor who was never logged in makes no list requests");
    console.log("ok  a fresh visitor sees the login page with no failed list requests");
    await fresh.browser().close();

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
