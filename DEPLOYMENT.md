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
| `AGENT_REQUEST_TIMEOUT` | optional | Agent proxy timeout in ms (default `210000`) |
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

## 2. AI engine — Render (FastAPI) — SELF-HOSTED MODEL

| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Python |
| **Root Directory** | **`ai_engine`** |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |

The AI brain is a **self-hosted, quantized GGUF model running in-process via
llama.cpp** (`llama-cpp-python`). There are **no external LLM API keys** —
OpenAI/Groq/Gemini/Anthropic/OpenRouter are not used. The `buildCommand` picks
up a prebuilt CPU wheel through `PIP_EXTRA_INDEX_URL` (set by `render.yaml`
and the Dockerfile), so no C++ toolchain is needed.

Required agent environment (self-hosted default):

| Variable | Notes |
|---|---|
| `LLM_PROVIDER` | `local` (self-hosted in-process model — the default) |
| `LOCAL_MODEL_REPO` | HF repo id, default `bartowski/Qwen2.5-0.5B-Instruct-GGUF` |
| `LOCAL_MODEL_FILE` | GGUF filename, default `Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf` (~270MB) |
| `LOCAL_MODEL_URL` | Optional direct download URL (mirror); overrides repo/file |
| `LOCAL_MODEL_SHA256` | Optional integrity pin for the downloaded weights (recommended) |
| `LOCAL_MODEL_DIR` | Weights cache dir (`./models_cache`; ephemeral on free plan) |
| `LOCAL_MODEL_CTX` | Context tokens, default `3072` |
| `LOCAL_MODEL_THREADS` | CPU threads, default `2` |
| `LOCAL_MODEL_CHAT_FORMAT` | `chatml` (Qwen), also `llama-3`/`mistral`/`gemma` |
| `LOCAL_PRELOAD_MODEL` | `true` = download+load in background at boot |
| `LOCAL_CHAT_WAIT_TIMEOUT` | Seconds chat waits for warmup before `503 LLM_MODEL_LOADING`, default `25` |
| `LLM_MAX_OUTPUT_TOKENS` / `LLM_TEMPERATURE` | Default `900` / `0.2` |
| `APP_BACKEND_URL` | Public HTTPS URL of `edunova-api` (AI service only) |
| `WEB_SEARCH_API_KEY` | Brave, Tavily, or Serper credential (web data source) |
| `WEB_SEARCH_PROVIDER` | `brave`, `tavily`, or `serper` |
| `AI_INTERNAL_TOKEN` | Required in production; exact same value as API service |
| `AI_REQUIRE_INTERNAL_TOKEN` | Set `true` in production (blueprint default) |
| `MAX_AGENT_ITERATIONS` / `MAX_TOOL_CALLS` | Local defaults `5` / `8` |
| `WEB_REQUEST_TIMEOUT` / `WEB_MAX_CONTENT_LENGTH` | Defaults `10` / `200000` |

Model sizing guide (pick per Render plan):

| Plan | RAM | Recommended model (set `LOCAL_MODEL_REPO` / `LOCAL_MODEL_FILE`) |
|---|---|---|
| Free / Starter (512MB) | 512MB | `bartowski/Qwen2.5-0.5B-Instruct-GGUF` + `Qwen2.5-0.5B-Instruct-IQ3_XXS.gguf` (default) |
| Starter (1GB) | 1GB | same repo + `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (~397MB, better quality) |
| Standard (2GB+) | 2GB+ | `bartowski/Qwen2.5-1.5B-Instruct-GGUF` + `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (~1GB) |

Emergency rollback only (remove after the local model is verified):
`LLM_PROVIDER=openai_compatible` + `LLM_API_KEY` + `LLM_MODEL` +
`LLM_BASE_URL` (HTTPS enforced for public hosts; `http://` is accepted only
for private/loopback hosts, e.g. a self-hosted gateway).

The AI agent does not need MongoDB. Express remains the authenticated database
and application API. After the agent deploys, copy its public URL into the API
service's `AI_ENGINE_URL`. If that is unset, `/api/ai/chat` returns a clean `503`
instead of hanging. See `AGENT_ARCHITECTURE.md` for all limits and providers.

### Free-plan cold starts, model warmup, and the AI chat

On Render's free plan a web service that receives no traffic spins down after
about 15 minutes. While it wakes, Render's router answers with an HTML
"Application loading" page (HTTP 503) instead of proxying to the app. With the
self-hosted model there is one more step after boot: the GGUF weights are
downloaded (~270MB) and loaded, during which the AI service answers
`503 LLM_MODEL_LOADING` (never a fake answer) and reports progress at
`/api/ai/health`.

The Express AI route retries bounded fast failures (proxy 502/503/504 pages,
connect-level errors, and `LLM_MODEL_LOADING` 503s) for up to
`AI_UPSTREAM_RETRY_WINDOW_MS` (blueprint: `240000`, sized for download+load;
schedule `AI_UPSTREAM_RETRY_DELAYS_MS`) before returning an error. The user
only sees "Understanding your question..." while the service boots. Two ways
to remove the cold-start wait entirely:

- Upgrade **edunova-ai** to a paid instance type (always on), or
- keep the free plan and accept the first question after idle taking ~1-4 min
  (wake + model download + load); retries then succeed and later questions
  are fast.

If the service is genuinely down, the API now returns an accurate, user-safe
message ("The EduNova AI service is starting up or temporarily unavailable…")
with `agentStatus: "unavailable"` instead of the old misleading
"could not start this request".

---

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
