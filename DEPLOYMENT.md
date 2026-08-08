# Deploying EduNova_X

EduNova X frontend is a **Vite + React** app that can be hosted on **Cloudflare (Workers / Pages)** or **Vercel**, connecting to backend services on **Render / Railway / VPS**.

---

# Option 1: Deploying to Cloudflare (Workers & Pages)

EduNova X is pre-configured with `wrangler.toml`, `wrangler.jsonc`, and `_redirects` for zero-config Cloudflare builds.

## Via Cloudflare Dashboard
1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Create application** → **Connect to Git**
2. Select `edunova_x`
3. Build Settings:
   - **Framework preset**: `Vite` (or `None`)
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: `/` (repo root — required so the repository's `wrangler.toml`/`wrangler.jsonc` are used)
4. Environment Variables:
   - `NODE_VERSION`: `20`
   - `VITE_API_URL`: `https://edunova-api.onrender.com/api`
   - `VITE_SIGNAL_URL`: `https://edunova-signal.onrender.com`
5. Click **Save and Deploy**.

## Via Wrangler CLI
```bash
npm run build
npx wrangler deploy
# Or for Cloudflare Pages:
npx wrangler pages deploy dist --project-name=edunova-x
```

---

# Option 2: Deploying to Vercel

The frontend is a **Vite + React** app in [`frontend/`](./frontend). This repo is ready to deploy — two `vercel.json` files are provided so it works either way you import it.

## Option A (recommended): Root Directory = `frontend`

1. Vercel Dashboard → **Add New → Project → Import `edunova_x`**
2. Set **Root Directory** to `frontend`
3. Vercel auto-detects Vite (`npm run build` → `dist`). `frontend/vercel.json` adds the SPA fallback so routes like `/live/<roomId>` don't 404.
4. Deploy.

## Option B: Root Directory = repo root

Just import the repo. The root [`vercel.json`](./vercel.json) builds from `frontend` and outputs `frontend/dist`.

## Environment variables (Project Settings → Environment Variables)

| Variable | When needed | Example |
|---|---|---|
| `VITE_API_URL` | When your backend API is hosted | `https://edunova-api.onrender.com/api` (include `/api`) |
| `VITE_SIGNAL_URL` | When your Socket.IO signaling server is hosted | `https://edunova-signal.onrender.com` |

Without these, `/api` calls and live-class sockets will not work in production — Vercel hosts **only the static frontend**. Deploy `server/`, `signaling/`, and `ai_engine/` separately (Railway / Render / etc.), then set the URLs above and redeploy.

In local dev nothing changes: no env vars = Vite proxy to `localhost:4000`, same as before.

## Auto-deploys

Every push to `main` triggers a production deploy; PR/branches get preview deploys. No manual "merge to Vercel" step exists — merging to `main` on GitHub **is** the deploy trigger.

---

# Deploying the backend services (Render / Railway)

The three backend services are Docker-ready. Each folder has its own `Dockerfile`:

| Service | Folder | Local port | Health check |
|---|---|---|---|
| Express API + Socket.IO | [`server/`](./server) | `4000` | `GET /health` |
| WebRTC signaling (Socket.IO) | [`signaling/`](./signaling) | `5000` | `GET /health` |
| AI engine (FastAPI) | [`ai_engine/`](./ai_engine) | `8001` | `GET /health` |

> **Note:** `server/` **already embeds the exact same Socket.IO signaling** as `signaling/`. You can skip service #2 entirely and point `VITE_SIGNAL_URL` at the API server (e.g. `https://edunova-api.onrender.com`). Deploy `signaling/` separately only if you want to scale it independently.

## Option 1 — Render (one-click Blueprint) — RECOMMENDED FULL-STACK SETUP

The repo ships [`render.yaml`](./render.yaml) which creates **three** backend
services. The frontend is **not** deployed on Render — it stays on Cloudflare
Workers (`https://edunova-x.ranjitacharya13.workers.dev`) and talks to the
backends over HTTPS:

| Service | Type | Root dir | Build | Start |
|---|---|---|---|---|
| `edunova-api` | Web Service | `server` | `npm install` | `npm start` (`node server.js`) |
| `edunova-signal` | Web Service | `signaling` | `npm install` | `node index.js` |
| `edunova-ai` | Web Service | `ai_engine` | `pip install -r requirements.txt` | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

> All services bind `0.0.0.0` and read Render's injected `PORT`. No service uses
> `npm.cmd`, `py`, `set "..."`, or localhost between services, and **no service
> runs `npm run dev`** — that script is local development only.

### Blueprint steps

1. **Render Dashboard → New → Blueprint** → connect GitHub → pick `edunova_x`.
2. Render creates the three services and prompts for the `sync: false` secrets:
   - `MONGO_URI` (on **edunova-api** and **edunova-ai**) — your MongoDB Atlas connection string.
   - `JWT_SECRET` (edunova-api) — long random string.
   - `EMAIL_USER` / `EMAIL_PASS` / `CONTACT_RECEIVER_EMAIL` — optional (contact form).
   - `CORS_ORIGIN` (edunova-api) — the frontend URL, e.g. `https://edunova-x.ranjitacharya13.workers.dev`.
   - `AI_ENGINE_URL` (edunova-api) — the deployed edunova-ai URL,
     e.g. `https://edunova-ai.onrender.com` (the backend adds `https://` if the
     value is scheme-less).
3. After the first deploy, copy each service's `.onrender.com` URL from the
   dashboard and confirm `frontend/.env` matches them:
   - `VITE_API_URL=https://<edunova-api-url>/api`
   - `VITE_SIGNAL_URL=https://<edunova-signal-url>`
   (Vite inlines these at build time on Cloudflare — see "Wire the frontend" below.)
4. **Manual alternative** (no blueprint): create each service individually with
   the root directories and commands from the table above.

## Option 2 — Railway

1. **New Project → Deploy from GitHub repo** → pick `edunova_x`
2. Create one service per folder: service settings → **Root Directory** = `server`, `signaling`, or `ai_engine` — Railway auto-detects each `Dockerfile`
3. Add the env vars from the table below per service (Railway injects `PORT` automatically)

## Environment variables

**`server/` (edunova-api)**

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | any long random string (Render Blueprint auto-generates it) |
| `AI_ENGINE_URL` | ⚠️ for AI chat | URL of the deployed ai_engine (scheme-less hostnames get `https://` automatically) |
| `CORS_ORIGIN` | ⚠️ for browser access | comma-separated frontend origin(s), e.g. `https://edunova-x.ranjitacharya13.workers.dev` |
| `PORT` | auto | injected by the platform |
| `SEED_DEMO_USERS` | optional | `"false"` disables demo teacher/student accounts |
| `ADMIN_TEMP_PASSWORD` | optional | first-boot admin password; random if unset (printed to logs) |
| `EMAIL_USER` / `EMAIL_PASS` / `CONTACT_RECEIVER_EMAIL` | optional | contact form via Gmail SMTP |

**`ai_engine/` (edunova-ai)**

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | ✅ | same Atlas cluster (default DB `edunova`) |
| `STUDENT_TIMETABLE_ID` / `TEACHER_TIMETABLE_ID` | optional | overrides the built-in timetable ObjectIds |
| `PORT` | auto | injected by the platform |

**`signaling/` (edunova-signal)** — no env vars needed; only `PORT` (auto-injected).

## Wire the frontend to the backends

The production frontend runs on **Cloudflare Workers** at
`https://edunova-x.ranjitacharya13.workers.dev`. The API URLs are baked into the
build from `frontend/.env` (or from `VITE_API_URL` / `VITE_SIGNAL_URL` set in
the Cloudflare build environment, which take precedence). After the Render
services are live, confirm these values:

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://edunova-api.onrender.com/api` (the `/api` suffix is auto-appended by `frontend/src/api/api.js` if missing) |
| `VITE_SIGNAL_URL` | `https://edunova-signal.onrender.com` (the WebRTC signaling service) |

Then **redeploy** the frontend on Cloudflare — Vite inlines env vars at build
time. The frontend is a static site; it never proxies `/api` — every request
goes directly to the backend's HTTPS URL via the configured API client.

## Free-tier cold starts

Render/Railway free services sleep after ~15 min idle — the first request after sleep takes 30–60 s. If Atlas is on an M0 (free) cluster, also add the platform egress IPs (or `0.0.0.0/0`) in **Atlas → Network Access** so the backends can reach MongoDB.

## Docker commands (local testing)

```bash
docker build -t edunova-api ./server
docker build -t edunova-signal ./signaling
docker build -t edunova-ai ./ai_engine

docker run -p 4000:4000 -e MONGO_URI=... -e JWT_SECRET=... edunova-api
docker run -p 5000:5000 edunova-signal
docker run -p 8001:8001 -e MONGO_URI=... edunova-ai
```

## All-in-one alternative (no Vercel)

`server/server.js` also serves `frontend/dist` statically and hosts the sockets — a single Docker deploy of the repo root (build frontend first, then `node server/server.js`) works on any VPS/VM as a one-process setup. The Vercel + services split above is recommended for free-tier hosting though, since Vercel serves the static app far better.
