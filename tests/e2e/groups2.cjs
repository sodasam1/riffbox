// Groups, stage 2: Select in the Inbox, the grouping dialog, adding to a group, the Parts list, upload as one idea. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/groups2.cjs
const { launch } = require("./_browser.cjs");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const PORT = 8212, BASE = `http://127.0.0.1:${PORT}/ideas/`;
const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riffbox-e2e-groups2-"));

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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US" });
    const up = async (title, freq) => (await (await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
      multipart: { file: { name: `${title}.wav`, mimeType: "audio/wav", buffer: wav(freq) }, title } })).json());
    const ups = {};
    for (const [i, t] of ["A", "B", "C", "D", "E"].entries()) ups[t] = await up(t, 150 + i * 23);
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    await ctx.request.patch(BASE + `api/groups/${ups.A.group_id}`, { data: { bpm: 120, tags: [] } });
    await ctx.request.patch(BASE + `api/groups/${ups.B.group_id}`, { data: { bpm: 96, key_root: "A", key_mode: "minor" } });
    const api = async (q = "") => (await (await ctx.request.get(BASE + "api/groups" + q)).json()).groups;
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#list > li");
    const notice = () => page.textContent("#notice").then((t) => t.trim());
    const rowOf = (t) => page.locator(`#list > li[data-title="${t}"]`);

    // Select mode exists in the Inbox, with Group… (needs two) and without Move to Inbox
    await page.click("#select-toggle");
    assert.ok(await page.isVisible("#bulkbar") && await page.isHidden("#bulk-inbox") && await page.isDisabled("#bulk-group"));
    for (const t of ["A", "B", "C"]) await rowOf(t).locator(".rowsel").check();
    assert.ok(await page.isEnabled("#bulk-group"));
    console.log("ok  Select mode works in the Inbox; Group… needs at least two");

    // one click: no dialog. The tempos disagree (120 vs 96), so both are kept to be picked later; the key is filled in
    await page.click("#bulk-group");
    await page.waitForFunction(() => /Grouped 3 recordings as/.test(document.querySelector("#notice").textContent));
    assert.match(await notice(), /disagree on tempo; pick one in Edit/);
    assert.ok(await page.locator("dialog").count() === 0, "there is no dialog any more");
    let g = (await api("?status=inbox")).find((x) => x.parts.length === 3);
    assert.ok(g && g.bpm === null && g.key_root === "A" && g.status === "inbox");
    assert.deepStrictEqual(g.unresolved.bpm.map((c) => c.value), [120, 96]);
    assert.ok(!g.unresolved.key);
    const gid = g.id;
    await page.waitForSelector(`#list > li[data-gid="${gid}"] .chip.pending`);
    assert.match(await page.locator(`#list > li[data-gid="${gid}"] .chip.pending`).textContent(), /pick tempo/);
    console.log("ok  Group… is one click; a tempo clash is kept, flagged on the row, and the rest is filled in");

    // resolve it later in Edit by picking one of the two
    await page.click("#bulk-done");
    await page.locator(`#list > li[data-gid="${gid}"] button.edit-btn`).click();
    assert.strictEqual(await page.locator("#list form.edit .pending-note button").count(), 3);
    await page.locator("#list form.edit .pending-note button", { hasText: "96 BPM" }).click();
    assert.strictEqual(await page.inputValue("#list form.edit input[type=number]"), "96");
    await page.locator("#list form.edit button", { hasText: /^Save$/ }).click();
    await page.waitForFunction(() => !document.querySelector("#list form.edit"));
    g = (await api("?status=inbox")).find((x) => x.id === gid);
    assert.ok(g.bpm === 96 && g.unresolved === null);
    assert.strictEqual(await page.locator(`#list > li[data-gid="${gid}"] .chip.pending`).count(), 0);
    await page.click("#select-toggle");
    console.log("ok  picking a tempo in Edit settles it and clears the flag");

    // add another recording to that group
    await page.click("#select-toggle");     // Select mode was left by the reload? make sure it is on
    if (!(await page.isVisible("#bulkbar"))) await page.click("#select-toggle");
    await rowOf("D").locator(".rowsel").check();
    await page.selectOption("#bulk-addto", { value: String(gid) });
    await page.waitForFunction(() => /Added 1 recording to/.test(document.querySelector("#notice").textContent));
    g = (await api("?status=inbox")).find((x) => x.id === gid);
    assert.strictEqual(g.parts.length, 4);
    console.log("ok  Add to group… adds the selected recording as another part");

    // the edit form lists the parts: rename, reorder, save
    if (await page.isVisible("#bulkbar")) await page.click("#bulk-done");
    await page.locator(`#list > li[data-gid="${gid}"]`).locator("button.edit-btn").click();
    const items = page.locator("#list form.edit .parts-list > li");
    assert.strictEqual(await items.count(), 4);
    await items.nth(0).locator("input").fill("Keys");
    await items.nth(1).locator('button[aria-label="Move this part up"]').click();
    await page.locator("#list form.edit button", { hasText: /^Save$/ }).click();
    await page.waitForFunction(() => !document.querySelector("#list form.edit"));
    g = (await api("?status=inbox")).find((x) => x.id === gid);
    assert.deepStrictEqual(g.parts.map((p) => p.title), ["B", "Keys", "C", "D"]);
    console.log("ok  parts can be renamed and reordered from the edit form");

    // take one part out (two presses), then break the rest up (two presses)
    await page.locator(`#list > li[data-gid="${gid}"]`).locator("button.edit-btn").click();
    const out = page.locator("#list form.edit .parts-list > li").nth(3).locator("button.link");
    await out.click(); await out.click();
    await page.waitForFunction(() => /Took the recording out/.test(document.querySelector("#notice").textContent));
    g = (await api("?status=inbox")).find((x) => x.id === gid);
    assert.strictEqual(g.parts.length, 3);
    assert.ok(await rowOf("D").count() === 1, "the part became its own idea again");
    await page.locator(`#list > li[data-gid="${gid}"]`).locator("button.edit-btn").click();
    const brk = page.locator("#list form.edit fieldset > button.link.danger");
    await brk.click(); await brk.click();
    await page.waitForFunction(() => /Broke the idea up/.test(document.querySelector("#notice").textContent));
    assert.strictEqual((await api("?status=inbox")).filter((x) => x.parts.length > 1).length, 0);
    console.log("ok  Take out and Break up this idea return the recordings to ordinary ideas");

    // upload several files as one idea
    await page.check("#as-one");
    await page.setInputFiles("#file", [{ name: "x1.wav", mimeType: "audio/wav", buffer: wav(310) }, { name: "x2.wav", mimeType: "audio/wav", buffer: wav(333) }]);
    await page.waitForFunction(() => /as one idea/.test(document.querySelector("#notice").textContent));
    g = (await api("?status=inbox")).find((x) => x.parts.length === 2);
    assert.ok(g, "two uploads became one idea");
    assert.strictEqual(await page.isChecked("#as-one"), false);
    console.log("ok  Upload several files as one idea makes one idea with two parts");

    // trash and restore a whole idea
    await ctx.request.delete(BASE + `api/groups/${g.id}`);
    await page.reload(); await page.waitForSelector("#list > li");
    await page.click("#tab-trash");
    const trashed = page.locator("#list > li", { hasText: "2 parts" });
    await trashed.waitFor();
    await trashed.locator("button.restore-btn").click();
    await page.waitForFunction(() => /Restored/.test(document.querySelector("#notice").textContent));
    assert.ok((await api("?status=inbox")).some((x) => x.id === g.id && x.parts.length === 2));
    console.log("ok  a grouped idea goes to the Trash and comes back whole");

    assert.deepStrictEqual(problems, [], "browser errors: " + problems.join(" | "));
    console.log("ok  no unexpected console or page errors");
  } catch (e) {
    failed = true; console.error("FAIL", e.message, e.stack.split("\n").find((l) => l.includes("groups2.cjs")));
  } finally {
    if (browser) await browser.close();
    server.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();
