import { RouteState, type RouteDecisionOption } from "@bettok/live";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

/**
 * Legacy resolution path for markets backed by a `route_decision_nodes` row.
 *
 * This path is not triggered by the automated cron tick (which only opens
 * the three active types: next_turn, city_grid, zone_exit_time). It exists
 * as a safety net for any market rows created via `openSystemMarketForRoom`
 * that may still be in the database.
 */
export async function legacyDecisionNodeResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const revealAtMs = new Date(market.reveal_at).getTime();
  const since = new Date(revealAtMs - 15_000).toISOString();

  const { data: points } = await service
    .from("live_route_snapshots")
    .select(
      "recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
    )
    .eq("live_session_id", market.live_session_id)
    .gte("recorded_at", since)
    .order("recorded_at", { ascending: true });

  const committed = (points ?? []).map((r) => {
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

  const { data: decision } = await service
    .from("route_decision_nodes")
    .select("options")
    .eq("id", market.decision_node_id ?? "")
    .maybeSingle();

  const opts = market.option_set;
  const decisionOptions =
    (decision as { options: RouteDecisionOption[] } | null)?.options ?? [];

  const result = RouteState.revealFromMovement(
    opts,
    decisionOptions.length ? { options: decisionOptions } : null,
    committed,
  );

  if (result.status !== "matched") {
    return { outcome: "refund", reason: result.reason };
  }
  return { outcome: "win", optionId: result.winningOptionId, reason: result.reason };
}
