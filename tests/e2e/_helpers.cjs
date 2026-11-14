// Shared set-up for the browser tests: a temporary data folder, a Riffbox server serving the real page under /ideas (as in
// production), a small WAV maker, and the browser to drive (see _browser.cjs for choosing Chromium, WebKit or Firefox).
//
//   const { PORT, BASE, tmp, wav, server, waitUp, launch, assert, fs, path } = setup({ port: 8199, name: "phase3", wavSeconds: 6 });
//
// `setup` starts the server at once. Options: port (required, unique per script), name (for the temporary folder), wavSeconds (default length
// of wav()), ffmpeg (false: the server runs without ffmpeg, the default; true: it finds ffmpeg itself), env (extra settings for the server:
// an object, or a function (tmp, path) => object when they need the temporary folder).
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { launch, name: browserName, chromiumOnly } = require("./_browser.cjs");

const PY = process.env.RIFFBOX_PY || "python3";
const ROOT = path.resolve(__dirname, "..", "..");

function wav(freq, seconds = 6, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}

/** Start a server on `port` with its data in `data`. */
function startServer({ port, data, ffmpeg = false, env = {} }) {
  return spawn(PY, ["-m", "waitress", `--listen=127.0.0.1:${port}`, "wsgi:app"], {
    cwd: path.join(ROOT, "app"),
    env: { ...process.env, RIFFBOX_DATA_DIR: data, RIFFBOX_SECRET: "e2e", RIFFBOX_UPLOAD_TOKEN: "tok", RIFFBOX_PASSPHRASE: "open sesame",
           RIFFBOX_INSECURE_COOKIES: "1", RIFFBOX_BASE_PATH: "/ideas", RIFFBOX_STATIC_DIR: path.join(ROOT, "static"),
           ...(ffmpeg ? {} : { RIFFBOX_FFMPEG: "" }), ...env },
    stdio: "inherit",
  });
}

async function waitUp(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "health")).ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

function setup({ port, name = "e2e", wavSeconds = 6, ffmpeg = false, env = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `riffbox-e2e-${name}-`));
  const BASE = `http://127.0.0.1:${port}/ideas/`;
  const server = startServer({ port, data: path.join(tmp, "data"), ffmpeg, env: typeof env === "function" ? env(tmp, path) : env });
  return {
    PORT: port, BASE, PY, ROOT, tmp, server, assert, fs, os, path, launch, browserName, chromiumOnly, startServer,
    wav: (freq, seconds = wavSeconds, rate = 8000) => wav(freq, seconds, rate),
    waitUp: (base = BASE) => waitUp(base),
  };
}

module.exports = { setup, startServer, waitUp, wav, PY, ROOT, chromiumOnly };
