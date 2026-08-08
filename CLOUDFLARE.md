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

## 🛠 Troubleshooting: "Cannot use assets with a binding in an assets-only Worker"

```
✘ [ERROR] Cannot use assets with a binding in an assets-only Worker.
  Please remove the asset binding from your configuration file, or provide a Worker
  script in your configuration file `main`).
```

**Cause:** the Wrangler configuration declares an `[assets]` binding (e.g. `binding = "ASSETS"`)
but no `main` worker script, so Wrangler treats the deployment as an assets-only Worker.

**Fix (already applied in this repo):** both `wrangler.toml` and `wrangler.jsonc` define
`main = "./dist/_worker.js"` **together with** `binding = "ASSETS"`. The build script
(`scripts/build.js`) also validates this at build time and fails with a clear message if the
config ever regresses.

If you still see the error after merging:

1. **Deploy the latest `main`** — the error only occurs with a configuration that lacks `main`
   (the pre-fix state). Redeploy from the dashboard, or run locally:
   `git pull && npm run build && npx wrangler deploy`.
2. **Root directory must be `/`** — if the Cloudflare build's root directory is anything other
   than the repo root, the repository's `wrangler.toml`/`wrangler.jsonc` are not found and
   Cloudflare may auto-generate an assets-only configuration.
3. **Trigger a fresh build** — if the project previously deployed as assets-only, a new build
   from current `main` uploads the Worker script and assets together.

> Note: `frontend/public/.assetsignore` (copied to `dist/.assetsignore` by the build) excludes
> `_worker.js` from the static asset upload, so the same file can serve as the Worker's `main`
> script without being uploaded as a public asset.

---

## 🌐 Connecting Frontend to Backend Services

The static frontend on Cloudflare connects to your backend services:
- **Express API**: Deploy `server/` to Render / Railway / Docker.
- **WebRTC Signaling**: Embedded in `server/` or deployed from `signaling/`.
- **AI Engine**: Deploy `ai_engine/` (FastAPI) to Render / Railway.

Set `VITE_API_URL` and `VITE_SIGNAL_URL` in Cloudflare Pages / Worker environment variables and trigger a redeploy.
