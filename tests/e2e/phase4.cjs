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
// The browser runs in Pacific/Auckland (UTC+13 in November), where local time and UTC clearly differ.
const AKL = "Pacific/Auckland";
const today = () => new Date().toLocaleDateString("en-US", { dateStyle: "medium", timeZone: AKL });
const dayInAkl = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: AKL, dateStyle: "short" }).format(new Date(iso));   // 2026-03-01
const autoTitleAt = (iso) => {                     // what the page should name a recording uploaded at this instant
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: AKL, month: "short", day: "numeric", hour: "numeric",
                                                    minute: "2-digit", hour12: true }).formatToParts(new Date(iso));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `Idea, ${g("month")} ${g("day")} ${g("hour")}:${g("minute")}${g("dayPeriod").toLowerCase()}`;
};

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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
                                           timezoneId: AKL, locale: "en-US" });
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

    // --- uploads land in the Inbox (the page's clock is pinned: 03:50 UTC is 4:50pm in Auckland)
    await page.clock.setFixedTime(new Date("2026-11-08T03:50:00Z"));
    await page.setInputFiles("#file", files.slice(0, 2));
    await waitTab("#tab-inbox", "Inbox (2)");
    assert.strictEqual(await rows().count(), 2);
    assert.strictEqual(await tabText("#tab-library"), "Library");
    console.log("ok  two uploads appear in the Inbox with a count of 2");

    // the automatic name is the local time (not UTC); the date line shows only the date, which starts as the upload date
    assert.deepStrictEqual(await page.locator("#list .title").allTextContents(), ["Idea, Nov 8 4:50pm", "Idea, Nov 8 4:50pm"]);
    const shown = await page.locator("#list").innerText();
    assert.ok(shown.includes(today()), "the date line shows the upload date: " + today());
    assert.doesNotMatch(shown, /\d:\d\d\s*[AP]M/, "the date line is date-only");
    assert.doesNotMatch(shown, /uploaded/, "no '(uploaded ...)' note while the date recorded is the upload date");
    console.log("ok  automatic names use local time (4:50pm = 03:50 UTC + 13h); the date line shows the upload date");

    // --- tag one recording using every field
    await rows().first().locator(".title").click();              // highlight the row first, as a person would by playing it
    await rows().first().locator("button.edit-btn").click();
    const form = page.locator("#list form.edit");
    await form.waitFor();
    // regression: the highlighted row's left bar once sat on top of the form's left edge on a phone
    const gaps = await page.evaluate(() => {
      const li = document.querySelector("#list > li.selected");
      const l = li.getBoundingClientRect().left;
      return { selected: Boolean(li), field: document.querySelector("#list form.edit input[type=text]").getBoundingClientRect().left - l,
               play: li.querySelector(".play").getBoundingClientRect().left - l };
    });
    assert.ok(gaps.selected && gaps.field >= 8 && gaps.play >= 8, "content is inset from the highlight bar: " + JSON.stringify(gaps));
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
    assert.strictEqual(await form.locator("input[type=radio]").count(), 0, "no Slow/Medium/Fast buttons in the form any more");
    const bpm = form.locator("input[type=number]");
    for (let i = 0; i < 4; i++) { await form.locator("button", { hasText: "Tap tempo" }).click(); await page.waitForTimeout(500); }
    const tapped = Number(await bpm.inputValue());
    assert.ok(tapped >= 80 && tapped <= 150, "tap tempo near 120, got " + tapped);
    await bpm.fill("118");
    await form.locator("select[id^=f-root-]").selectOption("D");
    await form.locator("select[id^=f-mode-]").selectOption("minor");
    await form.locator("textarea").fill("hummed over Dm,\nsecond line");
    await page.screenshot({ path: path.join(tmp, "form.png"), fullPage: true });
    await form.locator("button", { hasText: "Save and move to Library" }).click();
    await waitTab("#tab-inbox", "Inbox (1)");
    await waitTab("#tab-library", "Library (1)");
    assert.strictEqual(await notice(), "Saved. Moved to Library.");
    assert.strictEqual(await rows().count(), 1);
    console.log("ok  every field saved; recording moved from Inbox to Library; counts updated");

    // --- an untouched form saves too (all fields optional)
    await rows().first().locator("button.edit-btn").click();
    await page.locator("#list form.edit").locator("button", { hasText: "Save and move to Library" }).click();
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
      assert.match(text, /118 BPM · D minor/);
      assert.doesNotMatch(text, /Fast|Slow|Medium/, "no tempo words are shown");
      assert.match(text, /hummed over Dm/);
      assert.deepStrictEqual(await funky.locator(".chip.tag").allTextContents(), ["bass", "rhythmic idea", "beat box"]);
    };
    await show();
    await page.reload(); await page.waitForSelector("#app:not([hidden])");
    await waitTab("#tab-library", "Library (2)");
    await page.click("#tab-library");
    await show();
    console.log("ok  Library shows tags, BPM, key and notes, and they persist across a reload");

    // --- editing prefills; move back to the Inbox
    await funky.locator("button.edit-btn").click();
    const f2 = page.locator("#list form.edit");
    assert.strictEqual(await f2.locator("input[id^=f-title-]").inputValue(), "Funky bass riff");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="bass"]').getAttribute("aria-pressed"), "true");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="drums"]').getAttribute("aria-pressed"), "false");
    assert.strictEqual(await f2.locator('button.tagbtn[data-tag="beat box"]').getAttribute("aria-pressed"), "true");  // custom tag persisted
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
    await f3.locator("button", { hasText: "Save and move to Library" }).click();
    await waitTab("#tab-inbox", "Inbox (1)");
    await page.waitForFunction(() => document.querySelector("#list > li") !== null);
    assert.strictEqual(await rows().count(), 1, "the new upload shows up once the form is closed");
    console.log("ok  corrected value saves; the new upload appears");

    // clearing the Title box regenerates the name in local time (this also repairs older UTC-based names)
    await page.click("#tab-library");
    const plain = page.locator("#list > li", { hasText: "Idea, Nov 8 4:50pm" });
    await plain.locator("button.edit-btn").click();
    await page.locator("#list form.edit input[id^=f-title-]").fill("temporary name");
    await page.locator("#list form.edit button[type=submit]").click();
    await page.locator("#list > li", { hasText: "temporary name" }).waitFor();
    await page.locator("#list > li", { hasText: "temporary name" }).locator("button.edit-btn").click();
    await page.locator("#list form.edit input[id^=f-title-]").fill("   ");
    await page.locator("#list form.edit button[type=submit]").click();
    const apiRows = async () => (await (await ctx.request.get(BASE + "api/recordings?status=tagged")).json()).recordings;
    const plainRec = (await apiRows()).find((r) => r.notes === "" && r.tags.length === 0);   // the one saved with an empty form
    const uploadedAt = plainRec.uploaded_at;
    assert.strictEqual(plainRec.recorded_at, uploadedAt, "premise: its date recorded is its upload date");
    await page.locator("#list > li", { hasText: autoTitleAt(uploadedAt) }).waitFor();
    console.log("ok  clearing the Title box regenerates the local-time name");

    // --- date recorded: blank means the date uploaded; entering one stores both; clearing goes back
    const row = () => page.locator("#list > li", { hasText: autoTitleAt(uploadedAt) });
    await row().locator("button.edit-btn").click();
    let f = page.locator("#list form.edit");
    const dateBox = f.locator("input[type=date]");
    assert.strictEqual(await dateBox.inputValue(), "", "the date recorded is blank by default");
    assert.match(await f.innerText(), /Leave it blank to use the date it was uploaded \(/);
    await dateBox.fill("2025-12-25");
    await f.locator("button[type=submit]").click();
    await page.waitForFunction((t) => [...document.querySelectorAll("#list > li")].some((li) => li.innerText.includes(t)), `Dec 25, 2025 (uploaded ${today()})`);
    let after = (await apiRows()).find((r) => r.recorded_at.startsWith("2025-12-24") || r.recorded_at.startsWith("2025-12-25"));
    assert.ok(after && after.uploaded_at !== after.recorded_at, "both dates are stored, and they differ");
    assert.strictEqual(dayInAkl(after.recorded_at), "2025-12-25", "the entered day is the day it shows");
    await page.locator("#list > li", { hasText: "Dec 25, 2025" }).locator("button.edit-btn").click();
    f = page.locator("#list form.edit");
    assert.strictEqual(await f.locator("input[type=date]").inputValue(), "2025-12-25", "the form shows the entered date");
    await f.locator("input[id^=f-title-]").fill("");                              // a blank title now follows the entered date
    await f.locator("button[type=submit]").click();
    await page.locator("#list > li", { hasText: "Idea, Dec 25" }).waitFor();
    await page.locator("#list > li", { hasText: "Idea, Dec 25" }).locator("button.edit-btn").click();
    f = page.locator("#list form.edit");
    await f.locator("input[type=date]").fill("");                                  // clear the date: back to the upload date
    await f.locator("button[type=submit]").click();
    await page.waitForFunction((t) => [...document.querySelectorAll("#list > li")].some((li) => li.innerText.includes(t) && !li.innerText.includes("(uploaded")), today());
    after = (await apiRows()).find((r) => r.title === "Idea, Dec 25");
    assert.strictEqual(after.recorded_at, after.uploaded_at, "cleared: the date recorded is the date uploaded again");
    console.log("ok  date recorded: blank = date uploaded; an entered date is stored beside it; clearing restores it");

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
