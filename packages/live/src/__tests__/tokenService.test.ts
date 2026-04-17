import { describe, expect, it } from "vitest";
import {
  issueBroadcasterToken,
  issueViewerToken,
  verifyToken,
} from "../live-stream/tokenService";

const SECRET = "test-secret";

describe("tokenService", () => {
  it("issues a verifiable broadcaster token", () => {
    const t = issueBroadcasterToken(SECRET, "sess-1", "char-1");
    expect(verifyToken(SECRET, t.token)).toBe(true);
  });

  it("rejects tampered token", () => {
    const t = issueBroadcasterToken(SECRET, "sess-1", "char-1");
    const parts = t.token.split(".");
    parts[1] = "tampered-session";
    expect(verifyToken(SECRET, parts.join("."))).toBe(false);
  });

  it("rejects wrong secret", () => {
    const t = issueViewerToken(SECRET, "sess-1");
    expect(verifyToken("other-secret", t.token)).toBe(false);
  });
});
