#!/usr/bin/env bash
# Starts a local coturn TURN/STUN server for CamTok WebRTC dev.
# This is required to reliably connect Chrome <-> Safari on localhost
# because Chrome's mDNS candidates often fail to resolve across browsers.
#
# Exposes TURN/STUN on UDP/TCP 3478 with static creds camtok:camtok.
# The local IP of this machine on the LAN is detected automatically so
# candidates are reachable from other devices on the network too.

set -euo pipefail

NAME="camtok_coturn"
USER_NAME="${TURN_USERNAME:-camtok}"
PASSWORD="${TURN_CREDENTIAL:-camtok}"
REALM="${TURN_REALM:-camtok.local}"

detect_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    local ip
    ip=$(ipconfig getifaddr en0 2>/dev/null || true)
    if [ -z "${ip}" ]; then ip=$(ipconfig getifaddr en1 2>/dev/null || true); fi
    if [ -n "${ip}" ]; then echo "$ip"; return; fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
}

EXT_IP=$(detect_ip)
echo "==> Using external IP: ${EXT_IP}"

if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "==> ${NAME} already running"
  exit 0
fi

docker rm -f "${NAME}" >/dev/null 2>&1 || true

echo "==> Starting ${NAME} (coturn) on :3478 (UDP/TCP)"
docker run -d --name "${NAME}" \
  -p 3478:3478 -p 3478:3478/udp \
  -p 49160-49200:49160-49200/udp \
  coturn/coturn:latest \
  -n \
  --log-file=stdout \
  --fingerprint \
  --lt-cred-mech \
  --realm="${REALM}" \
  --user="${USER_NAME}:${PASSWORD}" \
  --no-tls --no-dtls \
  --listening-port=3478 \
  --external-ip="${EXT_IP}" \
  --min-port=49160 --max-port=49200 \
  --no-multicast-peers >/dev/null

echo "==> coturn ready at turn:${EXT_IP}:3478 (user=${USER_NAME} pass=${PASSWORD})"
echo ""
echo "Add these to apps/web/.env.local (dev.sh does this automatically):"
echo "  NEXT_PUBLIC_TURN_URL=turn:${EXT_IP}:3478"
echo "  NEXT_PUBLIC_TURN_USERNAME=${USER_NAME}"
echo "  NEXT_PUBLIC_TURN_CREDENTIAL=${PASSWORD}"
