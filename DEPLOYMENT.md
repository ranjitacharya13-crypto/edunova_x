# Deploying EduNova_X

EduNova X frontend is a **Vite + React** app that can be hosted on **Cloudflare (Workers / Pages)** or **Vercel**, connecting to backend services on **Render / Railway / VPS**.

---

# ⚡ Recommended: One-command production deploy (Vercel + Render)

The repo ships a fully automated pipeline for the production topology
**Vercel (frontend) + Render (3 backend services)**. It is idempotent —
safe to rerun; it repairs rather than duplicates.

```
scripts/deploy/
├── master-deploy.sh            # Bash pipeline (macOS/Linux/WSL/Git-Bash)
├── master-deploy.ps1           # PowerShell pipeline (Windows)
├── extract-secrets.mjs/.sh/.ps1  # auto-pull secrets from local .env files
├── .env.secrets.example        # template (committed)
└── .env.secrets                # YOUR secrets — gitignored, never committed
```

## 1. Prepare secrets (2 minutes)

```bash
./scripts/deploy/extract-secrets.sh      # or: powershell -File extract-secrets.ps1
```

This reads `server/.env` (MONGO_URI, JWT_SECRET, email creds) and
`frontend/.env` (TURN vars) and writes `scripts/deploy/.env.secrets`,
then prints the Render Blueprint `envVars` YAML + Vercel env JSON.
Open that file and add the two tokens:

```bash
VERCEL_TOKEN=[Insert_Token]     # Vercel access token
RENDER_API_KEY=[Insert_Key]     # Render API key (rnd_...)
```

## 2. Deploy (one command)

```bash
cd scripts/deploy
./master-deploy.sh              # Bash
powershell -File master-deploy.ps1   # Windows
```

The script:
1. **Authenticates** — verifies the Render API key (`GET /v1/owners`) and the
   Vercel token (`vercel whoami`).
2. **Pushes the blueprint** — commits/pushes this repo, validates `render.yaml`
   against the Blueprint spec, then creates/updates the three services
   `edunova-api` → `./server`, `edunova-signal` → `./signaling`,
   `edunova-ai` → `./ai_engine` (via a Blueprint instance if one exists,
   otherwise via the Render API with the exact same config), and injects the
   secrets (`MONGO_URI`, `JWT_SECRET`, email creds, `AI_ENGINE_URL`).
3. **Waits for LIVE** — polls each service until deploy status is `live` **and**
   `GET https://<url>/health` returns `200 {"status":"ok","service":"edunova-x-production"}`.
4. **Updates the frontend env** — rewrites root + `frontend/vercel.json` and
   writes `frontend/.env.production` / `.env.local` with the live Render URLs
   and your TURN credentials, and pushes them to the Vercel project
   (`vercel env add … production`).
5. **Deploys** — `vercel --prod --yes --cwd frontend`.
6. **Verifies** — pings `/health` + `/api/test` on every service and the SPA
   root on Vercel, and whitelists the exact deployed domain in the API's
   `CORS_ORIGINS`.

Optional flags: `--skip-git-push`, `--skip-vercel`, `--skip-verify`.

## Health contract (all three backends)

```js
app.get("/health", (req, res) =>
  res.status(200).json({ status: "ok", service: "edunova-x-production" })
);
```

`edunova-signal` also answers `GET /` with `200` JSON so Render's default root
probe passes, and unknown paths return JSON 404s (never the raw HTML
`Cannot GET …` page).

## Node version

- `server/.nvmrc`, `signaling/.nvmrc`, `frontend/.nvmrc` → `20`
  (plus `.node-version` and `NODE_VERSION: "20"` in `render.yaml`).
- `frontend/package.json` declares `engines.node >= 20`.

## Native dependencies (sharp / pdf-thumbnail)

- `edunova-api` builds from `server/Dockerfile` (`runtime: docker` in
  `render.yaml`) because **pdf-thumbnail requires GraphicsMagick**, which
  Render's native Node runtime does not ship. The Dockerfile installs
  `graphicsmagick` + `ghostscript`; **sharp** installs prebuilt libvips
  binaries via npm.
- Thumbnail generation is additionally wrapped in `try/catch` in
  `server/routes/study.js` & `syllabus.js`, so uploads never break even if a
  native tool is missing.

## CORS whitelist (production)

`server/server.js` and `signaling/index.js` allow:
- every `*.vercel.app` origin (any production/preview deployment),
- `localhost`, `127.0.0.1:*`, ngrok tunnels (dev),
- any origin in the `CORS_ORIGINS` env var (comma-separated; the master
  script appends the exact deployed Vercel domain automatically).

Everything else is blocked at the browser by the absence of
`Access-Control-Allow-Origin`.

## TURN (video on 4G/mobile)

Set `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` in
`scripts/deploy/.env.secrets` (or `frontend/.env`) — the master script injects
them into the Vercel build, `frontend/vercel.json`, and `.env.local`.
Without them the app falls back to Google STUN, which does **not** traverse
mobile carrier NAT. `frontend/src/Components/Views/LiveView.jsx` /
`pages/LiveRoom.jsx` already consume these vars.

---

# Option 1: Deploying to Cloudflare (Workers & Pages)

EduNova X is pre-configured with `wrangler.toml`, `wrangler.jsonc`, and `_redirects` for zero-config Cloudflare builds.

## Via Cloudflare Dashboard
1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **Create application** → **Connect to Git**
2. Select `edunova_x`
3. Build Settings:
   - **Framework preset**: `Vite` (or `None`)
   - **Build command**: `npm run build`
   - **Build output directory**: `dist` (or `frontend/dist`)
   - **Root directory**: `/`
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
