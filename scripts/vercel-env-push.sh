#!/usr/bin/env bash
# Push CamTok production env vars to Vercel.
# Requirements:
#   - `vercel login` completed once on this machine
#   - `vercel link` completed inside apps/web (already done in this repo)
# Usage:
#   ./scripts/vercel-env-push.sh            # push all vars in environment.txt
#   ./scripts/vercel-env-push.sh LIVE_STREAM_SECRET   # push only one key
#
# Notes:
#   - Vars are pushed to production, preview, and development scopes.
#   - Existing values of the same name are removed first (vercel env rm)
#     to avoid duplicate scope entries.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/apps/web"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI not found. Install with: pnpm add -g vercel" >&2
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "Not logged in to Vercel. Run:   vercel login" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/apps/web/.vercel/project.json" ]; then
  echo "apps/web not linked to a Vercel project. Run:" >&2
  echo "   cd apps/web && vercel link" >&2
  exit 1
fi

ENV_FILE="$ROOT_DIR/apps/web/environment.txt"
if [ ! -f "$ENV_FILE" ]; then
  echo "environment.txt not found at $ENV_FILE" >&2
  exit 1
fi

FILTER="${1:-}"

set_var() {
  local key="$1"
  local val="$2"
  for scope in production preview development; do
    vercel env rm "$key" "$scope" --yes >/dev/null 2>&1 || true
    printf "%s" "$val" | vercel env add "$key" "$scope" >/dev/null
    echo "   [$scope] $key"
  done
}

while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"

    if [[ "$val" == "<"*">"  ]]; then
      echo "   skip $key (placeholder value)"
      continue
    fi

    if [ -n "$FILTER" ] && [ "$key" != "$FILTER" ]; then
      continue
    fi

    echo "==> $key"
    set_var "$key" "$val"
  fi
done < "$ENV_FILE"

echo "==> Done. Trigger a redeploy:   vercel --prod"
