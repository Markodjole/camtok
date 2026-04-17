#!/usr/bin/env bash
# CamTok local dev bootstrap.
# Starts (or re-uses) local Supabase stack and the Next.js dev server.
# Mirrors the production layout: Supabase + Next.js — only swaps endpoints.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Checking Docker"
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop first." >&2
  exit 1
fi

echo "==> Ensuring local Supabase is up (project: camtok)"
if ! supabase status >/dev/null 2>&1; then
  supabase start
else
  echo "    already running"
fi

echo "==> Applying any pending migrations to local DB"
supabase migration up --local || true

if [ ! -f "apps/web/.env.local" ]; then
  echo "==> Writing apps/web/.env.local from local Supabase credentials"
  API_URL=$(supabase status -o json 2>/dev/null | jq -r '.API_URL' || echo "http://127.0.0.1:54331")
  ANON=$(supabase status -o json 2>/dev/null | jq -r '.ANON_KEY' || echo "")
  SERVICE=$(supabase status -o json 2>/dev/null | jq -r '.SERVICE_ROLE_KEY' || echo "")
  LIVE_SECRET=$(openssl rand -hex 32)
  cat > apps/web/.env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE}
NEXT_PUBLIC_APP_URL=http://localhost:3000
LIVE_STREAM_SECRET=${LIVE_SECRET}
EOF
  echo "    wrote apps/web/.env.local"
fi

echo "==> Starting Next.js dev server on http://localhost:3000"
exec pnpm --filter @bettok/web dev
