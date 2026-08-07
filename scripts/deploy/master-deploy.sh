#!/usr/bin/env bash
# =============================================================================
# EduNova_X — MASTER DEPLOY SCRIPT (Bash)
# -----------------------------------------------------------------------------
# One-command production deployment pipeline:
#   1. Authenticate with Render API key + Vercel token
#   2. Commit & push the repaired code + render.yaml, validate the Blueprint,
#      then create the 3 services (edunova-api, edunova-signal, edunova-ai)
#      via the Render API (Blueprint-style, fully automated)
#   3. Poll Render until all three services are LIVE (deploy status + /health)
#   4. Rewrite frontend/vercel.json + env vars (.env.production / Vercel env)
#      with the live Render URLs (incl. TURN server for 4G/mobile video)
#   5. Deploy the frontend to Vercel: vercel --prod
#
# Usage:
#   ./master-deploy.sh                      # reads secrets from .env.secrets
#   RENDER_API_KEY=... VERCEL_TOKEN=... ./master-deploy.sh
#   ./master-deploy.sh --skip-git-push      # do not commit/push local changes
#
# Secrets file format (scripts/deploy/.env.secrets, KEY=VALUE per line):
#   VERCEL_TOKEN=...
#   RENDER_API_KEY=...
#   MONGO_URI=...
#   JWT_SECRET=...
#   ... (copy .env.secrets.example)
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
RENDER_YAML="$REPO_ROOT/render.yaml"

RENDER_API="https://api.render.com/v1"
VERCEL_API="https://api.vercel.com/v2"

# --- configuration (env vars override .env.secrets, CLI flags override both) --
# Parse KEY=VALUE lines (quote-aware: values may contain spaces / special chars)
SECRETS_FILE="${SECRETS_FILE:-$SCRIPT_DIR/.env.secrets}"
if [ -f "$SECRETS_FILE" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ""|\#*) continue ;; esac
    _v="${_v%\"}"; _v="${_v#\"}"; _v="${_v%\'}"; _v="${_v#\'}"
    export "$_k=$_v"
  done < "$SECRETS_FILE"
fi

GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_REPO="${GIT_REPO:-$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#\.git$##')}"
GIT_REPO="${GIT_REPO:-https://github.com/ranjitacharya13-crypto/edunova_x}"
RENDER_PLAN="${RENDER_PLAN:-free}"
RENDER_REGION="${RENDER_REGION:-oregon}"
POLL_TIMEOUT_MIN="${POLL_TIMEOUT_MIN:-25}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-20}"
VERCEL_PROJECT="${VERCEL_PROJECT:-edunova-x}"
SKIP_GIT_PUSH="${SKIP_GIT_PUSH:-0}"
SKIP_VERCEL="${SKIP_VERCEL:-0}"

for arg in "$@"; do
  case "$arg" in
    --skip-git-push) SKIP_GIT_PUSH=1 ;;
    --skip-vercel)   SKIP_VERCEL=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done

# --- colors ------------------------------------------------------------------
C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
ok()   { printf '%s[ OK ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s[ .. ]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "Missing required tool: $1 (install it first)."; }
mask() { [ -n "$2" ] && echo "${2:0:4}…${2: -4}" || echo "(empty)"; }

# =============================================================================
echo "${C_BOLD}"
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║           EduNova_X — Master Deploy Pipeline (Bash)                  ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo "${C_RESET}"

need curl; need jq; need git; need node

# =============================================================================
# STAGE 1 — AUTHENTICATE
# =============================================================================
echo; echo "${C_BOLD}▶ Stage 1 — Authenticating with Render + Vercel${C_RESET}"

[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY not set (add it to $SECRETS_FILE or export it)."
[ -n "${VERCEL_TOKEN:-}" ]   || die "VERCEL_TOKEN not set (add it to $SECRETS_FILE or export it)."
ok "Using Render API key   : $(mask RENDER_API_KEY "$RENDER_API_KEY")"
ok "Using Vercel token     : $(mask VERCEL_TOKEN "$VERCEL_TOKEN")"

RENDER_OWNER_ID="${RENDER_OWNER_ID:-}"
if [ -z "$RENDER_OWNER_ID" ]; then
  OWNERS_JSON="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/owners?limit=100")" \
    || die "Could not reach Render API (network?)"
  RENDER_OWNER_ID="$(echo "$OWNERS_JSON" | jq -r '[.[] | select(.type == "personal")][0].id // .[0].id // empty' 2>/dev/null)"
  [ -n "$RENDER_OWNER_ID" ] || die "Render auth failed — key rejected or account has no workspace. Response: $(echo "$OWNERS_JSON" | head -c 300)"
fi
ok "Render workspace       : $RENDER_OWNER_ID"

if command -v vercel >/dev/null 2>&1; then
  VERCEL_WHO="$(vercel whoami --token "$VERCEL_TOKEN" 2>&1)"
else
  VERCEL_WHO="$(curl -sS -m 30 -H "Authorization: Bearer $VERCEL_TOKEN" "$VERCEL_API/user" | jq -r 'if .username then .username else empty end' 2>/dev/null)"
fi
[ -n "$VERCEL_WHO" ] && [ "$VERCEL_WHO" != "null" ] || die "Vercel auth failed — token rejected or network blocked. Response: $VERCEL_WHO"
ok "Vercel identity        : $VERCEL_WHO"

# =============================================================================
# STAGE 2 — PUSH render.yaml BLUEPRINT + CREATE THE THREE SERVICES
# =============================================================================
echo; echo "${C_BOLD}▶ Stage 2 — Pushing blueprint & creating services${C_RESET}"

if [ "$SKIP_GIT_PUSH" = "1" ]; then
  warn "Skipping git commit/push (--skip-git-push). Make sure $RENDER_YAML and the code fixes are already on '$GIT_BRANCH'."
else
  cd "$REPO_ROOT" || die "Cannot cd to repo root"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "chore(deploy): health routes + render.yaml blueprint + deploy automation" >/dev/null \
      || warn "git commit failed (nothing to commit?)"
  else
    info "No local changes to commit."
  fi
  git push origin "$GIT_BRANCH" 2>/dev/null || die "git push to '$GIT_BRANCH' failed — push manually, then rerun."
  ok "Pushed code to $GIT_REPO ($GIT_BRANCH)"
fi

# --- 2a. Validate the blueprint through Render ---------------------------------
info "Validating $RENDER_YAML against Render Blueprint spec…"
VALIDATE_JSON="$(curl -sS -m 60 -X POST "$RENDER_API/blueprints/validate" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -F "ownerId=$RENDER_OWNER_ID" \
  -F "file=@$RENDER_YAML;type=text/yaml")"
VALID="$(echo "$VALIDATE_JSON" | jq -r '.valid // false' 2>/dev/null)"
if [ "$VALID" = "true" ]; then
  ok "Blueprint is VALID. Planned resources:"
  echo "$VALIDATE_JSON" | jq -r '.plan.services[]' | sed 's/^/     - /'
else
  warn "Blueprint validation reported issues:"
  echo "$VALIDATE_JSON" | jq -r '.errors[]? | "     \(.path // "?"): \(.error)"' 2>/dev/null || echo "$VALIDATE_JSON" | head -c 500
  die "Fix render.yaml and rerun."
fi

# --- 2b. Blueprint instance check ----------------------------------------------
BP_JSON="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/blueprints?ownerId=$RENDER_OWNER_ID")"
EXISTING_BP="$(echo "$BP_JSON" | jq -r --arg repo "$GIT_REPO" '.[] | select((.repo // "") | contains($repo)) | .id' 2>/dev/null | head -1)"
if [ -n "$EXISTING_BP" ]; then
  ok "Found existing Blueprint instance $EXISTING_BP for $GIT_REPO — updating (autoSync on, path=render.yaml)."
  curl -sS -m 30 -X PATCH "$RENDER_API/blueprints/$EXISTING_BP" \
    -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
    -d "{\"autoSync\":true,\"path\":\"render.yaml\"}" >/dev/null
  ok "Blueprint synced on push. Watching services (may take a few minutes for sync+deploys)…"
  USE_API_CREATE=0
else
  warn "No Blueprint instance exists yet. Render's public API cannot *create* Blueprint instances"
  warn "(only validate/list/update) — so the script now creates the three services directly"
  warn "via the Render API with the exact same configuration as render.yaml. To switch to a"
  warn "managed Blueprint instead, open: https://dashboard.render.com/blueprints/new"
  USE_API_CREATE=1
fi

SERVICE_NAMES=(edunova-api edunova-signal edunova-ai)
declare -A SERVICE_IDS SERVICE_URLS SERVICE_DEPLOYS

find_service_id() { # $1=name
  curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/services?name=$1&ownerId=$RENDER_OWNER_ID" \
    | jq -r '.[0].id // empty' 2>/dev/null
}

create_service() { # $1=name  $2=json-body-file
  local name="$1" body="$2" resp code
  resp="$(curl -sS -m 60 -w '\n%{http_code}' -X POST "$RENDER_API/services" \
    -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
    --data-binary "@$body")"
  code="$(echo "$resp" | tail -1)"
  body_resp="$(echo "$resp" | head -n -1)"
  if [ "$code" = "201" ]; then
    echo "$body_resp" | jq -r '.service.id // empty'
  elif [ "$code" = "409" ]; then
    warn "Service '$name' already exists (409) — reusing it."
    find_service_id "$name"
  else
    warn "Service '$name' create failed (HTTP $code): $(echo "$body_resp" | jq -r '.message // .' | head -c 300)"
    echo ""
  fi
}

[ -n "${MONGO_URI:-}" ]   || warn "MONGO_URI is empty — services will start but the API can't reach MongoDB (fill it in $SECRETS_FILE or the Render Dashboard)."
[ -n "${JWT_SECRET:-}" ]   || warn "JWT_SECRET is empty — auth tokens will be signed with a weak/empty secret (fill it in $SECRETS_FILE)."

if [ "$USE_API_CREATE" = "1" ]; then
  # Build per-service payloads with jq (safe escaping of secrets & commands).
  API_ENV=$(jq -nc \
    --arg mongo "${MONGO_URI:-}" --arg jwt "${JWT_SECRET:-}" \
    --arg adminPw "${ADMIN_TEMP_PASSWORD:-}" --arg emailU "${EMAIL_USER:-}" \
    --arg emailP "${EMAIL_PASS:-}" --arg receiver "${CONTACT_RECEIVER_EMAIL:-}" \
    --arg seed "${SEED_DEMO_USERS:-true}" \
    '[{key:"MONGO_URI",value:$mongo},{key:"JWT_SECRET",value:$jwt},{key:"ADMIN_TEMP_PASSWORD",value:$adminPw},{key:"EMAIL_USER",value:$emailU},{key:"EMAIL_PASS",value:$emailP},{key:"CONTACT_RECEIVER_EMAIL",value:$receiver},{key:"SEED_DEMO_USERS",value:$seed}] | map(select(.value != ""))')

  jq -nc \
    --arg repo "$GIT_REPO" --arg branch "$GIT_BRANCH" --arg owner "$RENDER_OWNER_ID" \
    --arg plan "$RENDER_PLAN" --arg region "$RENDER_REGION" \
    --argjson env "$API_ENV" \
    '{type:"web_service",name:"edunova-api",ownerId:$owner,repo:$repo,branch:$branch,autoDeploy:"yes",
      rootDir:"server",envVars:$env,
      serviceDetails:{runtime:"node",plan:$plan,region:$region,numInstances:1,healthCheckPath:"/health",
        envSpecificDetails:{buildCommand:"npm install",startCommand:"node server.js"}}}' \
    > /tmp/edunova-api.json

  jq -nc \
    --arg repo "$GIT_REPO" --arg branch "$GIT_BRANCH" --arg owner "$RENDER_OWNER_ID" \
    --arg plan "$RENDER_PLAN" --arg region "$RENDER_REGION" \
    '{type:"web_service",name:"edunova-signal",ownerId:$owner,repo:$repo,branch:$branch,autoDeploy:"yes",
      rootDir:"signaling",envVars:[],
      serviceDetails:{runtime:"node",plan:$plan,region:$region,numInstances:1,healthCheckPath:"/health",
        envSpecificDetails:{buildCommand:"npm install",startCommand:"node index.js"}}}' \
    > /tmp/edunova-signal.json

  AI_ENV=$(jq -nc --arg mongo "${MONGO_URI:-}" \
    '[{key:"MONGO_URI",value:$mongo}] | map(select(.value != ""))')
  jq -nc \
    --arg repo "$GIT_REPO" --arg branch "$GIT_BRANCH" --arg owner "$RENDER_OWNER_ID" \
    --arg plan "$RENDER_PLAN" --arg region "$RENDER_REGION" --argjson env "$AI_ENV" \
    '{type:"web_service",name:"edunova-ai",ownerId:$owner,repo:$repo,branch:$branch,autoDeploy:"yes",
      rootDir:"ai_engine",envVars:$env,
      serviceDetails:{runtime:"python",plan:$plan,region:$region,numInstances:1,healthCheckPath:"/health",
        envSpecificDetails:{buildCommand:"pip install -r requirements.txt",
          startCommand:"uvicorn main:app --host 0.0.0.0 --port $PORT"}}}' \
    > /tmp/edunova-ai.json

  for name in "${SERVICE_NAMES[@]}"; do
    info "Creating/confirming service: $name"
    id="$(create_service "$name" "/tmp/edunova-$name.json")"
    if [ -n "$id" ]; then
      SERVICE_IDS[$name]="$id"
      ok "  $name -> $id"
    fi
  done

  # Wire AI_ENGINE_URL once edunova-ai has an address; then push all env vars.
  # (Services created via API have no env vars until we set them here.)
  AI_ID="${SERVICE_IDS[edunova-ai]:-}"
  if [ -n "$AI_ID" ]; then
    AI_SVC="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/services/$AI_ID")"
    AI_URL="$(echo "$AI_SVC" | jq -r '.serviceDetails.url // empty' 2>/dev/null)"
    if [ -n "$AI_URL" ]; then
      API_ID="${SERVICE_IDS[edunova-api]:-}"
      if [ -n "$API_ID" ]; then
        ENV_JSON="$(echo "$API_ENV" | jq -c --arg ai "$AI_URL" '. + [{key:"AI_ENGINE_URL",value:$ai}]')"
        curl -sS -m 30 -X PUT "$RENDER_API/services/$API_ID/env-vars" \
          -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
          -d "$ENV_JSON" >/dev/null && ok "Set env vars on edunova-api (incl. AI_ENGINE_URL=$AI_URL)"
        # env var changes need a redeploy to take effect
        curl -sS -m 30 -X POST "$RENDER_API/services/$API_ID/deploys" \
          -H "Authorization: Bearer $RENDER_API_KEY" >/dev/null 2>&1 \
          && info "Triggered redeploy of edunova-api (env var change)"
      fi
    fi
  fi
else
  # Blueprint mode: resolve ids of services managed by the blueprint
  for name in "${SERVICE_NAMES[@]}"; do
    SERVICE_IDS[$name]="$(find_service_id "$name")"
  done
fi

# Verify all three service ids exist
MISSING=0
for name in "${SERVICE_NAMES[@]}"; do
  if [ -z "${SERVICE_IDS[$name]:-}" ]; then
    warn "No service id resolved for '$name' — it may not have been created yet."
    MISSING=1
  fi
done
[ "$MISSING" = "0" ] || die "Not all three services exist yet. Fix the issues above and rerun (reruns are idempotent)."
ok "All three services exist: edunova-api, edunova-signal, edunova-ai"

# =============================================================================
# STAGE 3 — POLL UNTIL ALL SERVICES ARE LIVE
# =============================================================================
echo; echo "${C_BOLD}▶ Stage 3 — Polling Render until all services are LIVE${C_RESET}"
echo "  (timeout: ${POLL_TIMEOUT_MIN} min, check every ${POLL_INTERVAL_SEC}s; free tier cold start can take a while)"

is_service_live() { # $1=name → sets LIVE_HTTP, LIVE_DEPLOY, LIVE_INSTANCE, SERVICE_URL
  local id="${SERVICE_IDS[$1]}"
  LIVE_DEPLOY="no"; LIVE_INSTANCE="no"; LIVE_HTTP="no"; SERVICE_URL=""
  local svc deploys instances
  svc="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/services/$id")"
  SERVICE_URL="$(echo "$svc" | jq -r '.serviceDetails.url // empty' 2>/dev/null)"
  deploys="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/services/$id/deploys?limit=1")"
  [ "$(echo "$deploys" | jq -r '.[0].status // empty' 2>/dev/null)" = "live" ] && LIVE_DEPLOY="yes"
  instances="$(curl -sS -m 30 -H "Authorization: Bearer $RENDER_API_KEY" "$RENDER_API/services/$id/instances")"
  [ "$(echo "$instances" | jq -r '[.[].state] | index("live") != null' 2>/dev/null)" = "true" ] && LIVE_INSTANCE="yes"
  if [ -n "$SERVICE_URL" ]; then
    local body code
    body="$(curl -sS -m 15 -w '\n%{http_code}' "https://$SERVICE_URL/health" 2>/dev/null)"
    code="$(echo "$body" | tail -1)"
    if [ "$code" = "200" ] && echo "$body" | head -n -1 | grep -q '"live"'; then
      LIVE_HTTP="yes"
    fi
  fi
}

START_TS="$(date +%s)"
DEADLINE=$(( START_TS + POLL_TIMEOUT_MIN * 60 ))
ALL_LIVE=0
while :; do
  ALL_LIVE=1
  for name in "${SERVICE_NAMES[@]}"; do
    is_service_live "$name"
    SERVICE_URLS[$name]="$SERVICE_URL"
    status="deploy:${LIVE_DEPLOY} inst:${LIVE_INSTANCE} http:${LIVE_HTTP}"
    [ "$LIVE_HTTP" = "yes" ] && mark="$C_GREEN● LIVE$C_RESET" || mark="$C_YELLOW○ waiting$C_RESET"
    printf '   %-16s %-34s %s\n' "$name" "$status" "$mark"
    [ "$LIVE_HTTP" = "yes" ] || ALL_LIVE=0
  done
  [ "$ALL_LIVE" = "1" ] && break
  [ "$(date +%s)" -ge "$DEADLINE" ] && { warn "Timed out after ${POLL_TIMEOUT_MIN} min."; break; }
  sleep "$POLL_INTERVAL_SEC"
done

[ "$ALL_LIVE" = "1" ] || die "Services did not all reach LIVE. Check dashboard: https://dashboard.render.com"
ok "All services LIVE:"
for name in "${SERVICE_NAMES[@]}"; do
  printf '   %-16s https://%s/health\n' "$name" "${SERVICE_URLS[$name]}"
done

API_URL="${SERVICE_URLS[edunova-api]}"
SIGNAL_URL="${SERVICE_URLS[edunova-signal]}"
[ -n "$API_URL" ] && [ -n "$SIGNAL_URL" ] || die "Missing service URLs."

# =============================================================================
# STAGE 4 — UPDATE FRONTEND CONFIG WITH LIVE URLs (+ TURN)
# =============================================================================
echo; echo "${C_BOLD}▶ Stage 4 — Updating frontend config with live URLs${C_RESET}"

VITE_API_URL="https://$API_URL/api"
VITE_SIGNAL_URL="https://$SIGNAL_URL"

# Only add TURN vars if real values were provided (STUN fallback otherwise).
TURN_VARS='{}'
if [ -n "${VITE_TURN_URL:-}" ]; then
  TURN_VARS="$(jq -nc --arg u "${VITE_TURN_URL}" --arg n "${VITE_TURN_USERNAME:-}" --arg c "${VITE_TURN_CREDENTIAL:-}" \
    '{VITE_TURN_URL:$u,VITE_TURN_USERNAME:$n,VITE_TURN_CREDENTIAL:$c}')"
  ok "TURN server configured (4G/mobile video relay): $VITE_TURN_URL"
else
  warn "VITE_TURN_URL is empty — video will use STUN only. Set TURN vars in $SECRETS_FILE for reliable mobile/4G calls."
fi

# 4a. frontend/vercel.json — env block gets live URLs
jq -nc --arg api "$VITE_API_URL" --arg sig "$VITE_SIGNAL_URL" --argjson turn "$TURN_VARS" \
  '{framework:"vite",buildCommand:"npm run build",outputDirectory:"dist",
    env: ({VITE_API_URL:$api,VITE_SIGNAL_URL:$sig,VITE_API_PORT:"4000",VITE_SIGNAL_PORT:"5000"} + $turn),
    rewrites:[{source:"/((?!assets/|.*\\..*).*)",destination:"/index.html"}]}' \
  > "$FRONTEND_DIR/vercel.json" || die "Failed to rewrite frontend/vercel.json"
ok "frontend/vercel.json updated with live URLs"

# 4b. frontend/.env.production (used by the local build; gitignored)
{
  echo "VITE_API_URL=$VITE_API_URL"
  echo "VITE_SIGNAL_URL=$VITE_SIGNAL_URL"
  echo "VITE_API_PORT=4000"
  echo "VITE_SIGNAL_PORT=5000"
  if [ -n "${VITE_TURN_URL:-}" ]; then
    echo "VITE_TURN_URL=$VITE_TURN_URL"
    echo "VITE_TURN_USERNAME=${VITE_TURN_USERNAME:-}"
    echo "VITE_TURN_CREDENTIAL=${VITE_TURN_CREDENTIAL:-}"
  fi
  [ -n "${VITE_ICE_SERVERS_JSON:-}" ] && echo "VITE_ICE_SERVERS_JSON=${VITE_ICE_SERVERS_JSON}"
} > "$FRONTEND_DIR/.env.production"
ok "frontend/.env.production written"

# 4c. frontend/.env (tracked convenience copy)
{
  echo "# Auto-updated by scripts/deploy/master-deploy.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "VITE_API_URL=$VITE_API_URL"
  echo "VITE_SIGNAL_URL=$VITE_SIGNAL_URL"
  echo "VITE_API_PORT=4000"
  echo "VITE_SIGNAL_PORT=5000"
  if [ -n "${VITE_TURN_URL:-}" ]; then
    echo "VITE_TURN_URL=$VITE_TURN_URL"
    echo "VITE_TURN_USERNAME=${VITE_TURN_USERNAME:-}"
    echo "VITE_TURN_CREDENTIAL=${VITE_TURN_CREDENTIAL:-}"
  fi
} > "$FRONTEND_DIR/.env"
ok "frontend/.env updated"

# =============================================================================
# STAGE 5 — DEPLOY FRONTEND TO VERCEL (vercel --prod)
# =============================================================================
echo; echo "${C_BOLD}▶ Stage 5 — Deploying frontend to Vercel${C_RESET}"
[ "$SKIP_VERCEL" = "1" ] && { warn "Skipping Vercel deploy (--skip-vercel)."; exit 0; }

need npx
if command -v vercel >/dev/null 2>&1; then
  VERCEL_CMD="vercel"
else
  VERCEL_CMD="npx --yes vercel"
fi

# Ensure the project is linked
if [ ! -d "$FRONTEND_DIR/.vercel" ]; then
  info "Linking $FRONTEND_DIR to Vercel project '$VERCEL_PROJECT'…"
  $VERCEL_CMD link --yes --project "$VERCEL_PROJECT" --cwd "$FRONTEND_DIR" --token "$VERCEL_TOKEN" \
    >/dev/null 2>&1 || warn "vercel link failed (project may not exist yet — first deploy will create it)."
fi

# Push env vars to the Vercel project (production) — non-interactive via stdin.
for pair in "VITE_API_URL=$VITE_API_URL" "VITE_SIGNAL_URL=$VITE_SIGNAL_URL" \
            "VITE_API_PORT=4000" "VITE_SIGNAL_PORT=5000" \
            "${VITE_TURN_URL:+VITE_TURN_URL=$VITE_TURN_URL}" \
            "${VITE_TURN_USERNAME:+VITE_TURN_USERNAME=$VITE_TURN_USERNAME}" \
            "${VITE_TURN_CREDENTIAL:+VITE_TURN_CREDENTIAL=$VITE_TURN_CREDENTIAL}"; do
  [ -z "$pair" ] && continue
  key="${pair%%=*}"; value="${pair#*=}"
  printf '%s' "$value" | $VERCEL_CMD env add "$key" production --cwd "$FRONTEND_DIR" --token "$VERCEL_TOKEN" >/dev/null 2>&1 \
    && ok "vercel env $key (production)" || warn "vercel env add $key failed (will still work via vercel.json env)"
done

info "Running: $VERCEL_CMD --prod --yes --cwd $FRONTEND_DIR"
DEPLOY_OUT="$($VERCEL_CMD --prod --yes --cwd "$FRONTEND_DIR" --token "$VERCEL_TOKEN" 2>&1)"
DEPLOY_URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -1)"
echo "$DEPLOY_OUT" | tail -6
[ -n "$DEPLOY_URL" ] || { warn "Could not extract deploy URL from output (deploy may still have succeeded)."; }

# =============================================================================
# SUMMARY
# =============================================================================
echo; echo "${C_BOLD}╔══════════════════════════════════════════════════════════════════════╗"
echo "║                      DEPLOYMENT COMPLETE — SUMMARY                     ║"
echo "╚══════════════════════════════════════════════════════════════════════╝${C_RESET}"
printf '  %-28s %s\n' "Frontend (Vercel):" "${DEPLOY_URL:-see Vercel dashboard}"
printf '  %-28s https://%s/health\n' "API (Render):" "$API_URL"
printf '  %-28s https://%s/health\n' "Signaling (Render):" "$SIGNAL_URL"
printf '  %-28s https://%s/health\n' "AI engine (Render):" "${SERVICE_URLS[edunova-ai]}"
echo
echo "  Next steps:"
echo "   - Verify: curl https://$API_URL/health"
echo "   - Set real TURN credentials in scripts/deploy/.env.secrets and rerun for mobile video."
echo "   - Optional: create a managed Blueprint at https://dashboard.render.com/blueprints/new"
echo
