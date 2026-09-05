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

---

# Addendum — 2026-09-05 · Self-hosted AI model startup 404

**Branch:** `arena/01a071df-edunova-x` · **PR:** #39
**Symptom:** every EduNova AI question (e.g. "what is ml") answered
*"The self-hosted EduNova AI model failed to start on the server.
(model download failed with HTTP 404)"*.

## 1. Root cause

`LOCAL_MODEL_FILE` defaulted to **`Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf`**.
That quantization **has never been published** in
`bartowski/Qwen2.5-0.5B-Instruct-GGUF`. The URL the service builds —

```
https://huggingface.co/{LOCAL_MODEL_REPO}/resolve/main/{LOCAL_MODEL_FILE}
```

— therefore resolved to a file that does not exist, and Hugging Face returned
its `Entry not found` **404** page. `LocalModelManager` correctly refused to
load a non-GGUF HTML body, the model never reached `ready`, and every chat
turn short-circuited into the download error. The 404 was **not** a network,
auth, quota, or Render problem: it was a wrong filename baked into five files.

Confirmed against the HF file tree — the repo publishes `Q2_K`, `Q3_K_M`,
`IQ4_XS`, `Q4_K_S`, `Q4_K_M`, `Q5_K_M`, `Q8_0`, and **no `IQ3_XXS`**.

## 2. Old vs new configuration

| | Before | After |
|---|---|---|
| `LOCAL_MODEL_REPO` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | unchanged |
| `LOCAL_MODEL_FILE` | `Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf` (**does not exist → 404**) | `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (**verified, 397,808,192 B**) |
| `LOCAL_MODEL_CTX` | `3072` | `6144` |
| `AGENT_MAX_CONTEXT_CHARS` | `24000` | `12000` (must fit the window) |
| `llama-cpp-python` | `0.2.90` | `0.3.35` (prebuilt CPU wheel) |
| Weights cache | ephemeral `./models_cache` | persistent disk `/var/data/models` (2GB) |
| Render plan (`edunova-ai`) | free | `standard` (2GB / 1 CPU) |

New env vars: `LOCAL_MODEL_BYTES`, `LOCAL_MODEL_MIN_BYTES` (default 10MB),
`LOCAL_MODEL_DOWNLOAD_RETRIES` (default 3). Nothing was removed — MongoDB,
`AI_INTERNAL_TOKEN`, auth, CORS, web search and EduNova API config are intact.
No secrets were added to the repo.

## 3. Secondary defects found and fixed

| # | Defect | Fix |
|---|---|---|
| 1 | Oversized prompts crashed llama.cpp mid-request, surfacing as `502 LLM_PROVIDER_UNAVAILABLE` on exactly the data-rich questions the agent exists for. `AGENT_MAX_CONTEXT_CHARS` (24000 ≈ 8000 tokens) could not fit `LOCAL_MODEL_CTX` (3072). | Runtime context guard trims the middle of the tool context and logs `LOCAL_MODEL_PROMPT_TRUNCATED`; context/env budgets rebalanced. |
| 2 | A greedy decode that immediately emits the stop token produced an empty answer and a hard error. | One warmer retry (`LOCAL_MODEL_EMPTY_RETRY`); still never fabricates output. |
| 3 | `self_test()` treated an empty warmup decode as a health failure. | Warmup asserts "a decode ran without raising"; empty *chat* answers still error. |
| 4 | A truncated/corrupt cached file would be loaded blindly. | Cache re-validated on boot (size + `GGUF` magic); `LOCAL_MODEL_CACHE_REJECTED` triggers a refetch. |
| 5 | `AI_PROVIDER_ERROR` logged `host=api.openai.com` for the in-process model. | Logs `host=in-process:llama.cpp` for the local provider. |
| 6 | UI said "Ready to help" while the model was still downloading. | `useAIStatus` gates on real readiness and shows download progress. |

## 4. Diagnostics now emitted

Startup: `AI_SERVICE_STARTUP`, `LOCAL_MODEL_STARTUP`, `LOCAL_MODEL_SOURCE`
(URL, expected bytes, sha256-pinned, estimated RAM), `LOCAL_MODEL_RUNTIME`,
`LOCAL_MODEL_SOURCE_OK`, `LOCAL_MODEL_DOWNLOAD_START`,
`LOCAL_MODEL_DOWNLOAD_RETRY`, `LOCAL_MODEL_DOWNLOADED`,
`LOCAL_MODEL_CACHE_HIT`, `LOCAL_MODEL_CACHE_REJECTED`,
`LOCAL_MODEL_LOAD_START`, `LOCAL_MODEL_READY`, `LOCAL_MODEL_ERROR`.

On failure, instead of a bare 404 string:

```
MODEL_STARTUP_ERROR
Model: bartowski/Qwen2.5-0.5B-Instruct-GGUF:<file>.gguf
URL: https://huggingface.co/.../resolve/main/<file>.gguf
Status: 404
Stage: preflight
Reason: model file not found at the configured URL
Fix: LOCAL_MODEL_FILE does not exist in LOCAL_MODEL_REPO. Verify the exact
     filename at https://huggingface.co/<repo>/tree/main ...
```

The student-facing response is a clean
`503 LLM_MODEL_UNAVAILABLE` — the raw 404 never reaches the browser.

## 5. Health contract

`GET /api/ai/health` (and `?deep=true` for an active inference probe) reports
all four required signals plus download progress:

```json
{"modelReady": true, "modelState": "ready",
 "readiness": {"modelFileExists": true, "runtimeAvailable": true,
               "modelInitialized": true, "inferenceAvailable": true}}
```

`GET /api/ai/model/source-check` validates the configured URL without loading
the model — run it before changing `LOCAL_MODEL_FILE`.

## 6. Verification

- `ai_engine`: **90/90** unit tests, including `tests/test_local_model_runtime.py`
  which drives **real `llama-cpp-python` 0.3.35** against a **real GGUF** served
  over **real HTTP** (no mocks).
- `server`: **15/15** — MongoDB tools, auth, and `X-User-Id` identity
  enforcement unchanged.
- `frontend`: `npm run build` green.
- Live: 404 reproduction; happy path (source-check → download → verify → load →
  ready → chat → follow-up with memory → restart hits the cache without
  re-downloading); tool path (schedule, performance, quiz, web-research intents
  all routed, backend receives `X-User-Id` from the trusted header only).

---

# Addendum — AI outage fix (2026-09-05, PR #41, merged to main)

**Symptom:** chat answered *"EduNova AI's self-hosted model is not available on
the server"*, frontend showed "Ready to help", console spammed
`WebSocket … failed: Page entered Back-Forward Cache`.

**Root cause (confirmed live):** `edunova-ai` still ran the stale env override
`LOCAL_MODEL_FILE=Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf` (never published in the
HF repo) → permanent preflight 404. Stale frontend bundle predated the
real-status polling; module-level Socket.IO connection caused the bfcache
errors. Stale Groq `LLM_*` vars remained in the dashboard (ignored, but unclean).

**Fix shipped (commit `595a580`, PR #41):**
- `ai_engine`: self-healing verified-catalogue fallback for provably-invalid
  `LOCAL_MODEL_FILE` overrides (404/410), surfaced via
  `configOverrideRejected`; `STALE_EXTERNAL_LLM_ENV` warning; health reports
  the effective model id. 8 new regression tests (98/98 with real llama.cpp).
- `frontend`: shared lazy reference-counted Socket.IO lifecycle
  (`src/api/socket.js`) with bfcache `pagehide`/`pageshow` handling; module +
  duplicate `io()` connections removed; AI remains HTTP/SSE-only.

**Production verification (post-merge, Render autodeploy):**
`GET /health` on `edunova-ai-o2vy.onrender.com` →
`providerState: ready, modelReady: true, modelId: …Q4_K_M.gguf,
fileSizeBytes: 397808192, integrityPinned: true, inferenceAvailable: true,
runtimeVersion: 0.3.35, configOverrideRejected: true`.

**Local E2E (real llama.cpp 0.3.35):** service boot → download → verify →
load → `LOCAL_MODEL_READY`; `POST /api/ai/chat {"what is ml"}` → HTTP 200
model-generated reply; follow-up "Explain it like I'm 10" in same conversation
→ HTTP 200 (`follow-up uses conversation context`); restart →
`LOCAL_MODEL_CACHE_HIT (no download)`; token gates → 401/200 as designed;
broken-model query → honest `503 LLM_MODEL_UNAVAILABLE`.

**Still on the operator:** delete the stale `LOCAL_MODEL_FILE` /
`LOCAL_MODEL_CTX=3072` / Groq `LLM_*` vars from the Render dashboard (exact
table in DEPLOYMENT.md runbook) and redeploy the Cloudflare frontend so the
bundle ships the status polling + socket fix.
