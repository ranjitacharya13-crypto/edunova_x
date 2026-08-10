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
| Health Check Path | `/api/test` |

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
| `EMAIL_USER` / `EMAIL_PASS` | for contact form | Gmail address + 16-char App Password |
| `CONTACT_RECEIVER_EMAIL` | optional | Where contact messages are sent |
| `JWT_EXPIRES_IN` | optional | JWT lifetime; defaults to `7d` |
| `AI_ENGINE_TIMEOUT_MS` | optional | Upstream AI timeout; defaults to `20000` ms |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_USERNAME` / `ADMIN_TEMP_PASSWORD` | optional | Set all four only to bootstrap the first administrator; no demo account is created |

`PORT` is injected by Render — **never set it manually** and never hardcode it.
The server binds `0.0.0.0:$PORT`.

**MongoDB Atlas:** under *Network Access*, allow `0.0.0.0/0`. Render's egress
IPs are dynamic, so an IP allowlist will intermittently fail.

---

## 2. AI engine — Render (FastAPI)

| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Python |
| **Root Directory** | **`ai_engine`** |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |

Environment: `MONGO_URI` (required), `CORS_ORIGIN`, and optionally
`MONGO_DB_NAME`, `STUDENT_TIMETABLE_ID`, `TEACHER_TIMETABLE_ID`.

After it deploys, copy its public URL into the API service's `AI_ENGINE_URL`.
If `AI_ENGINE_URL` is unset in production, `/api/ai/query` returns a clean
`503` instead of hanging.

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
| `VITE_SIGNAL_URL` | `https://edunova-signal.onrender.com` — **no `/api`** |
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

`"mongo":"connected"` in `GET /health` (a richer alias that still exists on the
API) confirms Atlas connectivity. If it reports `disconnected`, check
`MONGO_URI` and the Atlas Network Access rule.

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
