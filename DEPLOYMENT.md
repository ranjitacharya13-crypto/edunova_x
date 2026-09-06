# Deploying EduNova_X

Production architecture:

```
                        USER
                          |
                          v
        Cloudflare Workers frontend  (the ONLY frontend)
        https://edunova-x.ranjitacharya13.workers.dev
                          |
                          |  HTTPS
                          v
             Node.js / Express API + Socket.IO
                    Render  (rootDir: server)
                          |
              +-----------+-----------+
              |                       |
              v                       v
       MongoDB Atlas          Python FastAPI AI engine
                              Render (rootDir: ai_engine)

        WebRTC media is peer-to-peer between browsers:
        STUN (NAT discovery) + TURN (relay fallback for
        strict NAT / mobile / enterprise networks)
```

| Component | Where it runs | Directory |
|---|---|---|
| Frontend (React + Vite) | **Cloudflare Workers** | `frontend/` → built to `dist/` |
| REST API + Socket.IO | **Render** web service | `server/` |
| AI engine (FastAPI) | **Render** web service | `ai_engine/` |
| Database | **MongoDB Atlas** | — |
| Signaling (optional) | Render (disabled by default) | `signaling/` |

> The Express API already hosts Socket.IO signaling and live-class chat, so the
> standalone `signaling/` service is **not** deployed by default. Deploy it only
> if you want signaling to scale separately (see the commented block in
> `render.yaml`).

---

## 1. Backend — Render (Node/Express API)

The API is a **self-contained Node app** in `server/` with its own
`package.json` and `package-lock.json`. Render must install **inside that
directory** — this is the single most important setting.

### Option A — Blueprint (recommended)

The repo ships [`render.yaml`](./render.yaml). In Render: **New → Blueprint**,
select this repository, and it creates both backend services with the correct
settings.

### Option B — Manual web service

| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Node |
| **Root Directory** | **`server`** |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

> **If you leave Root Directory blank** (deploying from the repo root), the
> build must still install the backend's dependencies. The root `package.json`
> handles this automatically via a `prestart:server` hook that runs
> `scripts/ensure-server-deps.js`, but setting Root Directory to `server` is
> cleaner and faster.

### Backend environment variables

Set these in **Render → your API service → Environment**:

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | Long random string (`openssl rand -hex 32`) |
| `CORS_ORIGIN` | ✅ | `https://edunova-x.ranjitacharya13.workers.dev` |
| `AI_ENGINE_URL` | for AI chat | Public HTTPS URL of the AI service, no trailing slash (`https://edunova-ai-o2vy.onrender.com`) |
| `AI_INTERNAL_TOKEN` | recommended | Random shared secret; use the exact same value on the AI service |
| `AGENT_REQUEST_TIMEOUT` | optional | Network backstop in ms (default `600000`; never controls answer length) |
| `AGENT_STREAM_IDLE_TIMEOUT_MS` | optional | Stream-stall watchdog reset by every token/keep-alive (default `90000`; not an overall timer) |
| `AI_RATE_LIMIT_MAX_REQUESTS` | optional | Authenticated requests per user/window (default `20`) |
| `AI_UPSTREAM_RETRY_DELAYS_MS` | optional | Cold-start retry backoff before failing a request (default `3000,8000,15000,30000`) |
| `AI_UPSTREAM_RETRY_WINDOW_MS` | optional | Total retry budget for waking the AI service in ms (default `90000`) |
| `EMAIL_USER` / `EMAIL_PASS` | for contact form | Gmail address + 16-char App Password |
| `CONTACT_RECEIVER_EMAIL` | optional | Where contact messages are sent |
| `ADMIN_TEMP_PASSWORD` | optional | Otherwise a random one is printed to logs once |
| `SEED_DEMO_USERS` | optional | `false` disables demo teacher/student seeding |

`PORT` is injected by Render — **never set it manually** and never hardcode it.
The server binds `0.0.0.0:$PORT`.

**MongoDB Atlas:** under *Network Access*, allow `0.0.0.0/0`. Render's egress
IPs are dynamic, so an IP allowlist will intermittently fail.

---

## 2. AI layer — Render (two Python services) — SELF-HOSTED MODEL

The AI layer is split so that **the model never runs in a 512 MiB container**:

| Service | Role | Loads the model? | Typical RSS | Minimum Render plan |
|---|---|---|---|---|
| `edunova-api` (Node/Express) | REST API, auth, MongoDB, AI **gateway** (`/api/ai/*`) | **No** | ~150 MiB | Free/Starter 512 MB |
| `edunova-ai` (FastAPI, `main:app`) | AI **orchestrator**: IntentRouter, authenticated ToolRegistry, RAG orchestration, web search, memory, SSE relay | **No** (never imports `llama_cpp`/`torch`) | ~150 MiB | Free/Starter 512 MB |
| `edunova-inference` (FastAPI, `inference_server:app`) | **Persistent inference service**: llama.cpp GGUF LLM + PyTorch embeddings | **Yes — the only one** | ~1.2 GiB | **Standard 2 GB / 1 CPU** |

Request path: browser → `edunova-api` `POST /api/ai/chat|stream` (JWT) →
`edunova-ai` `POST /api/ai/chat` (`X-AI-Internal-Token`) → `edunova-inference`
`POST /generate/stream` (`X-AI-Internal-Token`) → real tokens streamed back as
SSE through every hop. No OpenAI/Groq/Gemini/Anthropic/OpenRouter anywhere.

### Root cause of "Model + server ML need at least 1100 MiB; container has 512 MiB"

The model was loaded **inside** the orchestrator process and that process was
deployed on a 512 MiB instance. Qwen2.5-0.5B Q4_K_M + llama.cpp + FastAPI +
PyTorch embeddings genuinely need more than 512 MiB, so the memory gate failed
(correctly). Reducing context/timeouts cannot fix physics; the fix is to run
the model in its own adequately sized service, which is what the blueprint now
does.

### Memory requirement (documented and enforced at boot)

`ai_engine/inference/resources.py` computes the requirement from the real GGUF
header and refuses to start a model that cannot fit
(`MODEL_RESOURCE_INSUFFICIENT {required_mb, available_mb, recommended_mb}`).
For the blueprint model at `LOCAL_MODEL_CTX=6144`:

| Component | MiB |
|---|---|
| Model weights (Qwen2.5-0.5B-Instruct Q4_K_M GGUF, 397 MB file) | 398 |
| KV cache @ 6144 context | 80 |
| llama.cpp runtime buffers | 160 |
| FastAPI/uvicorn + Python | 140 |
| PyTorch embeddings (all-MiniLM-L6-v2) for RAG | 260 |
| Safety margin | 128 |
| **Required** | **1166** |
| Required with `RAG_ENABLED=false` | 906 |
| **Recommended** | **2048** |
| CPU | 1 dedicated core, `LOCAL_MODEL_THREADS=2` |

`GET /system/resources` on either Python service prints the live numbers.

### `edunova-inference` (the model)

| Setting | Value |
|---|---|
| Type / Runtime | Web Service / Python |
| **Root Directory** | **`ai_engine`** |
| Plan | **Standard (2 GB)** or larger — 512 MB plans fail the resource check by design |
| Build Command | `pip install "torch==2.8.0" --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt && python verify_runtime.py` |
| Start Command | `python verify_runtime.py && uvicorn inference_server:app --host 0.0.0.0 --port $PORT --workers 1` |
| Health Check Path | `/health` |
| Disk | 4 GB at `/var/data/models` (weights downloaded once) |

`verify_runtime.py` imports `llama_cpp` and `torch` at build **and** start, so a
broken dependency fails the deploy instead of surfacing as `DEPENDENCY_FAILED`.

Startup lifecycle (once per process, never per request):
`resource check → runtime check → GGUF validation → load → warmup ("What is
2 + 2?") → independent inference test → MODEL_READY`. Public states:
`MODEL_NOT_READY`, `MODEL_LOADING`, `MODEL_READY`, `MODEL_FAILED`.

Endpoints (all but `/health` and `/ready` require `X-AI-Internal-Token`):
`GET /health`, `GET /ready` (200 only when READY), `GET /model/status`,
`GET /system/resources`, `GET /metrics`, `POST /generate`,
`POST /generate/stream` (SSE `token`/`done`/`error`), `POST /embeddings`.

| Variable | Notes |
|---|---|
| `LLM_PROVIDER` | `local` |
| `LOCAL_MODEL_RUNTIME` | `llama_cpp` (GGUF). PyTorch is used for embeddings only. |
| `LOCAL_MODEL_REPO` / `LOCAL_MODEL_FILE` | Verified catalogue entry (`config.py -> KNOWN_MODELS`, size + sha256 pinned) |
| `LOCAL_MODEL_DIR` | Persistent disk path (`/var/data/models`) |
| `LOCAL_MODEL_CTX` | Context tokens (`6144`). **No silent downgrade**: if it does not fit, startup fails with the numbers. |
| `LOCAL_MODEL_THREADS` | `2` |
| `MODEL_STARTUP_TIMEOUT` | Hard deadline per lifecycle stage (`300`) |
| `RAG_ENABLED` / `RAG_EMBEDDING_MODEL` | PyTorch embeddings served on `/embeddings` |
| `AI_INTERNAL_TOKEN` / `AI_REQUIRE_INTERNAL_TOKEN` | Same token on all three services / `true` |
| `AI_MEMORY_LIMIT_MB` | Optional override of the detected container limit (testing only) |

### `edunova-ai` (the orchestrator)

| Setting | Value |
|---|---|
| Type / Runtime | Web Service / Python |
| **Root Directory** | **`ai_engine`** |
| Plan | Free/Starter (512 MB) is sufficient |
| Build Command | `pip install -r requirements-orchestrator.txt && python verify_runtime.py --orchestrator` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Health Check Path | `/health` |

| Variable | Notes |
|---|---|
| `AI_INFERENCE_URL` | **Required — the service refuses to start without it.** Public HTTPS URL of `edunova-inference`, no trailing slash. Missing value aborts startup with `CONFIG_FAILED` / `AI_INFERENCE_URL_MISSING` (exit code 3, deploy goes red) instead of serving a 503 to the first chat |
| `AI_INFERENCE_REQUEST_TIMEOUT` | Network safety net per inference call (`600` s); never shortens an answer |
| `APP_BACKEND_URL` | Public HTTPS URL of `edunova-api` (authenticated tools) |
| `AI_INTERNAL_TOKEN` / `AI_REQUIRE_INTERNAL_TOKEN` | Same token as the other services / `true` |
| `RAG_ENABLED` / `RAG_EMBEDDING_MODEL` | Orchestrates the user-scoped index; vectors come from the inference service (`lexical` = offline dev only) |
| `WEB_SEARCH_API_KEY` / `WEB_SEARCH_PROVIDER` | Brave/Tavily/Serper web data source |
| `LLM_MAX_OUTPUT_TOKENS` / `LLM_TEMPERATURE` | `2048` / `0.2` — no elapsed-time output reduction |
| `AGENT_MAX_CONTEXT_CHARS` / `LOCAL_MODEL_CTX` | Must fit the inference service's context (`12000` / `6144`) |
| `MAX_AGENT_ITERATIONS` / `MAX_TOOL_CALLS` / `MAX_AGENT_RUNTIME_SECONDS` | `3` / `8` / `300` |

Endpoints: `GET /health`, `GET /ready`, `GET /model/status`,
`GET /system/resources`, `GET /metrics`, `GET /api/ai/health|ready|metrics|diagnose`,
`POST /api/ai/chat` (JSON or SSE with `Accept: text/event-stream`). All of them
**observe** the inference service; none of them start, reload or queue on the
model.

### `edunova-api` AI gateway

`server/routes/ai.js` (JWT-authenticated, rate limited, internal token added
server-side): `POST /api/ai/chat`, `POST /api/ai/stream` (always SSE),
`GET /api/ai/health`, `GET /api/ai/ready`, `GET /api/ai/model/status`,
`GET /api/ai/system/resources` (admin), `GET /api/ai/diagnose` (admin).
Before forwarding chat it reads `/api/ai/ready` once and returns the precise
code (`MODEL_LOADING`, `MODEL_RESOURCE_INSUFFICIENT`, `AI_SERVICE_UNREACHABLE`,
…) — there is no warm queue and no "preparing…" loop.

#### Per-hop timing logs

Every chat request emits one structured log line per hop, so a slow or broken
hop is identifiable from logs alone (no tokens, no message text):

| Log event | Service | Meaning |
|---|---|---|
| `ai.request` | edunova-api | Browser → API accepted the request |
| `ai.gateway.config_ok` / `ai.gateway.config_failed` | edunova-api | `AI_ENGINE_URL` / `AI_INTERNAL_TOKEN` state, logged once at boot |
| `ai.hop.gateway_to_ai` | edunova-api | API → orchestrator readiness probe (`probeMs`, `modelReady`) |
| `ai.hop.ai_response_headers` | edunova-api | Orchestrator answered the chat POST (`connectMs`) |
| `HOP_AI_TO_INFERENCE_OK` / `HOP_AI_TO_INFERENCE_FAILED` | edunova-ai | Orchestrator → inference service (`probe_ms`, host) |
| `RESPONSE_SENT` | edunova-ai | Full orchestrator turn (`total_ms`, `inference_connect_ms`) |
| `ai.hop.browser_to_api_complete` | edunova-api | Non-stream response returned (`totalMs`) |
| `ai.stream.end` | edunova-api | SSE stream closed (`totalMs`) |

`edunova-api` logs `ai.gateway.config_failed` at boot when `AI_ENGINE_URL` or
`AI_INTERNAL_TOKEN` is missing, but keeps running: it also serves auth,
timetables, courses, AR and Socket.IO, so only `/api/ai/*` degrades (503
`CONFIG_FAILED`). `edunova-ai` is the service that fails fast, because without
`AI_INFERENCE_URL` it has nothing to serve at all.

### Model weights cache (persistent disk)

`render.yaml` attaches a 4 GB disk to **edunova-inference** at
`/var/data/models`. Weights are downloaded **once** (never during a request),
re-validated on boot (size + sha256 + `GGUF` magic) and re-downloaded if
corrupt. Disks require a paid instance type — which the inference service
needs anyway.

### Order of first deploy

1. Deploy `edunova-inference`; wait for `GET /ready` → `{"ready": true}`.
2. Set `AI_INFERENCE_URL` on `edunova-ai` to that URL; deploy; check `/ready`.
3. Set `AI_ENGINE_URL` on `edunova-api` to the `edunova-ai` URL.
4. Use the same `AI_INTERNAL_TOKEN` on all three.

## 3. Frontend — Cloudflare Workers

**The production frontend already exists and must stay at**
`https://edunova-x.ranjitacharya13.workers.dev`. Do not create a second
frontend and do not host the frontend on Render.

Build settings (Workers & Pages → the `edunova-x` project):

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` (repo root — required so `wrangler.toml` is found) |

### Frontend environment variables — REQUIRED

`VITE_*` variables are **inlined into the JavaScript bundle at build time**, so
they must be set *before* the build and the site must be **redeployed** after
any change.

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://edunova-api-y3rx.onrender.com/api` — **include `/api`** |
| `VITE_SIGNAL_URL` | Optional — leave empty to derive from `VITE_API_URL`. Set it (e.g. `https://edunova-signal.onrender.com`, **no `/api`**) only if signaling is deployed as a separate service |
| `VITE_TURN_URL` | `turn:<your-turn-host>:3478` (or `turns:…:5349`) — **required for reliable video on mobile/4G** |
| `VITE_TURN_USERNAME` | TURN username (temporary credential if the provider supports it) |
| `VITE_TURN_CREDENTIAL` | TURN password / credential — **secret, never commit** |
| `NODE_VERSION` | `20` |

Because the Express API hosts Socket.IO, `VITE_SIGNAL_URL` is normally the same
service as `VITE_API_URL`, just without the `/api` path.

> These are intentionally **not** committed. `frontend/.env` is git-ignored so a
> stale backend URL can never be baked into a production build. See
> `frontend/.env.example`.

Deploy via CLI:

```bash
npm run build
npx wrangler deploy
```

---

## 4. TURN server (production WebRTC)

WebRTC connects peers directly (STUN discovers the public address). On
symmetric NAT, carrier-grade NAT (CGNAT), mobile networks and enterprise
firewalls the direct path fails — a **TURN relay is the required fallback**.
The code already reads the ICE configuration from build-time variables in
`frontend/src/Components/Views/LiveView.jsx`; this section only covers wiring a
provider in.

### Option A — Managed TURN provider (recommended)

Create an account with a reputable managed provider (e.g. Metered, Twilio
Network Traversal, Cloudflare Calls / Realtime, or similar) and obtain:

- a TURN host:port (UDP + TCP, and `turns:` TLS if supported), and
- either long-lived credentials or a **REST API for temporary credentials**.

### Option B — Self-hosted coturn

Run [coturn](https://github.com/coturn/coturn) on a VPS and expose
`3478/udp+tcp` (and `5349/tcp` for TURNS). Example minimal config:

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=edunova:<GENERATED_PASSWORD>   # never commit; use a secret manager
realm=edunova.local
# Generate with: openssl rand -hex 16
static-auth-secret=<GENERATED_SECRET>
```

If the provider supports **temporary credentials**, the recommended pattern is
to have the backend issue short-lived TURN credentials via an endpoint, then
pass them to the frontend. The current repo ships the simpler (and fully
supported) path below — build-time static credentials via Cloudflare variables.

### Wiring into Cloudflare (build-time, mandatory)

`VITE_*` values are compiled into the bundle **at build time**, so after
changing any of them you must do a full **install → build → deploy** cycle —
restarting the Worker is not enough:

```bash
# Cloudflare dashboard → Workers & Pages → edunova-x → Settings → Variables
#   VITE_TURN_URL=turn:your-provider.example:3478
#   VITE_TURN_USERNAME=<username>
#   VITE_TURN_CREDENTIAL=<credential>     # SECRET — never commit
#   (advanced: VITE_ICE_SERVERS_JSON='[{"urls":"stun:..."},{"urls":["turn:...","turns:..."],"username":"...","credential":"..."}]')

cd frontend
npm ci
npm run build          # VITE_* values are inlined here
npx wrangler deploy
```

The app always includes Google STUN (`stun:stun.l.google.com:19302`) and adds
the TURN server when `VITE_TURN_URL` is present. `VITE_ICE_SERVERS_JSON`, when
set, overrides the individual TURN variables.

> **Never commit** `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`,
> `TURN_PASSWORD`, `TURN_SECRET` or `TURN_API_KEY` to GitHub. Only
> `frontend/.env.example` (empty placeholders) is committed.

---

## 5. Local development

```bash
# install everything (frontend + server + signaling + root)
npm run install-all

# python AI engine deps
npm run install-ai

# run frontend + API + AI together (LOCAL ONLY — never in production)
npm run start:dev
```

With no `VITE_*` variables set, the Vite dev server proxies `/api` and
`/socket.io` to `localhost:4000`, so local development needs no configuration.

Create `server/.env` from [`server/.env.example`](./server/.env.example) for
`MONGO_URI` and `JWT_SECRET`.

---

## 6. Verifying a deployment

```bash
# 1. API is up and its port is open
curl https://edunova-api-y3rx.onrender.com/api/test
# -> {"status":"OK"}

# 2. AI engine is up
curl https://edunova-ai-o2vy.onrender.com/health
# -> {"status":"live","service":"edunova-ai"}

# 3. CORS preflight from the Cloudflare frontend succeeds
curl -i -X OPTIONS https://edunova-api-y3rx.onrender.com/api/auth/login \
  -H "Origin: https://edunova-x.ranjitacharya13.workers.dev" \
  -H "Access-Control-Request-Method: POST"
# -> 204 with access-control-allow-origin matching the Cloudflare URL
```

`/health` returns `{"status":"ok"}` and is deliberately decoupled from MongoDB,
the AI provider, authentication, and frontend build artifacts — so Render's
load balancer can confirm the process is alive even while upstreams are still
connecting. To confirm live Atlas connectivity, check the server log line
`✅ MongoDB connected` (or, on failure, `❌ MongoDB connection failed:` which
keeps `/health` green but tells you to check `MONGO_URI` and the Atlas Network
Access rule).

---

## Troubleshooting

**`Error: Cannot find module 'nodemailer'` (or `express`, `mongoose`, …)**
Render installed dependencies somewhere other than `server/`. Set the service's
**Root Directory to `server`** with build command `npm ci --omit=dev`. The
backend's dependencies are declared in `server/package.json`; the root
`package.json` is only the desktop launcher and must not be relied upon.

**`==> No open ports detected`**
The process crashed before `listen()`. Check the log for the real error above
the port warning — it is a symptom, not the cause.

**`npm install` fails with `RequestError: unable to verify the first certificate`**
Electron's postinstall is trying to download a ~100MB binary. Use
`npm install --omit=dev` (Electron is a devDependency and is not needed by the
backend), or export `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.

**Frontend loads but every API call fails**
`VITE_API_URL` was missing or wrong at build time. Set it in Cloudflare and
**redeploy** — rebuilding is required because the value is compiled into the
bundle. Open the browser console: the app logs an explicit error when
`VITE_API_URL` is unset in a production build.

**CORS errors in the browser**
Set `CORS_ORIGIN` on the API service to the exact frontend origin (no trailing
slash). The Cloudflare Workers production URL is always allowed as a fallback.

**`LOCAL_MODEL_RUNTIME_MISSING runtime=llama_cpp`**
The llama.cpp runtime (`llama-cpp-python`) is not importable in the deployed
environment even though `LOCAL_MODEL_RUNTIME=llama_cpp` is configured. Root
cause (fixed in this repo): the dependency used to live only in an optional
`requirements-llamacpp.txt` that deployments never installed. Verify the fix by
confirming the deploy ran the full install + verification:

- Build command must include `pip install -r requirements.txt` (which now
  contains `llama-cpp-python==0.3.35`) **and** the trailing
  `python -c "import llama_cpp; print('llama_cpp runtime OK')"` gate;
- Start command must include the same import check before `uvicorn`;
- `/health` should then show `"runtimeAvailable": true`,
  `"runtimeVersion": "0.3.35"`, and (after boot) `"state": "ready"`.

If a rebuild did not pick up the new build/start command, trigger
**Manual Deploy → Deploy latest commit** on the `edunova-ai` service.

---

## Incident runbook — "self-hosted model is not available" (Sept 2026)

**What happened.** The deployed `edunova-ai` service kept the environment
variable `LOCAL_MODEL_FILE=Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf` from an older
deploy. That filename was **never published** in
`bartowski/Qwen2.5-0.5B-Instruct-GGUF` (verified against the repo's file
tree), so the startup preflight returned a permanent `HTTP 404`, the model
never loaded, and every chat request answered
*"EduNova AI's self-hosted model is not available on the server."*
Meanwhile the frontend still showed **"Ready to help"** because the deployed
frontend bundle predated the real-health-status fix.

**Two-part fix.**

1. *Code (already in the repo — deploy by merging to `main`).* The AI runtime
   now self-heals exactly this failure class: if an operator-provided
   `LOCAL_MODEL_FILE` provably does not exist (HTTP 404/410) inside a repo from
   the verified catalogue, the service logs `MODEL_CONFIG_OVERRIDE_INVALID`,
   applies that repo's catalogue-verified default file (integrity-pinned by
   size + sha256), and continues booting. `/health` reports
   `configOverrideRejected: true` so the misconfiguration stays visible, and a
   `STALE_EXTERNAL_LLM_ENV` warning names leftover `LLM_*` variables (the old
   Groq/OpenAI leftovers are ignored while `LLM_PROVIDER=local` but should be
   removed). A stale frontend can no longer claim "Ready to help": the label
   is driven by the real model state (`modelReady`).

2. *Render dashboard (recommended, one minute).* On the **edunova-ai** service
   → Environment, set/clean:

   | Key | Value | Why |
   |---|---|---|
   | `LOCAL_MODEL_FILE` | `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` | the verified default (the self-heal also applies it, but fix the source) |
   | `LOCAL_MODEL_REPO` | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` | the verified repo |
   | `LOCAL_MODEL_CTX` | `6144` | replaces the stale `3072` |
   | `LOCAL_MODEL_DIR` | `/var/data/models` | persistent-disk cache (disk `edunova-model-cache`, 2 GB) |
   | `LLM_PROVIDER` | `local` | self-hosted only |
   | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` (Groq/OpenAI leftovers) | **delete** | unused since `LLM_PROVIDER=local`; removes stale credentials from the service |

   Then **Manual Deploy → Deploy latest commit** (or push to `main` with
   auto-deploy on). Watch the log for:
   `[EduNova AI] LOCAL_MODEL_SOURCE …`, `LOCAL_MODEL_DOWNLOAD_START`,
   `LOCAL_MODEL_READY` (~1–3 min on first boot; instant afterwards thanks to
   the persistent disk).

3. *Frontend.* Redeploy the Cloudflare Worker from the merged `main` so the
   bundle contains the real status polling (`AI model starting…` /
   `Ready to help` / `AI model unavailable`) and the fixed Socket.IO lifecycle
   (lazy shared connection, Back-Forward Cache safe — the
   `WebSocket … failed: Page entered Back-Forward Cache` console spam).

**Verify:**

```bash
curl -s https://edunova-ai-o2vy.onrender.com/health | python3 -m json.tool | grep -E '"state"|"modelReady"|"configOverrideRejected"'
# expect: "state": "ready", "modelReady": true
```

