#!/usr/bin/env bash
# =============================================================================
# EduNova_X — LOCAL PRODUCTION SMOKE TEST (PHASE 13)
# -----------------------------------------------------------------------------
# Fail-closed verification of all three backend services + frontend build.
# Any failing check returns a non-zero exit code. Nothing is "hidden" — every
# check prints [OK]/[FAIL] and failures are summarized at the end.
#
# Checks:
#   1. Node.js >= 20
#   2. Required env vars PRESENT (values NEVER printed)
#   3. Frontend production build (vite build) — optional, --build
#   4. API server  : GET /health, /api/test, /
#   5. Signaling   : GET /health, /, and Socket.IO Engine.IO handshake
#   6. AI engine   : GET /health
#
# Usage:
#   ./verify-production.sh                 # defaults: API 4000, SIGNAL 5000, AI 8001
#   ./verify-production.sh --build         # also run the frontend build
#   ./verify-production.sh --skip-ai       # consciously skip the AI check
#   API_PORT=4100 SIGNAL_PORT=5100 AI_PORT=8100 ./verify-production.sh
#
# Prereqs: node >= 20, npm, curl, and dependencies installed in each service
# (npm install) — the script reports missing deps instead of guessing.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_PORT="${API_PORT:-4000}"
SIGNAL_PORT="${SIGNAL_PORT:-5000}"
AI_PORT="${AI_PORT:-8001}"
DO_BUILD=0
SKIP_AI=0
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    --skip-ai) SKIP_AI=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '%s[ OK ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  sleep 0.3
  for pid in "${PIDS[@]:-}"; do kill -9 "$pid" 2>/dev/null; done
}
trap cleanup EXIT

echo "============================================================"
echo " EduNova_X — LOCAL PRODUCTION SMOKE TEST"
echo "============================================================"

# --- 1. Node version ----------------------------------------------------------
echo; echo "▶ 1. Node.js version check"
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/')"
if [ -z "$NODE_MAJOR" ]; then bad "node not found on PATH"; exit 1; fi
if [ "$NODE_MAJOR" -ge 20 ]; then ok "Node $(node -v) (>= 20)"; else bad "Node $(node -v) < 20 — deployment target requires Node 20+"; fi

# --- 2. Environment variable presence (values masked) -------------------------
echo; echo "▶ 2. Required env vars (PRESENT/MISSING only — values never shown)"
# server/.env keys
if [ -f "$REPO_ROOT/server/.env" ]; then
  while IFS='=' read -r k _v; do
    case "$k" in ""|\#*) continue ;; esac
    case "$k" in PORT|AI_ENGINE_URL) continue ;; esac
    if [ -n "$_v" ]; then ok "server/.env $k = PRESENT"; else warn "server/.env $k = MISSING (empty)"; fi
  done < "$REPO_ROOT/server/.env"
else
  bad "server/.env not found (needed for MONGO_URI / JWT_SECRET locally)"
fi
# frontend/.env keys
if [ -f "$REPO_ROOT/frontend/.env" ]; then
  while IFS='=' read -r k _v; do
    case "$k" in ""|\#*) continue ;; esac
    [ -n "$_v" ] && ok "frontend/.env $k = PRESENT" || warn "frontend/.env $k = MISSING (empty)"
  done < "$REPO_ROOT/frontend/.env"
else
  warn "frontend/.env not found (dev defaults apply; production URLs must be set at deploy time)"
fi

# --- 3. Frontend build (optional) ---------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
  echo; echo "▶ 3. Frontend production build"
  if [ ! -d "$REPO_ROOT/frontend/node_modules" ]; then
    bad "frontend/node_modules missing — run: cd frontend && npm install"
  else
    ( cd "$REPO_ROOT/frontend" && npm run build >/tmp/edunova-vite-build.log 2>&1 )
    if [ $? -eq 0 ]; then ok "vite build succeeded (dist/)"; else bad "vite build FAILED — see /tmp/edunova-vite-build.log"; fi
  fi
fi

# --- 4. Start services --------------------------------------------------------
echo; echo "▶ Starting services on ports $API_PORT (API), $SIGNAL_PORT (signaling), $AI_PORT (AI)"
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$API_PORT" "$SIGNAL_PORT" "$AI_PORT"; do
  if ! port_free "$p"; then bad "port $p already in use — stop the existing process or override with *_PORT env"; fi
done
[ "$FAIL" -gt 0 ] && { echo; echo "BLOCKED — fix the failures above."; exit 1; }

# API server
if [ ! -d "$REPO_ROOT/server/node_modules" ]; then
  bad "server/node_modules missing — run: cd server && npm install"
else
  ( cd "$REPO_ROOT/server" && PORT="$API_PORT" exec node server.js >/tmp/edunova-api.log 2>&1 ) &
  PIDS+=($!)  # exec → $! is the node process itself, cleanup actually kills it
fi
# Signaling
if [ ! -d "$REPO_ROOT/signaling/node_modules" ]; then
  bad "signaling/node_modules missing — run: cd signaling && npm install"
else
  ( cd "$REPO_ROOT/signaling" && PORT="$SIGNAL_PORT" exec node index.js >/tmp/edunova-signal.log 2>&1 ) &
  PIDS+=($!)  # exec → $! is the node process itself
fi
# AI engine
if [ "$SKIP_AI" = "1" ]; then
  warn "AI engine check SKIPPED (--skip-ai)"
elif ! command -v uvicorn >/dev/null 2>&1 && ! python3 -c "import uvicorn" >/dev/null 2>&1; then
  bad "AI engine prereqs missing — uvicorn is not installed. Run: pip install -r ai_engine/requirements.txt (or pass --skip-ai to consciously skip)"
else
  AI_UVICORN="$(command -v uvicorn 2>/dev/null || echo python3 -m uvicorn)"
  ( cd "$REPO_ROOT/ai_engine" && exec $AI_UVICORN main:app --host 127.0.0.1 --port "$AI_PORT" >/tmp/edunova-ai.log 2>&1 ) &
  PIDS+=($!)  # exec → $! is the server process itself
fi

# Wait for ports to come up (max 30s)
wait_port() { # $1=port $2=name
  local i
  for i in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then exec 3>&-; exec 3<&-; return 0; fi
    sleep 1
  done
  bad "$2 did not start on port $1 within 30s — see /tmp/edunova-*.log"
  return 1
}
API_UP=0; SIGNAL_UP=0; AI_UP=0
wait_port "$API_PORT" "API server" && API_UP=1
wait_port "$SIGNAL_PORT" "signaling server" && SIGNAL_UP=1
[ "$SKIP_AI" = "1" ] && AI_UP=1
[ "$SKIP_AI" = "0" ] && wait_port "$AI_PORT" "AI engine" && AI_UP=1

# --- 5. HTTP checks -----------------------------------------------------------
echo; echo "▶ 5. HTTP checks (expect 200)"
http_check() { # $1=label $2=url $3=optional-body-match
  local code body
  body="$(curl -sS -m 10 -w '\n%{http_code}' "$2" 2>/dev/null)"; code="$(echo "$body" | tail -1)"
  if [ "$code" = "200" ]; then
    if [ -n "${3:-}" ] && ! echo "$body" | head -n -1 | grep -q "$3"; then
      bad "$1 → HTTP 200 but body missing '$3'"
    else
      ok "$1 → HTTP $code"
    fi
  else
    bad "$1 → HTTP ${code:-no response}"
  fi
}
[ "$API_UP" = "1" ] && {
  http_check "API  GET /health"    "http://127.0.0.1:$API_PORT/health"    '"edunova-x-production"'
  http_check "API  GET /api/test"  "http://127.0.0.1:$API_PORT/api/test"
  http_check "API  GET / (root)"   "http://127.0.0.1:$API_PORT/"
}
[ "$SIGNAL_UP" = "1" ] && {
  http_check "SIG  GET /health"    "http://127.0.0.1:$SIGNAL_PORT/health"  '"edunova-x-production"'
  http_check "SIG  GET / (root)"   "http://127.0.0.1:$SIGNAL_PORT/"
  # Socket.IO Engine.IO handshake — proves Socket.IO is actually running
  sio="$(curl -sS -m 10 -w '\n%{http_code}' "http://127.0.0.1:$SIGNAL_PORT/socket.io/?EIO=4&transport=polling" -H "Origin: https://edunova-x.vercel.app" 2>/dev/null)"
  code="$(echo "$sio" | tail -1)"
  if [ "$code" = "200" ] && echo "$sio" | head -n -1 | grep -q '^0{'; then
    ok "SIG  Socket.IO handshake → HTTP $code (Engine.IO OK)"
  else
    bad "SIG  Socket.IO handshake → HTTP ${code:-no response} (expected Engine.IO 0{...})"
  fi
}
[ "$AI_UP" = "1" ] && {
  http_check "AI   GET /health"    "http://127.0.0.1:$AI_PORT/health"       '"edunova-x-production"'
}

echo
if [ "$FAIL" -gt 0 ]; then
  echo "============================================================"
  printf '%s[%s]%s LOCAL SMOKE TEST FAILED — %s check(s) failed (passed: %s). Fix and rerun.\n' "$C_RED" "FAIL" "$C_RESET" "$FAIL" "$PASS"
  echo "  Logs: /tmp/edunova-api.log, /tmp/edunova-signal.log, /tmp/edunova-ai.log"
  echo "============================================================"
  exit 1
fi
echo "============================================================"
printf '%s[%s]%s LOCAL SMOKE TEST PASSED — %s checks OK, zero 404s.\n' "$C_GREEN" "PASS" "$C_RESET" "$PASS"
echo "============================================================"
exit 0
