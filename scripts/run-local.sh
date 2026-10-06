#!/usr/bin/env bash
# Runs the dev server with Stripe sandbox credentials loaded from a private env file (never printed).
# Usage: scripts/run-local.sh [env-file]   default: ~/ops/env/connectors/stripe-sandbox.env
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${1:-$HOME/ops/env/connectors/stripe-sandbox.env}"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
# `stripe listen` forwards events signed with its own secret.
export STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET_LISTEN:-${STRIPE_WEBHOOK_SECRET:-}}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT:-8787}}"
export APP_SECRET="${APP_SECRET:-$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | head -c 48)}"
exec pnpm exec tsx scripts/dev.ts
