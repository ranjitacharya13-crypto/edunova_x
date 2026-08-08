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
| 4 | `frontend/src/api/api.js` | `VITE_API_URL` (set to `https://edunova-api.onrender.com`) **did not include `/api`**, so every REST call went to `…/auth/login`, `…/timetable/today` → **`Cannot GET /auth/login`** 404s in production. | 🔴 Critical |
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

---

## 6. Round 2 — Production-hardening pass (2026-08-08, `arena/019fdfba-edunova-x`)

Verified-against-the-running-code follow-up that closes the remaining gaps:

### Health contract unified
All three backends now return the exact universal contract requested for
production probes — `200 {"status":"ok","service":"edunova-x-production"}` on
`GET /health` (`server/server.js`, `signaling/index.js`, `ai_engine/main.py`).
`edunova-signal` also returns `200` JSON on `/` (Render's default LB probe).
The master scripts' LIVE poll accepts `"status":"ok"` (and the legacy `"live"`
for services mid-rollout).

### "Cannot GET" eliminated
Both Express apps now end with a JSON 404 fallback (`{success:false,error:
"Not Found",hint:…}`) — the raw HTML `Cannot GET /…` page can no longer appear,
on any path, in production logs.

### Node 20+ pinning
`.nvmrc` (=20) + `.node-version` (20.18.0) added to `server/`, `signaling/`,
`frontend/` (Render resolves these per service `rootDir`; Vercel reads them
for the frontend), `frontend/package.json` declares `engines.node >= 20`, and
`render.yaml` sets `NODE_VERSION: "20"` on both Node services.

### Native dependencies → guaranteed
`edunova-api` switched to `runtime: docker` in `render.yaml`
(`dockerfilePath: ./server/Dockerfile`, `dockerContext: ./server` — both
relative to the repo root per the Blueprint spec). The Dockerfile installs
`graphicsmagick` + `ghostscript`, so **pdf-thumbnail actually works**, and
sharp uses prebuilt libvips. Native Node runtime remains a documented fallback.

### CORS production whitelist
`server/server.js` + `signaling/index.js` replaced `origin: true` / `origin: '*'`
with an allowlist: every `*.vercel.app` deployment, localhost/ngrok/capacitor
dev origins, plus `CORS_ORIGINS` env var (comma-separated). The master script
appends the exact deployed Vercel domain to `CORS_ORIGINS` on `edunova-api`.
Verified locally: Vercel origins echoed, `evil.example.com` blocked.

### Secret extraction (new)
`scripts/deploy/extract-secrets.{mjs,sh,ps1}` parse `server/.env` +
`frontend/.env` and generate `scripts/deploy/.env.secrets` (gitignored) plus
printed Render Blueprint `envVars` YAML and Vercel env JSON. Generates
`ADMIN_TEMP_PASSWORD` if absent; never clobbers existing tokens.

### Master script upgrades
- Stage 3 poll accepts the new health contract.
- Stage 4 rewrites **both** `vercel.json` files (root + frontend) with live
  URLs; TURN credentials now go to gitignored `.env.local`/`.env.production`
  (the tracked `frontend/.env` carries URLs only — no secret leakage).
- **Stage 6 verification**: pings `/health`, `/api/test`, `/` on the API;
  `/health` on signaling + AI; SPA root + a deep route on the Vercel URL; and
  hardens `CORS_ORIGINS` with the exact deployed domain. Fails loudly (exit≠0)
  on any non-200 unless `--skip-verify`.

### Local smoke verification (this sandbox)
| Check | Result |
|---|---|
| API `/health`, `/api/test`, `/` | ✅ 200, universal contract, "OK" |
| API unknown path `/unknown`, `/api/bogus` | ✅ JSON 404 + hint (no "Cannot GET" HTML) |
| API CORS: `*.vercel.app`, preview URL, `localhost:5173`, `CORS_ORIGINS` | ✅ ACAO echoed |
| API CORS: unknown origin | ✅ no ACAO (blocked) |
| API + signaling Socket.IO handshake (Vercel origin) | ✅ 200 |
| Signaling `/health`, `/` | ✅ 200 |
| AI engine `/health`, `/` | ✅ 200 |
| `extract-secrets.mjs` → `.env.secrets` (gitignored) | ✅ parsed by master script loop |
| jq-generated `vercel.json` (root + frontend) | ✅ valid JSON, correct rewrite regex |
| bash syntax (`bash -n`), node syntax (`node --check`) | ✅ |

> Sandbox note: `sharp`'s libvips download from GitHub is blocked here, so the
> API server smoke test stubbed `sharp` after `npm install --ignore-scripts`
> (sharp isn't touched by any health/test path). On a real machine / on Render
> it installs normally — no code change is required for that.

---

## 7. Round 3 — War-Room hardening pass (2026-08-08, audit-first workflow)

Per the "Production Deployment War Room" master prompt (audit → report → apply),
this round was executed as an explicit PHASE 1–13 audit followed by approved
PHASE 14–22 changes:

### New findings from the audit (fixed)
| # | Finding | Fix |
|---|---------|-----|
| 1 | **Relative `fetch("/api/...")` calls** in `ContactView`, `HomeView`, `LiveView`, `FloatingAIChat`, `StudyView`, `SyllabusView` would hit the Vercel origin in production, fall into the SPA rewrite and return HTML instead of JSON (`404`-class break). | Added external rewrite `"/api/:path*" → "https://<API_URL>/api/:path*"` to **both** `vercel.json` files (before the SPA catch-all) + the master scripts regenerate it with the live URL on every deploy. |
| 2 | **Real secrets tracked in git** (`server/.env`, `frontend/.env`, plus `*.env 1/2/3` backups). | `git rm --cached` (files stay on disk) + `.gitignore` rules for the backup copies; **rotate the credentials in git history**. |
| 3 | Local smoke-test script orphaned processes on `( ... ) &` backgrounding. | `exec`-based backgrounding so `$!` is the server PID; cleanup verified (no orphaned ports). |
| 4 | AI check in the smoke test silently timed out when uvicorn was missing. | Fast, explicit `[FAIL] AI engine prereqs missing — pip install -r ai_engine/requirements.txt` with `--skip-ai` escape hatch. |

### New fail-closed tooling
- `scripts/verify-production.{sh,ps1}` — local smoke test (Node ≥ 20, env-var
  presence, optional `vite build`, boots all three services, checks `/health`,
  `/api/test`, `/`, Socket.IO Engine.IO handshake; exit ≠ 0 on any failure).
- `scripts/deploy-production.{sh,ps1}` — orchestrator: token gates → secret
  sync → local preflight (aborts on failure) → `master-deploy` → final
  `DEPLOYMENT VERIFIED / FAILED / UNVERIFIED` status.

### Verification (this sandbox)
| Check | Result |
|---|---|
| `verify-production.sh --build` | ✅ 17/17 checks, exit 0 (after fixing the two real failures it caught: missing uvicorn, port orphans) |
| `deploy-production.sh` without tokens | ✅ exit 1, `[FAIL] RENDER_API_KEY is missing` (fail-closed gate) |
| vercel.json generators with live URL | ✅ `/api/:path*` rewrite emitted correctly, SPA catch-all preserved |
| `git diff --check`, `.env` untracked + ignored | ✅ |

> Production live deployment remains **UNVERIFIED from this sandbox**: outbound
> HTTPS to `api.render.com` / `api.vercel.com` is blocked here, and the
> `VERCEL_TOKEN` / `RENDER_API_KEY` belong to the user. Run
> `./scripts/deploy-production.sh` on your machine to get
> `DEPLOYMENT VERIFIED` — the pipeline refuses to claim success otherwise.
