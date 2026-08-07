# Deploying the EduNova_X Backend to Render — CLI Runbook

This runbook deploys the three backend services to [Render](https://render.com)
using the **official Render CLI** (`render-oss/cli`, v2.22.0):

| Service | Folder | Runtime | URL (default) | Health check |
|---|---|---|---|---|
| `edunova-api` | `server/` | Node | `https://edunova-api.onrender.com` | `GET /api/test` |
| `edunova-signal` | `signaling/` | Node | `https://edunova-signal.onrender.com` | `GET /` |
| `edunova-ai` | `ai_engine/` | Python | `https://edunova-ai.onrender.com` | `GET /health` |

> **Why this runbook?** A sandbox/CI machine was used to prepare everything
> (blueprint fixes, `requirements.txt` fix, idempotent deploy script), but that
> machine's network blocks `*.render.com` (TLS to `api.render.com`/`dashboard.render.com`
> is reset at the firewall), so the actual `render login` / `render services create`
> calls must run from your own machine — which is also where your browser opens
> for the CLI OAuth login. Everything below is copy-paste.

---

## 0. One-time prerequisites

- A Render account. Log in with the Google account **`ranjitacharya13@gmail.com`** —
  the CLI device-flow login happens in your browser, so this is what you'll authorize with.
- The GitHub repo `ranjitacharya13-crypto/edunova_x` is **connected to Render**.
  If it isn't (or you get a "repo not found / not connected" error):
  Render Dashboard → **Account settings → GitHub → Connect** (or just launch the
  blueprint once: Dashboard → **New → Blueprint** → pick the repo).
- MongoDB Atlas network access allows Render egress (or `0.0.0.0/0`): Atlas →
  **Network Access** → Add `0.0.0.0/0` (or Render's egress IPs).

## 1. Install the Render CLI

```bash
# macOS
brew update && brew install render

# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/render-oss/cli/main/bin/install.sh | sh
```

### Windows (Git Bash / MINGW64) — manual download required

> ⚠️ The official `install.sh` **does not support Windows**: on Git Bash it prints
> `Unsupported operating system: MINGW64_NT-...` and exits. Download the Windows
> binary from the GitHub release instead:

```bash
cd ~
curl -fsSL -o render.zip https://github.com/render-oss/cli/releases/latest/download/cli_2.22.0_windows_amd64.zip
unzip -o render.zip        # if "unzip: command not found", use:
                           #   powershell.exe -Command "Expand-Archive -Force render.zip -DestinationPath ."
mkdir -p ~/bin
mv cli_*.exe ~/bin/render.exe
export PATH="$HOME/bin:$PATH"      # add to ~/.bashrc so it persists:
                                   #   echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
render --version
```

> If you see `bash: $'\E[200~curl': command not found` when pasting, the paste was
> mangled — **type the command manually** or paste one line at a time.

Verify: `render --version` → `v2.22.0`.

## 2. Log in (browser device flow)

```bash
render login
```

1. Your browser opens a Render confirmation page.
2. Sign in with **`ranjitacharya13@gmail.com`** (if not already signed in).
3. Click **Authorize CLI**.
4. Back in the terminal, select the workspace to deploy into.

Check: `render whoami` and `render workspaces`.

> Non-interactive/CI alternative: generate an API key at
> Dashboard → **Account settings → API keys** and `export RENDER_API_KEY=rnd_...`.
> CLI tokens from `render login` are fine for one-off deploys.

## 3. Get the latest code

The deployment fixes (blueprint secrets, AI dependencies) are on the branch
`arena/019fdaa0-edunova-x` as a PR into `main`. Merge the PR (Render auto-deploys
on merge if the services already exist), then:

```bash
git checkout main && git pull
```

Or to test first from the branch: `export RENDER_BRANCH=arena/019fdaa0-edunova-x`.

## 4. Deploy with the script (recommended)

```bash
cd edunova_x
./scripts/deploy-render.sh
```

What it does, step by step:

1. **Preflight** — checks the CLI is installed and you're logged in
   (`render whoami`).
2. **Validates** the blueprint — `render blueprints validate ./render.yaml`
   (catches schema/plan/region mistakes before anything is created).
3. **Creates missing services** via `render services create` with the correct
   runtime, root dir, build/start commands, plan, region and env vars
   (`MONGO_URI`, generated `JWT_SECRET`, `AI_ENGINE_URL`). Services that already
   exist are skipped — the script is idempotent.
4. **Deploys** each service: `render deploys create <service-id> --wait`
   (blocks until the deploy finishes; free-plan builds can take several minutes).
5. **Health-checks** all three endpoints with retries (free instances cold-start
   30–60 s on the first hit).

Useful variants:

```bash
./scripts/deploy-render.sh --deploy-only   # don't create anything, just redeploy
PLAN=starter ./scripts/deploy-render.sh    # paid plan instead of free
RENDER_BRANCH=my-branch ./scripts/deploy-render.sh
```

## 5. Manual CLI alternative

If you'd rather run the commands yourself:

```bash
# 1) Validate the blueprint
render blueprints validate ./render.yaml

# 2) Create the API service (example; repeat pattern for the other two)
render services create \
  --name edunova-api --type web_service \
  --repo https://github.com/ranjitacharya13-crypto/edunova_x --branch main \
  --runtime node --root-directory server \
  --build-command "npm install" --start-command "node server.js" \
  --plan free --region oregon --health-check-path /api/test \
  --env-var "MONGO_URI=mongodb+srv://ranjit5201314_db_user:ranjit_1215@cluster1edunovax.8q5lafw.mongodb.net/edunova?appName=Cluster1edunovaX" \
  --env-var "JWT_SECRET=$(openssl rand -base64 48)" \
  --env-var "AI_ENGINE_URL=https://edunova-ai.onrender.com" \
  --output json --confirm

# 3) Trigger deploys and watch them
render services --output json --confirm          # find each service's id
render deploys create <service-id> --wait

# 4) Tail logs
render logs --resources <service-id> --tail
```

Service templates (root dir / build / start / health):

| Service | `--runtime` | `--root-directory` | `--build-command` | `--start-command` | health |
|---|---|---|---|---|---|
| `edunova-api` | `node` | `server` | `npm install` | `node server.js` | `/api/test` |
| `edunova-signal` | `node` | `signaling` | `npm install` | `node index.js` | `/` |
| `edunova-ai` | `python` | `ai_engine` | `pip install -r requirements.txt` | `uvicorn main:app --host 0.0.0.0 --port 10000` | `/health` |

Env vars per service:

- **edunova-api**: `MONGO_URI` (required), `JWT_SECRET` (required — random long string),
  `AI_ENGINE_URL` (recommended: `https://edunova-ai.onrender.com`).
  Optional: `SEED_DEMO_USERS=false`, `ADMIN_TEMP_PASSWORD`, `EMAIL_USER`/`EMAIL_PASS`/`CONTACT_RECEIVER_EMAIL`.
- **edunova-signal**: none (Render injects `PORT`).
- **edunova-ai**: `MONGO_URI` (required).

> ⚠️ The CLI (v2.22.0) can **set env vars only at service creation**
> (`--env-var`). To change env vars on an existing service: Dashboard →
> your service → **Environment** → edit → **Save & Deploy**.

## 6. Verify the deployment

```bash
curl -i https://edunova-api.onrender.com/api/test        # expect: HTTP 200 "OK"
curl -i https://edunova-signal.onrender.com/             # expect: 200 JSON {service:"edunova-signal"}
curl -i https://edunova-ai.onrender.com/health           # expect: 200 {"status":"ok"}
```

## 7. Wire the frontend (Vercel) to the backends

In Vercel → project **Settings → Environment Variables** (then redeploy — Vite
inlines them at build time):

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://edunova-api.onrender.com/api` |
| `VITE_SIGNAL_URL` | `https://edunova-api.onrender.com` |

(`server/` already embeds Socket.IO signaling, so pointing `VITE_SIGNAL_URL` at
the API service is enough; the standalone `edunova-signal` service is optional.)

## Troubleshooting

- **`render services create` → repo not connected**: connect the GitHub repo to
  Render once (see prerequisites).
- **Script says "Node.js not found"**: the script uses Node for JSON parsing (no
  Python needed — the Windows `python` shortcut can be a Microsoft Store stub).
  You already have Node as a Node.js project; make sure it's on your PATH
  (`node --version` should print a version).
- **`plan: free` rejected**: Render's free instances are for the free (Hobby)
  workspace and sleep after ~15 min. Retry with `PLAN=starter ./scripts/deploy-render.sh`.
- **API service starts but `MONGO_URI` auth fails**: double-check the Atlas
  password (the URI embeds `ranjit_1215`; if Atlas was recreated, update
  `MONGO_URI` in the Dashboard) and Atlas **Network Access**.
- **AI chat 502 from the API**: `AI_ENGINE_URL` on `edunova-api` is wrong/unset —
  set it to `https://edunova-ai.onrender.com` in the Dashboard and redeploy.
- **`JWT_SECRET` not set**: the API's auth routes fail at sign-in. `render.yaml`
  now uses `generateValue: true` (blueprint path) / the script generates one
  (CLI path).
- **Slow first request**: normal on free instances (cold start). Upgrade the plan
  or keep a health-check ping running.
