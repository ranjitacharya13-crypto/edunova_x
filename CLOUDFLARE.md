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
   - **Build output directory**: `dist`
   - **Root directory**: `/` (repo root) — **required**. The repository's `wrangler.toml` / `wrangler.jsonc` (which define the Worker script `main` and the `ASSETS` binding) are only read from the repo root. If you pick any other root directory, Cloudflare won't find the Wrangler config and may auto-generate an assets-only configuration instead.
4. Add **Environment Variables** (under *Settings* → *Environment Variables*):
   | Variable | Value | Description |
   |---|---|---|
   | `NODE_VERSION` | `20` | Ensures modern Node.js runtime in Cloudflare CI |
   | `VITE_API_URL` | `https://edunova-api-y3rx.onrender.com/api` | Your deployed backend REST API (include `/api`) |
   | `VITE_SIGNAL_URL` | *(leave empty)* | Socket.IO is hosted by the Render API and is derived from `VITE_API_URL`. Set this only when intentionally using a separate signaling service. |
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

## 🛠 Troubleshooting: "Cannot use assets with a binding in an assets-only Worker"

```
✘ [ERROR] Cannot use assets with a binding in an assets-only Worker.
```

**Cause:** an assets binding was configured without a Worker `main` script.

**Fix used by this repo:** `wrangler.toml` and `wrangler.jsonc` intentionally use
Cloudflare's assets-only mode. They set the `dist` assets directory and SPA fallback,
but do not declare a binding or `main` script. `scripts/build.js` validates this before
each deployment.

If you still see the error:

1. Deploy the latest `main`: `git pull && npm run build && npx wrangler deploy`.
2. Keep the Cloudflare project root at the repository root so the committed Wrangler
   configuration is found.
3. Remove any dashboard-generated assets binding that conflicts with the committed
   assets-only configuration, then trigger a fresh build.

---

## 🌐 Connecting Frontend to Backend Services

The static frontend on Cloudflare connects to your backend services:
- **Express API**: Deploy `server/` to Render / Railway / Docker.
- **WebRTC Signaling**: Embedded in `server/` or deployed from `signaling/`.
- **AI Engine**: Deploy `ai_engine/` (FastAPI) to Render / Railway.

Set `VITE_API_URL` in Cloudflare's build environment and trigger a redeploy. Leave `VITE_SIGNAL_URL` empty unless `signaling/` is intentionally deployed as a separate service.
