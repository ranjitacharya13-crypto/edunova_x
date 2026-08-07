# EduNova X desktop release

The desktop release is an Electron launcher. On its first run it presents an installation window with a live stdout/stderr log, checks Node.js v20+ and npm, installs `server/`, `frontend/`, and `signaling/` dependencies, and builds the React frontend. `ai_engine/` is Python-only in this repository and is reported as skipped rather than incorrectly running npm.

## Build prerequisites

- Node.js 20 or newer and npm on `PATH`
- Windows: Visual Studio Build Tools with **Desktop development with C++** if npm needs to compile `sharp` or `pdf-thumbnail`
- macOS: Xcode Command Line Tools for native module compilation
- A MongoDB Atlas URI and (optionally) TURN credentials for the first-launch form

## Build the installer

From the repository root:

```bash
npm install
npm run desktop:build
```

Artifacts are written to `release/`:

- Windows: `EduNova-X-Setup-<version>.exe`
- macOS: `EduNova-X-<version>.dmg`
- Linux (optional): AppImage

Use `npm run desktop:win` or `npm run desktop:mac` to target one platform. Electron Builder must be run on the target OS (or a configured CI cross-build environment).

## Install scope and launcher

The NSIS wizard is configured as a non-one-click installer with elevation enabled. The setup window also presents **Install for just me** and **Install for all users (requires admin)**, while the installer uses a per-user default to avoid unexpected elevation. The **all users** choice should be paired with an elevated install location selected in the NSIS wizard. The desktop shortcut starts the Electron Launcher Service, which starts `server/server.js` on port 4000 and opens `http://localhost:4000` in the default browser.

The generated runtime is copied to the OS user-data directory before dependencies are installed, so the server's `.env` remains writable even when the application is installed under a protected folder. Secrets are stored in that local runtime and are excluded from Git.
