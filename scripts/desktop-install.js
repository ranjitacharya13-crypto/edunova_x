#!/usr/bin/env node
/**
 * desktop-install.js — install the FULL dependency tree (including Electron)
 * for desktop development/packaging, without letting Electron's binary
 * download abort the install.
 *
 * electron@28's postinstall reads ONLY the ELECTRON_SKIP_BINARY_DOWNLOAD
 * environment variable (npm config / .npmrc keys are ignored by install.js).
 * On networks where github.com downloads are blocked or TLS-intercepted the
 * postinstall dies with:
 *
 *   npm error command sh -c node install.js
 *   npm error RequestError: unable to verify the first certificate
 *
 * Skipping the download is safe: electron-builder fetches its own Electron
 * distribution at packaging time (`npm run desktop:build`). If you need the
 * `electron` CLI locally to RUN the app, set ELECTRON_SKIP_BINARY_DOWNLOAD=0
 * and re-run this script on a network that allows the download.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const skip = process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ?? "1";

console.log(
  skip === "0"
    ? "[desktop-install] downloading the Electron binary (ELECTRON_SKIP_BINARY_DOWNLOAD=0)…"
    : "[desktop-install] installing with the Electron binary download skipped."
);

const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: skip },
});

process.exit(result.status === null ? 1 : result.status);
