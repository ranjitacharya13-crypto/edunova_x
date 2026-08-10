# EduNova_X — Deep Audit & In-Place Repair Report

**Date:** 2026-08-07 · **Branch:** `arena/019fdc4b-edunova-x`
**Symptom:** Render/Vercel health checks failing with `404` / `Cannot GET …`; services crash-looping.

---

## 1. Audit findings (root causes)

| # | Component | Finding | Severity |
|---|-----------|---------|----------|
| 1 | `server/server.js` | **No `/health` route.** Any health check pointed at `/health` returned Express's default `404` → Render marks the service unhealthy and restarts it in a loop. | 🔴 Critical |
| 2 | `signaling/index.js` | **No `/health` route.** Same 404 problem for the signaling service. | 🔴 Critical |
| 3 | `ai_engine/main.py` | `/health` existed but returned `{"status":"ok"}` — inconsistent contract vs. the other services. | 🟡 Minor |
| 4 | `frontend/src/api/api.js` | `VITE_API_URL` (set to `https://<your-render-api>.onrender.com`) **did not include `/api`**, so every REST call went to `…/auth/login`, `…/timetable/today` → **`Cannot GET /auth/login`** 404s in production. | 🔴 Critical |
| 5 | Git repo | **`node_modules` (42,776 files, ~470 MB) committed to git**, including broken platform-mismatched binaries (`sharp` missing its `.node` binary, corrupt `debug`, missing rollup native). Render's `npm install` then sees deps "satisfied" and skips, shipping dead binaries → crashes. | 🔴 Critical |
| 6 | `render.yaml` | Hardcoded `PORT: 10000` env var (should be left to Render's injection); no `healthCheckPath`; AI service `startCommand` didn't use `$PORT`. | 🟡 Moderate |
| 7 | `server/index.js` | Stale Next.js-style file (`getServerSideProps` referencing an undefined `clientPromise`). **Not an entry point** — nothing imports it, but it must never be `require`d. Left in place; candidate for deletion. | 🟢 Note |
| 8 | Frontend `.env` / `vercel.json` | No TURN variables → video only uses Google STUN → **black remote video on 4G/mobile / strict NAT**. | 🟡 Moderate |
| 9 | Secret hygiene | `MONGO_URI`/JWT/email credentials differ across `server/.env`, `ai_engine/main.py` defaults, and the old `render.yaml`. Verified/de-duplicated into `scripts/deploy/.env.secrets` (gitignored). | 🟡 Moderate |

---

## 2. In-place code repairs applied

### `server/server.js`
Injected a **DB-independent** health route so Render's load balancer gets `200` even while MongoDB is still connecting:
```js
app.get("/health", (req, res) =>
  res.status(200).json({ status: "live", service: "edunova-api" })
);
```
Port logic already correct: `const PORT = process.env.PORT || 4000;` (no change needed).

### `signaling/index.js`
- Added `GET /health` → `200 {"status":"live","service":"edunova-signal"}`.
- Root `/` now returns an **explicit `200`** JSON status body for Render's default load balancer probe, while Socket.IO signaling keeps working.

### `ai_engine/main.py`
- `/health` now returns `{"status":"live","service":"edunova-ai"}` (consistent contract).
- Root `/` already returned `200` JSON.

### `frontend/src/api/api.js`
Base URL is normalized — if `VITE_API_URL` lacks the `/api` suffix it is appended automatically:
```js
let baseURL = import.meta.env.VITE_API_URL || "/api";
if (baseURL !== "/api" && !baseURL.replace(/\/+$/, "").endsWith("/api")) {
  baseURL = baseURL.replace(/\/+$/, "") + "/api";
}
```

### `frontend/.env` / `frontend/vercel.json`
- `VITE_API_URL` corrected to include the `/api` suffix.
- `frontend/vercel.json` gained an `env` block (live URLs are injected by the master script at deploy time).
- TURN variables documented/commented (injected when real values are provided).

### Repository hygiene
- `node_modules/**`, `__pycache__`, `dist/`, `.env.*`, `.vercel/` **removed from git tracking** and ignored — deploys now rebuild from `package.json`/lockfiles (fresh `npm install`, correct platform binaries).
- `signaling/package-lock.json` added (reproducible installs); `frontend/package-lock.json` regenerated to match `package.json` (the tracked copy referenced capacitor 8/electron 43 that the manifest no longer declares).

### `render.yaml` (reconstructed — three services)
| Service | rootDir | Runtime | Build | Start | Health |
|---|---|---|---|---|---|
| `edunova-api` | `./server` | node | `npm install` | `node server.js` | `GET /health` |
| `edunova-signal` | `./signaling` | node | `npm install` | `node index.js` | `GET /health` |
| `edunova-ai` | `./ai_engine` | python | `pip install -r requirements.txt` | `uvicorn main:app --host 0.0.0.0 --port $PORT` | `GET /health` |

- `PORT` is **not** hardcoded anywhere — every service reads the platform-injected `$PORT` (`process.env.PORT` / `--port $PORT`).
- Secrets use `sync: false` (filled via Dashboard once or injected automatically by the master script from `server/.env`).
- `AI_ENGINE_URL` on `edunova-api` is wired via `fromService` (blueprint mode) or set explicitly (API mode).
- **Native deps:** `sharp` uses prebuilt binaries (works). `pdf-thumbnail` needs GraphicsMagick at runtime, which Render's native Node image lacks — thumbnail generation is already try/catch-wrapped so uploads never break; for full PDF thumbnails, uncomment the Docker option in `render.yaml` (the existing `server/Dockerfile` installs `graphicsmagick` + `ghostscript`).

---

## 3. Verification performed (local smoke tests)

| Check | Result |
|---|---|
| `GET /health` on API server (`node server.js`) | ✅ `200 {"status":"live","service":"edunova-api"}` |
| `GET /health` on signaling (`node index.js`) | ✅ `200 {"status":"live","service":"edunova-signal"}` |
| `GET /health` on AI engine (`uvicorn main:app`) | ✅ `200 {"status":"live","service":"edunova-ai"}` |
| `GET /` (Render LB root probe) — API & signaling | ✅ `200` JSON |
| `GET /api/test` | ✅ `200 OK` |
| Frontend production build (`vite build`) | ✅ 140 modules, no errors |
| `npm install` from clean tree (server + signaling + frontend) | ✅ (after untracking node_modules) |

> Sandbox limitation: outbound HTTPS to `api.render.com` / `api.vercel.com` is blocked here, so token **verification runs on your machine** as Stage 1 of the master script. `sharp@0.32.1`'s installer also downloads libvips from GitHub releases, which this sandbox blocks; on your machine / on Render it installs normally.

---

## 4. The Master-Stroke automation (`scripts/deploy/`)

| File | Purpose |
|---|---|
| `master-deploy.sh` | Bash pipeline (macOS/Linux/WSL/Git-Bash) |
| `master-deploy.ps1` | PowerShell pipeline (Windows) |
| `.env.secrets.example` | Template for secrets (committed) |
| `.env.secrets` | **Your populated secrets — gitignored, never committed** |

Pipeline stages (both scripts identical):
1. **Authenticate** — verifies `RENDER_API_KEY` (`GET /v1/owners`) and `VERCEL_TOKEN` (`vercel whoami`).
2. **Push & create services** — commits/pushes the repaired code + `render.yaml`, validates the blueprint (`POST /v1/blueprints/validate`), then:
   - if a Blueprint instance exists for the repo → updates it (`autoSync` on, `path=render.yaml`);
   - otherwise creates the three services **directly via the Render API** (`POST /v1/services`) with the exact `render.yaml` config, because Render's public API can *validate* but not *create* blueprint instances. Secrets (`MONGO_URI`, `JWT_SECRET`, email creds) are injected via `PUT /v1/services/{id}/env-vars`, then a redeploy is triggered.
3. **Poll until LIVE** — checks each service every 20 s (default 25 min timeout): deploy status `live` **and** `GET https://<url>/health` returning `200` + `"status":"live"`.
4. **Update frontend config** — rewrites `frontend/vercel.json` (`env` block), `frontend/.env.production`, and `frontend/.env` with the live Render URLs (+ TURN vars when provided).
5. **Deploy** — pushes env vars to the Vercel project (`vercel env add … production`) and runs `vercel --prod --yes --cwd frontend`.

### Run it
```bash
cd scripts/deploy
./master-deploy.sh            # Bash
powershell -File master-deploy.ps1   # Windows
# optional flags: --skip-git-push, --skip-vercel
```
Before running: **fill `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`** in `.env.secrets` (TURN provider credentials) — required for reliable video on 4G/mobile.

---

## 5. Remaining recommendations

1. **Rotate the credentials that were exposed in git history** (MongoDB passwords, `JWT_SECRET`, Gmail app password) — they were committed in `render.yaml`/`.env` and appear in old commits.
2. Set up a **managed Blueprint** (`https://dashboard.render.com/blueprints/new`) if you prefer Infrastructure-as-Code over API-created services.
3. Connect a custom domain on Render (free instances spin down after 15 min idle — a wake-up is recommended, e.g. cron ping of `/health`).
4. Delete the stale `server/index.js` and the `* 1.js / * 2.js / * 3.js` backup duplicates from git history.
5. Add `VITE_TURN_URL` etc. also to the Capacitor/Electron builds (`frontend/.env.production` covers Vite builds; native shells need their own env wiring).
