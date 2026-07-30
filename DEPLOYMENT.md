# Deploying EduNova_X to Vercel

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
