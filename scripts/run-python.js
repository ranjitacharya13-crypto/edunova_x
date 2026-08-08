#!/usr/bin/env node
/**
 * run-python.js — cross-platform Python launcher for LOCAL DEVELOPMENT.
 *
 * Why: `python` is not a valid command on most Linux/macOS setups (it is
 * `python3`), and the Windows launcher is `py`. Hardcoding any one of them
 * breaks development on the other platforms.
 *
 * This is NOT used in production. On Render the AI engine runs directly with:
 *     uvicorn main:app --host 0.0.0.0 --port $PORT
 * (see render.yaml), with rootDir: ai_engine.
 *
 * Usage:
 *     node scripts/run-python.js -m uvicorn main:app --host 0.0.0.0 --port 8001
 *
 * Commands are executed with ai_engine/ as the working directory so that
 * `main:app` and `requirements.txt` resolve exactly like they do on Render.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const aiEngineDir = path.resolve(__dirname, "..", "ai_engine");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-python.js -m uvicorn main:app --host 0.0.0.0 --port 8001");
  process.exit(1);
}

// Preference order. A virtualenv (VIRTUAL_ENV) always wins so an activated
// venv is respected.
const candidates = [];
if (process.env.PYTHON) candidates.push(process.env.PYTHON);
if (process.env.VIRTUAL_ENV) {
  candidates.push(
    path.join(process.env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
  );
}
candidates.push("python3", "python");
if (process.platform === "win32") candidates.push("py");

function works(bin) {
  const probe = spawnSync(bin, ["--version"], { stdio: "ignore", shell: false });
  return probe.status === 0;
}

const python = candidates.find(works);

if (!python) {
  console.error(
    "❌ No Python interpreter found. Install Python 3.11+ and ensure `python3` " +
      "(or `py` on Windows) is on your PATH, or set the PYTHON environment variable."
  );
  process.exit(1);
}

const result = spawnSync(python, args, {
  cwd: aiEngineDir,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status === null ? 1 : result.status);
