#!/usr/bin/env bash
# Usage report from a running Camtok deployment.
#   USAGE_REPORT_SECRET=xxx ./scripts/api-usage-report.sh
#   ./scripts/api-usage-report.sh https://camtok-web.vercel.app

set -euo pipefail
BASE="${1:-${NEXT_PUBLIC_APP_URL:-http://localhost:3000}}"
SECRET="${USAGE_REPORT_SECRET:-${CRON_SECRET:-}}"

if [[ -z "$SECRET" ]]; then
  echo "Set USAGE_REPORT_SECRET or CRON_SECRET" >&2
  exit 1
fi

curl -fsS \
  -H "Authorization: Bearer ${SECRET}" \
  "${BASE%/}/api/admin/api-usage" | jq .
