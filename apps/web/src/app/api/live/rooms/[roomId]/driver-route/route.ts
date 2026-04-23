import { NextRequest, NextResponse } from "next/server";
import { getLiveRoomDetail } from "@/actions/live-feed";
import {
  buildCheckpointInstruction,
  type ActiveCheckpointInstruction,
  type TurnKind,
} from "@/lib/live/routing/checkpointInstruction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CacheEntry = {
  bucketKey: string;
  expiresAtMs: number;
  instruction: ActiveCheckpointInstruction | null;
};

// Module-scoped cache so concurrent viewers of the same room share one OSRM
// call per ~15 m position bucket. Keyed by `${marketId}`; value holds the
// current bucket + payload + expiry.
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 12_000;

function positionBucket(lat: number, lng: number): string {
  // ~15 m lat / ~12 m lng at 45° — fine-grained enough to trigger a refresh
  // as the driver closes in, coarse enough to share calls across viewers.
  return `${lat.toFixed(4)}|${lng.toFixed(4)}`;
}

function inferTurnKind(
  label: string | undefined,
  shortLabel: string | undefined,
): TurnKind {
  const s = `${label ?? ""} ${shortLabel ?? ""}`.toLowerCase();
  if (s.includes("u-turn") || s.includes("u turn") || s.includes("back")) return "u-turn";
  if (s.includes("left")) return "left";
  if (s.includes("right")) return "right";
  return "straight";
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await ctx.params;
  const res = await getLiveRoomDetail(roomId);
  const room = res.room;
  if (!room) {
    return NextResponse.json({ instruction: null, reason: "no_room" });
  }

  const mkt = room.currentMarket;
  if (!mkt || mkt.turnPointLat == null || mkt.turnPointLng == null) {
    return NextResponse.json({ instruction: null, reason: "no_market_turn" });
  }

  const last = room.routePoints[room.routePoints.length - 1];
  if (!last) {
    return NextResponse.json({ instruction: null, reason: "no_position" });
  }

  // AI pick: take the first option in display order. This is the branch the
  // map path will highlight. (Viewers still bet on any option; this is purely
  // the visual guidance choice for the driver.)
  const firstOption = [...(mkt.options ?? [])].sort(
    (a, b) => a.displayOrder - b.displayOrder,
  )[0];
  const turnKind: TurnKind = firstOption
    ? inferTurnKind(firstOption.label, firstOption.shortLabel)
    : "straight";

  const position = { lat: last.lat, lng: last.lng };
  const turnPoint = { lat: mkt.turnPointLat, lng: mkt.turnPointLng };
  const bucket = positionBucket(position.lat, position.lng);

  const cached = CACHE.get(mkt.id);
  const nowMs = Date.now();
  if (
    cached &&
    cached.bucketKey === bucket &&
    cached.expiresAtMs > nowMs &&
    cached.instruction?.decisionId === mkt.id
  ) {
    return NextResponse.json({ instruction: cached.instruction });
  }

  const instruction = await buildCheckpointInstruction({
    decisionId: mkt.id,
    position,
    headingDeg: last.heading ?? null,
    turnPoint,
    turnKind,
    lockAt: mkt.locksAt,
    expiresAt: mkt.revealAt,
    offsetMeters: 50,
  });

  CACHE.set(mkt.id, {
    bucketKey: bucket,
    expiresAtMs: nowMs + CACHE_TTL_MS,
    instruction,
  });

  // Opportunistic sweep — avoid unbounded cache growth across long sessions.
  if (CACHE.size > 128) {
    for (const [key, entry] of CACHE.entries()) {
      if (entry.expiresAtMs < nowMs) CACHE.delete(key);
    }
  }

  return NextResponse.json({ instruction });
}
