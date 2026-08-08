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
   - `VITE_API_URL`: `https://your-backend.onrender.com/api`
   - `VITE_SIGNAL_URL`: `https://your-backend.onrender.com`
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
| `VITE_API_URL` | When your backend API is hosted | `https://your-backend.onrender.com/api` (include `/api`) |
| `VITE_SIGNAL_URL` | When your Socket.IO signaling server is hosted | `https://your-signaling.onrender.com` |

Without these, `/api` calls and live-class sockets will not work in production — Vercel hosts **only the static frontend**. Deploy `server/`, `signaling/`, and `ai_engine/` separately (Railway / Render / etc.), then set the URLs above and redeploy.

In local dev nothing changes: no env vars = Vite proxy to `localhost:4000`, same as before.

## Auto-deploys

Every push to `main` triggers a production deploy; PR/branches get preview deploys. No manual "merge to Vercel" step exists — merging to `main` on GitHub **is** the deploy trigger.

---

# Deploying the backend services (Render / Railway)

The three backend services are Docker-ready. Each folder has its own `Dockerfile`:

| Service | Folder | Local port | Health check |
|---|---|---|---|
| Express API + Socket.IO | [`server/`](./server) | `4000` | `GET /api/test` |
| WebRTC signaling (Socket.IO) | [`signaling/`](./signaling) | `5000` | `GET /health` |
| AI engine (FastAPI) | [`ai_engine/`](./ai_engine) | `8001` | `GET /health` |

> **Note:** `server/` **already embeds the exact same Socket.IO signaling** as `signaling/`. You can skip service #2 entirely and point `VITE_SIGNAL_URL` at the API server (e.g. `https://edunova-api.onrender.com`). Deploy `signaling/` separately only if you want to scale it independently.

## Option 1 — Render (one-click Blueprint)

1. Vercel dashboard is separate; go to **Render Dashboard → Blueprints → New Blueprint Instance**
2. Connect GitHub and pick `edunova_x` — Render reads [`render.yaml`](./render.yaml) and creates **edunova-api**, **edunova-signal**, and **edunova-ai**
3. When prompted, fill in the `sync: false` variables (`JWT_SECRET` is auto-generated):
   - `MONGO_URI` — your MongoDB Atlas connection string (same one you use locally)
   - `AI_ENGINE_URL` — set **after** the first deploy, once you know the AI service URL (e.g. `https://edunova-ai.onrender.com`)
   - `EMAIL_USER` / `EMAIL_PASS` / `CONTACT_RECEIVER_EMAIL` — optional, only for the contact form (Gmail + App Password)
4. Render injects `PORT` automatically — all three services already read it.

**Manual alternative:** New → Web Service → pick the repo → set **Root Directory** to `server` (or `signaling` / `ai_engine`) → Runtime: Docker. Repeat per service.

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
| `AI_ENGINE_URL` | ⚠️ for AI chat | URL of the deployed ai_engine, no trailing slash |
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

After the backends are live, in **Vercel → Project Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://<edunova-api>.onrender.com/api` — **include `/api`** |
| `VITE_SIGNAL_URL` | `https://<edunova-api>.onrender.com` (or the signaling service URL if deployed separately) |

Then ** redeploy** the Vercel frontend (Vite inlines env vars at build time).

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
