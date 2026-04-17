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

echo "==> Starting local coturn TURN server (WebRTC relay)"
bash "$ROOT_DIR/scripts/coturn.sh" || echo "    coturn start failed (continuing without local TURN)"

detect_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    local ip
    ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -z "${ip}" ]; then ip=$(ipconfig getifaddr en1 2>/dev/null || true); fi
    if [ -n "${ip}" ]; then echo "$ip"; return; fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}
LOCAL_IP=$(detect_ip)

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
NEXT_PUBLIC_TURN_URL=turn:${LOCAL_IP}:3478
NEXT_PUBLIC_TURN_USERNAME=camtok
NEXT_PUBLIC_TURN_CREDENTIAL=camtok
EOF
  echo "    wrote apps/web/.env.local"
else
  echo "==> Ensuring TURN env vars are set in apps/web/.env.local"
  if ! grep -q '^NEXT_PUBLIC_TURN_URL=' apps/web/.env.local; then
    {
      echo "NEXT_PUBLIC_TURN_URL=turn:${LOCAL_IP}:3478"
      echo "NEXT_PUBLIC_TURN_USERNAME=camtok"
      echo "NEXT_PUBLIC_TURN_CREDENTIAL=camtok"
    } >> apps/web/.env.local
    echo "    appended TURN vars (URL=turn:${LOCAL_IP}:3478)"
  fi
fi

echo "==> Starting Next.js dev server on http://localhost:3000"
exec pnpm --filter @bettok/web dev
