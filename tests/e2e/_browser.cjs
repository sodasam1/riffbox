// Which browser the browser tests drive. Default: Chromium. To run a script in the engine behind Safari or in Firefox:
//   RIFFBOX_BROWSER=webkit  RIFFBOX_PY=app/.venv/bin/python node tests/e2e/phase3.cjs
//   RIFFBOX_BROWSER=firefox RIFFBOX_PY=app/.venv/bin/python node tests/e2e/phase3.cjs
// (one-time: `npx playwright install webkit firefox`; on Linux WebKit also needs `npx playwright install-deps webkit`).
// A few scripts use Chromium's DevTools protocol (network details, CPU throttling); they say so and stop on other engines.
const pw = require("playwright");
const name = process.env.RIFFBOX_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(name)) throw new Error("RIFFBOX_BROWSER must be chromium, firefox or webkit");
module.exports = {
  name,
  launch: (options) => pw[name].launch(options),
  chromiumOnly(script) {
    if (name !== "chromium") { console.log(`skipped ${script}: it needs Chromium's DevTools protocol (running ${name})`); process.exit(0); }
  },
};
