#!/usr/bin/env node
/**
 * ensure-server-deps.js
 * ---------------------------------------------------------------------------
 * Guarantees that `server/node_modules` is populated before the backend runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Express API lives in `server/` and declares its own dependencies in
 * `server/package.json`. The recommended Render configuration deploys it with
 * `rootDir: server` (see render.yaml), in which case Render runs
 * `npm install` *inside* `server/` and this script is a no-op.
 *
 * However, when the Render service is configured at the REPOSITORY ROOT, the
 * build only runs `npm install` at the root and then `npm start`
 * -> `npm start --prefix server` -> `node server.js`. `--prefix` changes the
 * script's working directory but does NOT install anything, so
 * `server/node_modules` is missing. Node then walks up and resolves whatever
 * happens to exist in the ROOT `node_modules`, which silently "works" for a
 * few packages and then dies on the first one that is missing:
 *
 *     Error: Cannot find module 'nodemailer'
 *
 * That is a dependency-resolution accident, not a real install. This script
 * makes the root deployment path reproducible from a clean environment by
 * performing the install the build step forgot.
 *
 * It is intentionally idempotent, cross-platform (no npm.cmd / no `set "`),
 * and safe to run from a build step or immediately before boot.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const serverDir = path.join(rootDir, "server");
const serverPkgPath = path.join(serverDir, "package.json");

function log(msg) {
  console.log(`[ensure-server-deps] ${msg}`);
}

/**
 * Every runtime dependency declared by the backend must be physically present
 * in server/node_modules. Checking the declared list (rather than a hardcoded
 * one) means a newly added dependency is covered automatically.
 */
function missingDependencies() {
  const pkg = JSON.parse(fs.readFileSync(serverPkgPath, "utf8"));
  const declared = Object.keys(pkg.dependencies || {});
  return declared.filter(
    (dep) => !fs.existsSync(path.join(serverDir, "node_modules", dep, "package.json"))
  );
}

function runNpm(args) {
  // `npm` (not npm.cmd) — Render/Linux safe. shell:true only on win32 so local
  // Windows development keeps working.
  const result = spawnSync("npm", args, {
    cwd: serverDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  return result.status === 0;
}

function ensure({ fatal }) {
  if (!fs.existsSync(serverPkgPath)) {
    log("server/package.json not found — nothing to install.");
    return true;
  }

  let missing;
  try {
    missing = missingDependencies();
  } catch (err) {
    log(`could not read server/package.json: ${err.message}`);
    return !fatal;
  }

  if (missing.length === 0) {
    log("server dependencies already installed ✔");
    return true;
  }

  log(`missing ${missing.length} backend dependency(ies): ${missing.join(", ")}`);
  log("installing them in ./server (this is what the build step should have done)...");

  const hasLockfile = fs.existsSync(path.join(serverDir, "package-lock.json"));

  // Prefer `npm ci` for a clean, lockfile-exact install. It requires the
  // lockfile to be in sync with package.json; if it is not, fall back to
  // `npm install` so a deployment is never blocked by a lockfile drift.
  let ok = false;
  if (hasLockfile) {
    ok = runNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"]);
    if (!ok) {
      log("`npm ci` failed — falling back to `npm install`.");
      ok = runNpm(["install", "--omit=dev", "--no-audit", "--no-fund"]);
    }
  } else {
    ok = runNpm(["install", "--omit=dev", "--no-audit", "--no-fund"]);
  }

  if (!ok) {
    log("❌ dependency installation FAILED.");
    return false;
  }

  const stillMissing = missingDependencies();
  if (stillMissing.length) {
    log(`❌ still missing after install: ${stillMissing.join(", ")}`);
    return false;
  }

  log("server dependencies installed ✔");
  return true;
}

module.exports = { ensure, missingDependencies };

if (require.main === module) {
  // `--soft` is used by the root postinstall hook: a failure there must not
  // break unrelated builds (e.g. the Cloudflare frontend build), because the
  // pre-start check will run the install again and fail loudly if needed.
  const soft = process.argv.includes("--soft");

  // The Cloudflare frontend build also runs a root `npm install`. It has no use
  // for the backend's native modules (sharp, pdf-thumbnail), so skip there.
  const isFrontendOnlyBuild =
    process.env.SKIP_SERVER_DEPS === "1" ||
    process.env.CF_PAGES === "1" ||
    Boolean(process.env.CLOUDFLARE_ACCOUNT_ID) ||
    Boolean(process.env.WORKERS_CI);

  if (soft && isFrontendOnlyBuild) {
    log("frontend-only build detected (or SKIP_SERVER_DEPS=1) — skipping.");
    process.exit(0);
  }

  const ok = ensure({ fatal: !soft });
  if (!ok && !soft) process.exit(1);
  process.exit(0);
}
