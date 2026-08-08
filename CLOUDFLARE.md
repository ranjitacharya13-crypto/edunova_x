# Deploying EduNova X to Cloudflare (Workers & Pages)

EduNova X is fully configured for zero-config deployment on **Cloudflare Workers** (with Static Assets) and **Cloudflare Pages**.

---

## ⚡ Quick Deployment via Cloudflare Dashboard

Link: [Cloudflare Workers & Pages Dashboard](https://dash.cloudflare.com/)

### If deploying via Cloudflare Workers & Pages (Git Integration)

1. Go to **Workers & Pages** → **Create application** → **Pages** (or **Workers**) → **Connect to Git**.
2. Select your repository: **`edunova_x`**.
3. Set your build configuration:
   - **Framework preset**: `Vite` (or `None`)
   - **Build command**: `npm run build` (or `npm run pages:build`)
   - **Build output directory**: `dist` (or `frontend/dist`)
   - **Root directory**: `/` (repo root) or `frontend`
4. Add **Environment Variables** (under *Settings* → *Environment Variables*):
   | Variable | Value | Description |
   |---|---|---|
   | `NODE_VERSION` | `20` | Ensures modern Node.js runtime in Cloudflare CI |
   | `VITE_API_URL` | `https://your-backend.onrender.com/api` | Your deployed backend REST API (include `/api`) |
   | `VITE_SIGNAL_URL` | `https://your-backend.onrender.com` | Your deployed WebRTC Socket.IO signaling URL |
5. Click **Save and Deploy**.

---

## 🚀 Deploying via Wrangler CLI

You can also deploy directly from your local terminal:

```bash
# 1. Install dependencies and build static assets
npm run build

# 2. Deploy to Cloudflare Workers (Static Assets)
npx wrangler deploy

# Or deploy to Cloudflare Pages
npx wrangler pages deploy dist --project-name=edunova-x
```

---

## 🛠️ Configuration Files Included in This Repo

| File | Purpose |
|---|---|
| [`wrangler.toml`](./wrangler.toml) | Cloudflare Worker + Static Assets configuration |
| [`wrangler.jsonc`](./wrangler.jsonc) | Modern Cloudflare Worker configuration schema |
| [`scripts/build.js`](./scripts/build.js) | Universal build script that compiles Vite frontend and outputs to `./dist` and `./frontend/dist` |
| [`frontend/public/_redirects`](./frontend/public/_redirects) | Cloudflare SPA routing fallback (`/* /index.html 200`) |
| [`frontend/public/_headers`](./frontend/public/_headers) | Cache headers and security policies |
| [`frontend/public/_routes.json`](./frontend/public/_routes.json) | Cloudflare Pages functions routing rules |
| [`frontend/public/_worker.js`](./frontend/public/_worker.js) | Advanced Cloudflare Worker script for static serving + optional API proxying |
| [`.node-version`](./.node-version) / [`.nvmrc`](./.nvmrc) | Pins Node 20.x for Cloudflare CI builds |

---

## 🔄 SPA Routing Support

Cloudflare automatically routes all client-side navigation (e.g. `/live/:roomId`, `/dashboard`, `/admin`) to `index.html` with HTTP 200 via `_redirects` and `wrangler.toml`'s `not_found_handling = "single-page-application"`.

---

## 🌐 Connecting Frontend to Backend Services

The static frontend on Cloudflare connects to your backend services:
- **Express API**: Deploy `server/` to Render / Railway / Docker.
- **WebRTC Signaling**: Embedded in `server/` or deployed from `signaling/`.
- **AI Engine**: Deploy `ai_engine/` (FastAPI) to Render / Railway.

Set `VITE_API_URL` and `VITE_SIGNAL_URL` in Cloudflare Pages / Worker environment variables and trigger a redeploy.
