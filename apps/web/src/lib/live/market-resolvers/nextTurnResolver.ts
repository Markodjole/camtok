import { RouteState, type RouteDecisionOption } from "@bettok/live";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

/**
 * Resolve a `next_turn` market.
 *
 * Reads GPS snapshots from `opens_at` onward and uses heading-delta
 * analysis to determine whether the driver turned left, right, or went
 * straight through the pin. Returns a refund when GPS is insufficient or
 * the movement is ambiguous.
 */
export async function nextTurnResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const opts = market.option_set;

  const { data: snaps } = await service
    .from("live_route_snapshots")
    .select(
      "recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
    )
    .eq("live_session_id", market.live_session_id)
    .gte("recorded_at", market.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(120);

  const points = (snaps ?? []).map((r) => {
    const lat = (r.normalized_lat ?? r.raw_lat) as number;
    const lng = (r.normalized_lng ?? r.raw_lng) as number;
    return {
      recordedAt: r.recorded_at as string,
      lat,
      lng,
      speedMps: (r.speed_mps as number | null) ?? undefined,
      headingDeg: (r.heading_deg as number | null) ?? undefined,
      normalizedLat: lat,
      normalizedLng: lng,
      confidence: (r.confidence_score as number | null) ?? 0.5,
      discarded: false,
    };
  });

  // Build a synthetic decision node so `revealFromMovement` has direction
  // labels to match. `next_turn` markets don't have a `route_decision_nodes`
  // row because they are gated on pin distance, not the decision detector.
  const syntheticDecision: { options: RouteDecisionOption[] } = {
    options: opts.map((o) => ({
      optionId: o.id,
      label: o.label,
      directionType: o.id as RouteDecisionOption["directionType"],
    })),
  };

  const result = RouteState.revealFromMovement(opts, syntheticDecision, points);

  if (result.status !== "matched") {
    return { outcome: "refund", reason: result.reason };
  }
  return { outcome: "win", optionId: result.winningOptionId, reason: result.reason };
}
