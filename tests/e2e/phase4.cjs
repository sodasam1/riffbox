// Phase 4 browser test (inbox + intake form). Run:  RIFFBOX_PY=/path/to/python node tests/e2e/phase4.cjs
// Self-contained on purpose (like phase3.cjs): starts the app under /ideas and drives Chromium.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8198, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e4-"));

function wav(freq, seconds = 2, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const files = [110, 220, 330].map((f, i) => {
  const p = path.join(tmp, `memo-${i}.wav`);
  fs.writeFileSync(p, wav(f));
  return p;
});

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
    let n401 = 0, n400 = 0;                       // deliberate: logged-out session check; one rejected save
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (m.text().includes("401")) n401++;
      else if (m.text().includes("400")) n400++;
      else problems.push("console: " + m.text());
    });

    const tabText = async (id) => (await page.textContent(id)).trim();
    const waitTab = (id, text) => page.waitForFunction(([i, t]) => document.querySelector(i).textContent.trim() === t, [id, text]);
    const rows = () => page.locator("#list > li");
    const notice = () => page.textContent("#notice");

    // --- login, empty states
    await page.goto(BASE);
    await page.fill("#pass", "open sesame"); await page.click("#login-form button");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForFunction(() => /Nothing yet/.test(document.querySelector("#empty").textContent));
    assert.strictEqual(await tabText("#tab-inbox"), "Inbox");
    console.log("ok  fresh start: empty Inbox, no counts");

    // --- uploads land in the Inbox
    await page.setInputFiles("#file", files.slice(0, 2));
    await waitTab("#tab-inbox", "Inbox (2)");
    assert.strictEqual(await rows().count(), 2);
    assert.strictEqual(await tabText("#tab-library"), "Library");
    console.log("ok  two uploads appear in the Inbox with a count of 2");

    // --- tag one recording using every field
    await rows().first().locator("button.edit-btn").click();
    const form = page.locator("#list form.edit");
    await form.waitFor();
    assert.strictEqual(await form.locator("button.tagbtn").count(), 9, "nine seeded tags offered");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id.startsWith("f-title-")), true, "title gets focus");
    await form.locator("input[type=text][id^=f-title-]").fill("Funky bass riff");
    await form.locator('button.tagbtn[data-tag="bass"]').click();
    await form.locator('button.tagbtn[data-tag="rhythmic idea"]').click();
    const newTag = form.locator('input[placeholder="new tag"]');
    await newTag.fill("  Beat   BOX ");
    await newTag.press("Enter");                                  // Enter adds the tag, it must not submit the form
    await form.locator('button.tagbtn[data-tag="beat box"][aria-pressed="true"]').waitFor();
    assert.ok(await form.isVisible(), "form still open after Enter in the new-tag box");
    await form.locator('input[type=radio][value="fast"]').check();
    const bpm = form.locator("input[type=number]");
    for (let i = 0; i < 4; i++) { await form.locator("button", { hasText: "Tap tempo" }).click(); await page.waitForTimeout(500); }
    const tapped = Number(await bpm.inputValue());
    assert.ok(tapped >= 80 && tapped <= 150, "tap tempo near 120, got " + tapped);
    await bpm.fill("118");
    await form.locator("select[id^=f-root-]").selectOption("D");
    await form.locator("select[id^=f-mode-]").selectOption("minor");
    await form.locator("textarea").fill("hummed over Dm,\nsecond line");
    await page.screenshot({ path: path.join(tmp, "form.png"), fullPage: true });
    await form.locator("button[type=submit]").click();
    await waitTab("#tab-inbox", "Inbox (1)");
    await waitTab("#tab-library", "Library (1)");
    assert.strictEqual(await notice(), "Saved. Moved to Library.");
    assert.strictEqual(await rows().count(), 1);
    console.log("ok  every field saved; recording moved from Inbox to Library; counts updated");

    // --- an untouched form saves too (all fields optional)
    await rows().first().locator("button.edit-btn").click();
    await page.locator("#list form.edit button[type=submit]").click();
    await waitTab("#tab-library", "Library (2)");
    await waitTab("#tab-inbox", "Inbox");
    await page.waitForFunction(() => /Nothing waiting to be tagged/.test(document.querySelector("#empty").textContent));
    console.log("ok  saving a completely empty form works and empties the Inbox");

    // --- Library shows the details; they survive a reload
    await page.click("#tab-library");
    assert.strictEqual(await rows().count(), 2);
    const funky = page.locator("#list > li", { hasText: "Funky bass riff" });
    const show = async () => {
      const text = await funky.innerText();
      assert.match(text, /Fast · 118 BPM · D minor/);
      assert.match(text, /hummed over Dm/);
      assert.deepStrictEqual(await funky.locator(".chip.tag").allTextContents(), ["bass", "rhythmic idea", "beat box"]);
    };
    await show();
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    await waitTab("#tab-library", "Library (2)");
    await page.click("#tab-library");
    await show();
    console.log("ok  Library shows tags, tempo, BPM, key and notes, and they persist across a reload");

    // --- editing prefills; move back to the Inbox
    await funky.locator("button.edit-btn").click();
    const f2 = page.locator("#list form.edit");
    assert.strictEqual(await f2.locator("input[id^=f-title-]").inputValue(), "Funky bass riff");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="bass"]').getAttribute("aria-pressed"), "true");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="drums"]').getAttribute("aria-pressed"), "false");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="beat box"]').getAttribute("aria-pressed"), "true");  // custom tag persisted
    assert.ok(await f2.locator('input[type=radio][value="fast"]').isChecked());
    assert.strictEqual(await f2.locator("input[type=number]").inputValue(), "118");
    assert.strictEqual(await f2.locator("select[id^=f-root-]").inputValue(), "D");
    assert.strictEqual(await f2.locator("select[id^=f-mode-]").inputValue(), "minor");
    await f2.locator("button", { hasText: "Move back to Inbox" }).click();
    await waitTab("#tab-inbox", "Inbox (1)");
    assert.strictEqual(await notice(), "Moved back to Inbox.");
    console.log("ok  edit form is prefilled; Move back to Inbox works");

    // --- a rejected value shows the server's message and keeps what was typed
    await page.click("#tab-inbox");
    await rows().first().locator("button.edit-btn").click();
    const f3 = page.locator("#list form.edit");
    await f3.locator("textarea").fill("keep me");
    await f3.locator("input[type=number]").fill("5");
    await f3.locator("button[type=submit]").click();
    await page.waitForFunction(() => /between 20 and 400/.test(document.querySelector("#list form.edit .error:not([hidden])")?.textContent || ""));
    assert.strictEqual(await f3.locator("textarea").inputValue(), "keep me");
    console.log("ok  invalid BPM is rejected with a clear message and the form keeps its contents");

    // --- an upload finishing must not wipe a form someone is typing in
    await page.setInputFiles("#file", [files[2]]);
    await waitTab("#tab-inbox", "Inbox (2)");
    assert.strictEqual(await page.locator("#list form.edit textarea").inputValue(), "keep me");
    console.log("ok  an upload completing while a form is open leaves the form (and its text) alone");
    await f3.locator("input[type=number]").fill("120");
    await f3.locator("button[type=submit]").click();
    await waitTab("#tab-inbox", "Inbox (1)");
    await page.waitForFunction(() => document.querySelector("#list > li") !== null);
    assert.strictEqual(await rows().count(), 1, "the new upload shows up once the form is closed");
    console.log("ok  corrected value saves; the new upload appears");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    assert.strictEqual(n401, 1, "exactly one expected 401 (logged-out session check), got " + n401);
    assert.strictEqual(n400, 1, "exactly one expected 400 (the rejected BPM), got " + n400);
    console.log("ok  no unexpected console or page errors");
    console.log("screenshot:", path.join(tmp, "form.png"));
  } catch (e) {
    failed = true; console.error("FAIL", e.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
