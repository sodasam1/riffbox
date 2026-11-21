// The minimal theme: switch in the Menu, remembered, applied before first paint, switches back, and still lays out
// and reads well (no overflow, contrast) in light and dark. Run:
//   RIFFBOX_PY=/path/to/python node tests/e2e/theme.cjs
const { setup } = require("./_helpers.cjs");

const { PORT, BASE, PY, ROOT, tmp, server, waitUp, wav, launch, assert, fs, os, path } = setup({ port: 8203, name: "theme", wavSeconds: 6 });

function lum(hex) { hex = hex.replace("#", ""); if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
  const c = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const LONG = "Averyveryveryverylongtitlewithoutanyspacesatalleveryletterrunstogetherandkeepsgoingforaverylongtimeindeed1234567890";

(async () => {
  let browser, failed = false;
  try {
    await waitUp();
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "en-US" });
    const titles = [LONG, "Second idea", "Third idea", "Fourth idea"];
    for (const [i, title] of titles.entries()) {
      const r = await ctx.request.post(BASE + "api/upload", { headers: { Authorization: "Bearer tok" },
        multipart: { file: { name: `m${i}.wav`, mimeType: "audio/wav", buffer: wav(150 + i * 19) }, title } });
      assert.strictEqual(r.status(), 201);
    }
    await ctx.request.post(BASE + "api/login", { data: { passphrase: "open sesame" } });
    for (let id = 1; id <= titles.length; id++) {
      assert.strictEqual((await ctx.request.patch(BASE + `api/recordings/${id}`, { data: { status: "tagged", rating: id % 2 ? "heart" : null, bpm: 100 + id, key_root: "A", key_mode: "minor", notes: "n",
        tags: id === 2 ? ["bass", "keys", "drums", "guitar", "harmony", "vocal", "melody"] : ["bass"] } })).status(), 200);
    }
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
    await page.goto(BASE);
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#tab-library"); await page.waitForSelector("#list > li");
    await page.locator("#list > li button.play").first().click();                               // something loaded in the player
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme || "original");
    const look = () => page.evaluate(() => {
      const cs = (s, p) => getComputedStyle(document.querySelector(s))[p], r = document.querySelector("#playerbar").getBoundingClientRect();
      return { tabShadow: cs('#views button[aria-pressed="true"]', "boxShadow"), tabBg: cs('#views button[aria-pressed="true"]', "backgroundColor"),
               chipBorder: cs(".chip.tag", "borderTopWidth"), barRadius: cs("#playerbar", "borderTopLeftRadius"), barLeft: Math.round(r.left), barRight: Math.round(r.right), vw: innerWidth,
               accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), text: getComputedStyle(document.documentElement).getPropertyValue("--text").trim(),
               link: cs("#data-link", "color") }; });

    // ---- minimal by default; the switch is in the Menu (Minimal on the left, Original on the right)
    assert.strictEqual(await theme(), "minimal");
    const min = await look();
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute("#theme-minimal", "aria-pressed"), "true");
    assert.strictEqual(await page.$eval("#theme-minimal", (b) => b.nextElementSibling.id), "theme-original", "Minimal is the left slot");
    assert.strictEqual((await page.textContent("#theme-original")).trim(), "Original");
    assert.deepStrictEqual(await page.$$eval("#menu .theme-group > .meta", (e) => e.map((x) => x.textContent.trim())), ["Style", "Theme", "Accent color"]);
    await page.click("#theme-original");
    assert.ok(await page.isHidden("#menu"), "choosing it closes the menu");
    assert.strictEqual(await theme(), "original");
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("riffbox.theme")), "original");
    const std = await look();
    assert.strictEqual(min.accent, std.accent, "both styles start with the same accent colour");
    assert.strictEqual(min.chipBorder, "0px"); assert.notStrictEqual(std.chipBorder, "0px");
    assert.strictEqual(min.barRadius, "0px"); assert.notStrictEqual(std.barRadius, "0px");
    assert.ok(min.barLeft === 0 && min.barRight === min.vw && std.barLeft > 0, "the player is docked edge to edge in minimal");
    assert.notStrictEqual(min.tabShadow, "none"); assert.strictEqual(std.tabShadow, "none");
    assert.notStrictEqual(std.tabBg, "rgba(0, 0, 0, 0)"); assert.strictEqual(min.tabBg, "rgba(0, 0, 0, 0)");
    console.log("ok  minimal is the default; Original is on the right: flat tabs, plain tags, a docked player versus the original look");

    // ---- remembered, and applied before the page is drawn
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.strictEqual(await theme(), "original", "the saved theme is applied from the <head>, before first paint");
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute("#theme-original", "aria-pressed"), "true");
    await page.click("#theme-minimal");
    assert.strictEqual(await theme(), "minimal");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.strictEqual(await theme(), "minimal"); await page.waitForSelector("#app:not([hidden])");
    console.log("ok  the choice is remembered, applied before first paint, and the menu says how to switch back");

    // ---- layout holds in minimal (cozy, compact, select, edit form, data page), light and dark
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.click("#tab-library"); await page.waitForSelector("#list > li");
      for (const w of [320, 390, 768, 1024, 1240, 1280, 1600]) {
        await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
        for (const mode of ["cozy", "compact", "select"]) {
          if (mode === "cozy") { await page.click("#dens-cozy"); if (await page.getAttribute("#select-toggle", "aria-pressed") === "true") await page.click("#select-toggle"); }
          if (mode === "compact") await page.click("#dens-compact");
          if (mode === "select") await page.click("#select-toggle");
          await page.waitForTimeout(80);
          const m = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            sides: Math.max(...[...document.querySelectorAll("#list > li .side")].map((s) => s.getBoundingClientRect().right)), vw: innerWidth }));
          assert.ok(m.over <= 1 && m.sides <= m.vw, `minimal/${scheme}/${mode} at ${w}px: ${m.over}px too wide`);
        }
        await page.click("#select-toggle"); await page.click("#dens-cozy");
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.click("#dens-compact");
      const tags = await page.locator("#list > li", { hasText: "Second idea" }).locator(".tags").evaluate((box) => ({ more: box.querySelector(".more")?.textContent || null,
        shown: [...box.querySelectorAll(".chip.tag:not(.more)")].filter((c) => !c.hidden).map((c) => c.scrollWidth <= c.clientWidth + 1) }));
      assert.ok((tags.more === null || /^\+\d+$/.test(tags.more)) && tags.shown.length >= 2 && tags.shown.every(Boolean), "compact tags in minimal: " + JSON.stringify(tags));      // plain words are narrow: often all seven fit
      await page.click("#dens-cozy");
      await page.locator("#list > li button.edit-btn").first().click(); await page.waitForSelector("#list form.edit");
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1, "edit form overflows in minimal");
      await page.click("#list form.edit button:has-text('Cancel')");
      for (const w of [320, 390]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.click("#menu-btn"); await page.click("#data-link"); await page.waitForSelector("#data-view:not([hidden])"); await page.waitForTimeout(300);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1, `data page overflows in minimal at ${w}px`);
        await page.click("#data-back"); await page.waitForSelector("#main-view:not([hidden])");
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      // contrast of every text colour pair
      const v = await page.evaluate(() => Object.fromEntries(["bg", "panel", "text", "muted", "accent", "accent-text", "err", "ok", "warn"].map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim()])));
      for (const [fg, bg] of [["text", "bg"], ["muted", "bg"], ["muted", "panel"], ["accent", "bg"], ["accent-text", "accent"], ["err", "bg"], ["err", "panel"], ["warn", "bg"]]) {
        const rr = ratio(v[fg], v[bg]);
        assert.ok(rr >= 4.5, `minimal/${scheme}: ${fg} (${v[fg]}) on ${bg} (${v[bg]}) has contrast ${rr.toFixed(2)}`);
      }
    }
    console.log("ok  minimal: nothing overflows from 320 to 1600px (cozy, compact, select, edit form, data page), tags still fit whole, contrast is 4.5:1 or better, light and dark");

    // ---- and back
    await page.emulateMedia({ colorScheme: "light" });
    await page.click("#menu-btn"); await page.click("#theme-original");
    assert.strictEqual(await theme(), "original");
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("riffbox.theme")), "original");
    const back = await look();
    assert.deepStrictEqual({ ...back, vw: 0 }, { ...std, vw: 0 }, "switching back restores the standard look exactly");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.strictEqual(await theme(), "original", "and it stays original after a reload");
    console.log("ok  switching back restores the standard look exactly, and that is remembered too");

    // ---- colours are a separate choice from the style
    const colors = () => page.evaluate(() => document.documentElement.dataset.colors || "auto");
    const paint = () => page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme,
      chip: getComputedStyle(document.querySelector(".chip.tag")).borderTopWidth, tab: getComputedStyle(document.querySelector('#views button[aria-pressed="true"]')).boxShadow,
      vars: Object.fromEntries(["bg", "panel", "text", "muted", "accent", "accent-text", "err", "warn"].map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue("--" + n).trim()])) }));
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute("#colors-auto", "aria-pressed"), "true");
    await page.click("#colors-dark");
    await page.click("#tab-library"); await page.waitForSelector("#list > li .chip.tag");
    assert.strictEqual(await colors(), "dark"); assert.strictEqual(await theme(), "original", "colours do not change the style");
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("riffbox.colors")), "dark");
    let d = await paint();
    assert.strictEqual(d.bg, "rgb(21, 21, 23)", "dark colours even though the device is set to light");
    assert.strictEqual(d.scheme, "dark"); assert.strictEqual(d.tab, "none"); assert.notStrictEqual(d.chip, "0px");         // still the standard shapes
    for (const [fg, bg] of [["text", "bg"], ["muted", "bg"], ["muted", "panel"], ["accent", "bg"], ["accent-text", "accent"], ["err", "bg"], ["err", "panel"], ["warn", "bg"]]) {
      const rr = ratio(d.vars[fg], d.vars[bg]);
      assert.ok(rr >= 4.5, `standard/dark: ${fg} on ${bg} has contrast ${rr.toFixed(2)}`);
    }
    // the other style, dark: minimal shapes with the minimal dark palette
    await page.click("#menu-btn"); await page.click("#theme-minimal");
    d = await paint();
    assert.strictEqual(d.bg, "rgb(16, 16, 16)"); assert.strictEqual(d.chip, "0px"); assert.strictEqual(await colors(), "dark");
    for (const [fg, bg] of [["text", "bg"], ["muted", "bg"], ["muted", "panel"], ["accent", "bg"], ["err", "bg"], ["warn", "bg"]]) {
      assert.ok(ratio(d.vars[fg], d.vars[bg]) >= 4.5, `minimal/dark: ${fg} on ${bg}`);
    }
    // forced light on a device set to dark, in both styles
    await page.emulateMedia({ colorScheme: "dark" });
    await page.click("#menu-btn"); await page.click("#colors-light");
    d = await paint(); assert.strictEqual(d.bg, "rgb(255, 255, 255)"); assert.strictEqual(d.chip, "0px");
    await page.click("#menu-btn"); await page.click("#theme-original");
    d = await paint(); assert.strictEqual(d.bg, "rgb(255, 255, 255)"); assert.notStrictEqual(d.chip, "0px");
    // auto follows the device again
    await page.click("#menu-btn"); await page.click("#colors-auto");
    assert.strictEqual(await colors(), "auto");
    d = await paint(); assert.strictEqual(d.bg, "rgb(21, 21, 23)", "auto + a dark device is dark");
    await page.emulateMedia({ colorScheme: "light" });
    d = await paint(); assert.strictEqual(d.bg, "rgb(255, 255, 255)", "auto + a light device is light");
    // both choices are remembered and applied before first paint
    await page.click("#menu-btn"); await page.click("#theme-minimal"); await page.click("#menu-btn"); await page.click("#colors-dark");
    for (const w of [320, 390, 1280]) {
      await page.setViewportSize({ width: w, height: 800 }); await page.waitForTimeout(120);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1, `minimal dark overflows at ${w}px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.strictEqual(await theme(), "minimal"); assert.strictEqual(await colors(), "dark", "both are applied from the <head> after a reload");
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute("#colors-dark", "aria-pressed"), "true"); assert.strictEqual(await page.getAttribute("#theme-minimal", "aria-pressed"), "true");
    await page.click("#theme-original"); await page.click("#menu-btn"); await page.click("#colors-auto");
    console.log("ok  Style (minimal, original) and Theme (auto, light, dark) are separate choices that combine, are remembered, and keep contrast at 4.5:1");

    // ---- accent colour: swatches in the Menu, applied to primary buttons and the active tab, remembered, right in light and dark
    await page.click("#menu-btn");
    assert.strictEqual(await page.getAttribute('#accent-row [data-a="blue"]', "aria-pressed"), "true", "blue is the default accent");
    const acc = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    await page.emulateMedia({ colorScheme: "light" });
    await page.click('#accent-row [data-a="blue"]');
    assert.strictEqual(await acc(), "#1d5fd1"); assert.strictEqual(await page.evaluate(() => localStorage.getItem("riffbox.accent")), "blue");
    for (const style of ["minimal", "original"]) {
      await page.click("#menu-btn"); await page.click("#theme-" + style);
      assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.accent), "blue");
      assert.strictEqual(await page.$eval("#views button[aria-pressed=true]", (b) => getComputedStyle(b).backgroundColor), style === "minimal" ? "rgba(0, 0, 0, 0)" : "rgb(29, 95, 209)");
    }
    await page.click("#menu-btn"); await page.click("#colors-dark");
    assert.strictEqual(await acc(), "#6ea8ff", "dark uses the lighter variant of the same accent");
    const sw = await page.evaluate(() => getComputedStyle(document.querySelector('#accent-row [data-a="blue"]')).backgroundColor);
    assert.strictEqual(sw, "rgb(110, 168, 255)", "the swatch shows the dark variant in dark colours");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    assert.strictEqual(await acc(), "#6ea8ff", "the accent is applied from the <head> after a reload");
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#menu-btn"); await page.click("#colors-auto"); await page.click("#menu-btn"); await page.click('#accent-row [data-a="orange"]');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("riffbox.accent")), "orange");
    console.log("ok  Accent colour swatches change the accent in both styles, light and dark, and are remembered");

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
