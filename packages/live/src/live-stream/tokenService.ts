import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * V1 WebRTC token: a signed JWT-lite we control end-to-end without adding
 * a full SFU dependency yet. Later this can be swapped for LiveKit / Agora /
 * mediasoup-issued tokens. The API surface is stable.
 */
export type BroadcasterToken = {
  sessionId: string;
  characterId: string;
  role: "broadcaster";
  expiresAt: number;
  token: string;
};

export type ViewerToken = {
  sessionId: string;
  role: "viewer";
  expiresAt: number;
  token: string;
};

const DEFAULT_TTL_SEC = 60 * 60;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function issueBroadcasterToken(
  secret: string,
  sessionId: string,
  characterId: string,
  ttlSec = DEFAULT_TTL_SEC,
): BroadcasterToken {
  const expiresAt = Date.now() + ttlSec * 1000;
  const nonce = randomBytes(16).toString("hex");
  const payload = `broadcaster.${sessionId}.${characterId}.${expiresAt}.${nonce}`;
  const token = `${payload}.${sign(secret, payload)}`;
  return { sessionId, characterId, role: "broadcaster", expiresAt, token };
}

export function issueViewerToken(
  secret: string,
  sessionId: string,
  ttlSec = DEFAULT_TTL_SEC,
): ViewerToken {
  const expiresAt = Date.now() + ttlSec * 1000;
  const nonce = randomBytes(16).toString("hex");
  const payload = `viewer.${sessionId}.${expiresAt}.${nonce}`;
  const token = `${payload}.${sign(secret, payload)}`;
  return { sessionId, role: "viewer", expiresAt, token };
}

export function verifyToken(secret: string, token: string): boolean {
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = sign(secret, payload);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
