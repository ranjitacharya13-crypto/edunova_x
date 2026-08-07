#!/usr/bin/env bash
# =============================================================================
# deploy-render.sh — Deploy the EduNova_X backend to Render with the Render CLI
# =============================================================================
#
# Services deployed (see render.yaml for the blueprint equivalents):
#   edunova-api    Express + MongoDB + JWT + Socket.IO   (server/)
#   edunova-signal standalone WebRTC signaling           (signaling/)
#   edunova-ai     FastAPI AI engine / edu_assistance    (ai_engine/)
#
# Usage:
#   ./scripts/deploy-render.sh                 # create missing services + deploy latest main
#   RENDER_BRANCH=my-branch ./scripts/deploy-render.sh   # deploy a specific branch
#   PLAN=starter ./scripts/deploy-render.sh    # paid plan instead of free
#   ./scripts/deploy-render.sh --deploy-only   # only redeploy existing services
#
# Prerequisites:
#   1. Render CLI installed (Windows: see RENDER_CLI_DEPLOY.md — install.sh does
#      not support Git Bash, download the windows_amd64 zip instead).
#   2. Logged in:  render login  -> authorize in the browser with your Render
#      account (the Google account ranjitacharya13@gmail.com)
#   3. Node.js available (used for JSON parsing; this is a Node project).
#
# Environment overrides (all optional):
#   RENDER_BRANCH    branch Render builds from          (default: main)
#   PLAN             free | starter | standard | pro    (default: free)
#   REGION           oregon | frankfurt | ohio | singapore | virginia (default: oregon)
#   RENDER_WORKSPACE workspace id/name to deploy into   (default: active workspace)
#   MONGO_URI        Atlas connection string            (default: render.yaml value)
#   AI_ENGINE_URL    AI service URL                     (default: https://edunova-ai.onrender.com)
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ranjitacharya13-crypto/edunova_x}"
BRANCH="${RENDER_BRANCH:-main}"
PLAN="${PLAN:-free}"
REGION="${REGION:-oregon}"
WORKSPACE="${RENDER_WORKSPACE:-}"

# Same Atlas URI as render.yaml (edunova-api + edunova-ai)
MONGO_URI="${MONGO_URI:-mongodb+srv://ranjit5201314_db_user:ranjit_1215@cluster1edunovax.8q5lafw.mongodb.net/edunova?appName=Cluster1edunovaX}"
# AI_ENGINE_URL is resolved from the real edunova-ai slug later (services may
# have suffixed onrender.com URLs). Override with AI_ENGINE_URL=... if needed.
AI_ENGINE_URL="${AI_ENGINE_URL:-}"

DEPLOY_ONLY=0
[ "${1:-}" = "--deploy-only" ] && DEPLOY_ONLY=1

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy][warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy][error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# JSON parsing via Node (Windows Git Bash has no python3; `python` may be the
# Microsoft Store stub). json_field EXPR reads JSON from stdin and evaluates
# EXPR with `j` = the parsed value; process.argv[1..] = extra args.
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found — required for JSON parsing."
json_field() {
  local expr="$1"; shift
  node -e "
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{ const j=JSON.parse(d); $expr }catch(e){}
    });
  " -- "$@" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
command -v render >/dev/null 2>&1 || die "Render CLI not found. Install it (Windows: see RENDER_CLI_DEPLOY.md)."

if ! render whoami >/dev/null 2>&1; then
  die "Not logged in to Render. Run: render login  (authorize in the browser with your Render account)"
fi
# NOTE: `render whoami` always prints TEXT (Name:/Email:), it ignores --output json.
WHOAMI_OUT="$(render whoami 2>/dev/null || true)"
AUTH_NAME="$(printf '%s\n' "$WHOAMI_OUT" | sed -n 's/^Name: //p' | head -1)"
AUTH_EMAIL="$(printf '%s\n' "$WHOAMI_OUT" | sed -n 's/^Email: //p' | head -1)"
log "Authenticated as: ${AUTH_NAME:-?}${AUTH_EMAIL:+ ($AUTH_EMAIL)}"

# ---------------------------------------------------------------------------
# Ensure an active workspace is set
# ---------------------------------------------------------------------------
if [ -n "$WORKSPACE" ]; then
  render workspace set "$WORKSPACE" >/dev/null 2>&1 \
    && log "Active workspace set to: $WORKSPACE" \
    || die "Could not set workspace '$WORKSPACE'. List them with: render workspaces"
else
  CURRENT_WS="$(render workspace current --output json --confirm 2>/dev/null | json_field 'console.log(j.id || "")' || true)"
  if [ -z "$CURRENT_WS" ]; then
    WS_JSON="$(render workspaces --output json --confirm 2>/dev/null || echo '[]')"
    COUNT="$(printf '%s' "$WS_JSON" | json_field 'console.log(j.length)')"
    if [ "$COUNT" = "1" ]; then
      WID="$(printf '%s' "$WS_JSON" | json_field 'console.log(j[0].id)')"
      WNAME="$(printf '%s' "$WS_JSON" | json_field 'console.log(j[0].name)')"
      if render workspace set "$WID" >/dev/null 2>&1; then
        log "Auto-set active workspace: $WNAME ($WID)"
      else
        printf '%s' "$WS_JSON" | json_field 'j.forEach(w => console.log("   " + w.id + "   " + w.name))'
        die "Could not set workspace '$WID'. Run: render workspace set <id-or-name>   (pick one from the list above)"
      fi
    else
      printf '%s' "$WS_JSON" | json_field 'j.forEach(w => console.log("   " + w.id + "   " + w.name))'
      die "No active workspace. Run: render workspace set <id-or-name>   (pick one from the list above)"
    fi
  else
    log "Active workspace: $CURRENT_WS"
  fi
fi

# ---------------------------------------------------------------------------
# Validate the blueprint before touching anything
# ---------------------------------------------------------------------------
log "Validating render.yaml blueprint..."
if VALIDATION_OUT="$(render blueprints validate ./render.yaml --output json --confirm 2>&1)"; then
  log "render.yaml validation: OK"
else
  warn "render.yaml validation failed (dashboard blueprint syncs may complain):"
  printf '%s\n' "$VALIDATION_OUT" | head -c 500
  echo
fi

# ---------------------------------------------------------------------------
# Fetch existing services (name -> id, slug/url)
# ---------------------------------------------------------------------------
SERVICES_JSON="$(render services --output json --confirm 2>/dev/null || echo '[]')"

log "Services currently in the workspace:"
if [ "$(printf '%s' "$SERVICES_JSON" | json_field 'console.log(j.length)')" = "0" ] 2>/dev/null; then
  log "   (none)"
else
  printf '%s' "$SERVICES_JSON" | json_field 'for (const r of j) {
    const s = r.service || r;
    if (s.id && s.name) console.log("   " + s.name + "  " + s.id + "  " + (s.slug ? "https://" + s.slug + ".onrender.com" : "(no url)"))
  }'
fi

service_id() { # $1 = service name
  # `render services -o json` nests each service under "service":
  #   [{"service":{"id":"srv-..","name":"edunova-api",...}, "project":..., "environment":...}]
  printf '%s' "$SERVICES_JSON" | json_field 'for (const r of j) {
    const s = r.service || r;
    if (s.name === process.argv[1] && s.id) { console.log(s.id); break }
  }' "$1"
}
service_slug() { # $1 = service name -> onrender.com subdomain (slug)
  printf '%s' "$SERVICES_JSON" | json_field 'for (const r of j) {
    const s = r.service || r;
    if (s.name === process.argv[1] && s.slug) { console.log(s.slug); break }
  }' "$1"
}
service_url() { # $1 = service name, $2 = path (optional)
  local slug
  slug="$(service_slug "$1")"
  if [ -z "$slug" ]; then
    slug="$1"
    warn "No slug found for '$1' — assuming https://$1.onrender.com (check the Dashboard for the real URL)"
  fi
  printf 'https://%s.onrender.com%s' "$slug" "${2:-}"
}

# AI_ENGINE_URL must point at the REAL edunova-ai URL (slug may be suffixed).
if [ -z "$AI_ENGINE_URL" ]; then
  AI_ENGINE_URL="$(service_url edunova-ai 2>/dev/null)"
  log "AI_ENGINE_URL resolved to: $AI_ENGINE_URL"
fi

# ---------------------------------------------------------------------------
# Service definitions: name|runtime|rootDir|build|start|health|envVars(; separated)
# ---------------------------------------------------------------------------
# JWT_SECRET is generated here (before the array is built) so the API service
# always gets a secret at creation time.
if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
  log "Generated a fresh JWT_SECRET for edunova-api"
fi

SERVICES=(
  "edunova-api|node|server|npm install|node server.js|/api/test|MONGO_URI=${MONGO_URI};JWT_SECRET=${JWT_SECRET};AI_ENGINE_URL=${AI_ENGINE_URL}"
  "edunova-signal|node|signaling|npm install|node index.js|/|"
  "edunova-ai|python|ai_engine|pip install -r requirements.txt|uvicorn main:app --host 0.0.0.0 --port 10000|/health|MONGO_URI=${MONGO_URI}"
)

# ---------------------------------------------------------------------------
# Create missing services
# ---------------------------------------------------------------------------
if [ "$DEPLOY_ONLY" -eq 1 ]; then
  log "--deploy-only: skipping service creation"
else
  for def in "${SERVICES[@]}"; do
    IFS='|' read -r name runtime rootdir buildcmd startcmd health envs <<< "$def"
    sid="$(service_id "$name")"
    if [ -n "$sid" ]; then
      log "Service '$name' exists ($sid) — enforcing correct config..."
      if render services update "$sid" \
           --runtime "$runtime" --root-directory "$rootdir" \
           --build-command "$buildcmd" --start-command "$startcmd" \
           --health-check-path "$health" --branch "$BRANCH" --confirm >/dev/null 2>&1; then
        log "   config updated"
      else
        warn "   config update failed (continuing) — if health checks fail, fix in Dashboard -> $name -> Settings"
      fi
      continue
    fi
    log "Creating service '$name' ($runtime, root=$rootdir, plan=$PLAN, branch=$BRANCH)..."
    args=(--name "$name" --type web_service --repo "$REPO_URL" --branch "$BRANCH"
          --runtime "$runtime" --root-directory "$rootdir"
          --build-command "$buildcmd" --start-command "$startcmd"
          --plan "$PLAN" --region "$REGION" --health-check-path "$health")
    if [ -n "$envs" ]; then
      while IFS= read -r line; do
        [ -z "$line" ] && continue
        k="${line%%=*}"   # split on the FIRST '=' only, so secrets may contain '='
        v="${line#*=}"
        [ -n "$k" ] && [ -n "$v" ] && args+=(--env-var "$k=$v")
      done <<< "$(printf '%s\n' "$envs" | tr ';' '\n')"
    fi
    out="$(render services create "${args[@]}" --output json --confirm 2>&1 || true)"
    if printf '%s' "$out" | grep -qi "already in use"; then
      warn "Service '$name' already exists on Render (the list check missed it) — re-fetching its id and continuing."
      SERVICES_JSON="$(render services --output json --confirm 2>/dev/null || echo '[]')"
      new_id="$(service_id "$name")"
    else
      new_id="$(printf '%s' "$out" | json_field 'console.log((j.service || j).id || "")')"
      if [ -z "$new_id" ]; then
        new_id="$(printf '%s' "$out" | grep -o '"id"[[:space:]]*:[[:space:]]*"srv-[a-z0-9]*"' | head -1 | grep -o 'srv-[a-z0-9]*' || true)"
      fi
    fi
    if [ -n "$new_id" ]; then
      new_slug="$(printf '%s' "$out" | json_field 'console.log((j.service || j).slug || "")')"
      SERVICES_JSON="$(printf '%s' "$SERVICES_JSON" | json_field 'j.push({name: process.argv[1], id: process.argv[2], slug: process.argv[3]}); console.log(JSON.stringify(j))' "$name" "$new_id" "$new_slug")"
    else
      warn "Created '$name' but could not parse its id from output."
    fi
    log "Service '$name' created: $(service_url "$name")"
  done
fi

# ---------------------------------------------------------------------------
# Trigger a deploy for every service and wait for it
# ---------------------------------------------------------------------------
log "Triggering deploys (branch: $BRANCH) — this can take several minutes on free plans..."
for def in "${SERVICES[@]}"; do
  name="${def%%|*}"
  sid="$(service_id "$name")"
  if [ -z "$sid" ]; then
    warn "No service id found for '$name' — cannot deploy (create it first without --deploy-only)."
    continue
  fi
  log "Deploying $name ($sid)..."
  if render deploys create "$sid" --wait --confirm; then
    log "✅ $name deploy succeeded"
  else
    warn "❌ $name deploy failed — inspect logs: render logs --resources $sid --tail"
  fi
done

if [ -n "$(service_id edunova-api)" ]; then
  warn "Verify on the Dashboard that edunova-api has AI_ENGINE_URL=$(service_url edunova-ai)"
  warn "(the CLI cannot edit env vars yet; use Dashboard -> edunova-api -> Environment)"
fi

# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------
API_URL="$(service_url edunova-api)"
SIGNAL_URL="$(service_url edunova-signal)"
AI_URL="$(service_url edunova-ai)"
log "Health checks (first hit on a free plan cold-starts, allow 30-60s)..."
check() { # $1 url
  if curl -sf --max-time 90 --retry 8 --retry-delay 10 -o /dev/null "$1"; then
    log "✅ $1"
  else
    warn "⚠️  $1 not healthy yet (retry in a minute)"
  fi
}
check "$API_URL/api/test"
check "$SIGNAL_URL/"
check "$AI_URL/health"

cat <<EOF

================ Deploy summary ================
  API          $API_URL          (test: /api/test)
  Signaling    $SIGNAL_URL       (health: /)
  AI engine    $AI_URL           (health: /health)

Frontend wiring (Vercel):
  VITE_API_URL    = $API_URL/api
  VITE_SIGNAL_URL = $API_URL
  (or $SIGNAL_URL if using the standalone signaling service)

Live logs:  render logs --resources <service-id> --tail
EOF
