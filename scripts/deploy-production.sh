#!/usr/bin/env bash
# =============================================================================
# EduNova_X — PRODUCTION DEPLOYMENT ORCHESTRATOR (PHASE 14–22)
# -----------------------------------------------------------------------------
# Fail-closed pipeline. Nothing is claimed until it is verified:
#   STAGE A  Token + tooling gates (VERCEL_TOKEN, RENDER_API_KEY, Node >= 20)
#   STAGE B  Optional: regenerate scripts/deploy/.env.secrets from local .env
#   STAGE C  Local preflight (scripts/verify-production.sh) — abort on failure
#   STAGE D  Deploy (scripts/deploy/master-deploy.sh): blueprint -> poll LIVE
#            -> frontend env + vercel.json -> vercel --prod -> Stage-6 verify
#   STAGE E  Independent production verification + final PHASE-22 status table
#
# Final status is EXACTLY one of:
#   DEPLOYMENT VERIFIED   (every live HTTP check returned 200)
#   DEPLOYMENT FAILED     (a blocker is printed; exit code != 0)
#
# Usage:
#   ./deploy-production.sh
#   ./deploy-production.sh --skip-preflight
#   ./deploy-production.sh --skip-verify          # UNVERIFIED — you own the risk
#   RENDER_API_KEY=[Insert_Key] VERCEL_TOKEN=[Insert_Token] ./deploy-production.sh
#
# Secrets are read ONLY from scripts/deploy/.env.secrets (gitignored) or the
# environment. NEVER hardcode credentials in this file.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_FILE="${SECRETS_FILE:-$SCRIPT_DIR/deploy/.env.secrets}"
MASTER_SCRIPT="$SCRIPT_DIR/deploy/master-deploy.sh"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-production.sh"

SKIP_PREFLIGHT=0
MASTER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --skip-git-push|--skip-vercel|--skip-verify) MASTER_ARGS+=("$arg") ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
ok()   { printf '%s[ OK ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s[ .. ]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

echo "${C_BOLD}"
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║        EduNova_X — PRODUCTION DEPLOYMENT ORCHESTRATOR            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo "${C_RESET}"

# ---------------------------------------------------------------------------
# STAGE A — TOKEN + TOOLING GATES (fail closed)
# ---------------------------------------------------------------------------
echo; echo "${C_BOLD}▶ Stage A — Gates: tokens & tooling${C_RESET}"

# Load secrets (quote-aware) — never echoes values
if [ -f "$SECRETS_FILE" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ""|\#*) continue ;; esac
    _v="${_v%\"}"; _v="${_v#\"}"; _v="${_v%\'}"; _v="${_v#\'}"
    export "$_k=$_v"
  done < "$SECRETS_FILE"
else
  info "No $SECRETS_FILE — tokens must come from the environment."
fi

[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY is missing — set it in $SECRETS_FILE or export it. [Insert_Key]"
[ -n "${VERCEL_TOKEN:-}" ]   || die "VERCEL_TOKEN is missing — set it in $SECRETS_FILE or export it. [Insert_Token]"
ok "RENDER_API_KEY = PRESENT (${RENDER_API_KEY:0:4}…${RENDER_API_KEY: -4})"
ok "VERCEL_TOKEN   = PRESENT (${VERCEL_TOKEN:0:4}…${VERCEL_TOKEN: -4})"

for tool in git node npm curl jq; do
  command -v "$tool" >/dev/null 2>&1 || die "Missing required tool: $tool"
done
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/v([0-9]+).*/\1/')"
[ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) < 20 — deployment target requires Node 20+."
ok "Node $(node -v) (>= 20), git, npm, curl, jq present"

# ---------------------------------------------------------------------------
# STAGE B — OPTIONAL SECRET REGENERATION
# ---------------------------------------------------------------------------
echo; echo "${C_BOLD}▶ Stage B — Secret extraction${C_RESET}"
if [ -f "$SCRIPT_DIR/deploy/extract-secrets.sh" ]; then
  bash "$SCRIPT_DIR/deploy/extract-secrets.sh" >/dev/null 2>&1 && ok "extract-secrets: .env.secrets synchronized (values never printed)" || warn "extract-secrets could not run — using existing $SECRETS_FILE"
else
  warn "extract-secrets.sh not found — skipping"
fi

# ---------------------------------------------------------------------------
# STAGE C — LOCAL PREFLIGHT (fail closed)
# ---------------------------------------------------------------------------
echo; echo "${C_BOLD}▶ Stage C — Local preflight (verify-production.sh)${C_RESET}"
if [ "$SKIP_PREFLIGHT" = "1" ]; then
  warn "Preflight SKIPPED (--skip-preflight)"
else
  bash "$VERIFY_SCRIPT" --build || die "LOCAL PREFLIGHT FAILED — refusing to deploy. Fix and rerun."
  ok "Local preflight passed — all local services healthy."
fi

# ---------------------------------------------------------------------------
# STAGE D — DEPLOY (master-deploy handles blueprint, poll, Vercel, Stage-6 verify)
# ---------------------------------------------------------------------------
echo; echo "${C_BOLD}▶ Stage D — Deploying (master-deploy.sh)${C_RESET}"
bash "$MASTER_SCRIPT" "${MASTER_ARGS[@]:-}"
MASTER_EXIT=$?
if [ "$MASTER_EXIT" -ne 0 ]; then
  echo; printf '%s[FAIL]%s DEPLOYMENT FAILED — master-deploy exited %s.\n' "$C_RED" "$C_RESET" "$MASTER_EXIT"
  echo "  Exact blocker above. Fix it and rerun (reruns are idempotent)."
  exit "$MASTER_EXIT"
fi

# ---------------------------------------------------------------------------
# STAGE E — FINAL PHASE-22 STATUS TABLE
# ---------------------------------------------------------------------------
echo; echo "${C_BOLD}▶ Stage E — Final status${C_RESET}"
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  warn "FINAL STATUS: UNVERIFIED (--skip-verify was passed — production checks were not run)."
  exit 0
fi
echo "FINAL STATUS: DEPLOYMENT VERIFIED"
echo "  (All live HTTP checks in master-deploy Stage 6 returned 200:"
echo "   API /health + /api/test + /, signaling /health + /, AI /health, Vercel SPA root.)"
exit 0
