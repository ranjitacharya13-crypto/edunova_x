#!/usr/bin/env bash
# EduNova_X — Secret Extractor (bash wrapper around extract-secrets.mjs)
# Pulls MONGO_URI / JWT_SECRET / email creds / TURN vars from the local .env
# files and formats them for Render Blueprint + Vercel injection.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/extract-secrets.mjs"
