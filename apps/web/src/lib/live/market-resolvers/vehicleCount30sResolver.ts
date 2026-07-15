import type { VehicleCount30sSubtitle } from "@/actions/live-vehicle-count-market";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

function parseSubtitle(subtitle: string | null): VehicleCount30sSubtitle | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as Partial<VehicleCount30sSubtitle>;
    if (typeof meta.roundId === "string") {
      return meta as VehicleCount30sSubtitle;
    }
  } catch {
    // ignore
  }
  return null;
}

function winningOptionId(count: number): string {
  if (count < 2) return "count_under_2";
  if (count <= 4) return "count_2_to_4";
  return "count_over_4";
}

/**
 * Resolve vehicle_count_30s from the final round count in lead_vehicle_events / state.
 */
export async function vehicleCount30sResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const meta = parseSubtitle(market.subtitle);
  if (!meta) {
    return { outcome: "refund", reason: "vehicle_count_missing_subtitle" };
  }

  const locksAt = new Date(market.locks_at).getTime();
  const countDeadline = locksAt + meta.countWindowMs;

  const { data: state } = await service
    .from("character_lead_vehicle_state")
    .select("count_round_id, count_round_count, count_round_final")
    .eq("live_session_id", market.live_session_id)
    .maybeSingle();

  let finalCount: number | null = null;

  if (
    state &&
    (state as { count_round_id?: string | null }).count_round_id === meta.roundId
  ) {
    finalCount = (state as { count_round_count: number }).count_round_count ?? 0;
    if ((state as { count_round_final?: boolean }).count_round_final) {
      return {
        outcome: "win",
        optionId: winningOptionId(finalCount),
        reason: `vehicle_count_final_${finalCount}`,
      };
    }
  }

  const { data: events } = await service
    .from("lead_vehicle_events")
    .select("payload, client_timestamp_ms, recorded_at")
    .eq("live_session_id", market.live_session_id)
    .eq("event_type", "vehicle_count_round")
    .gte("recorded_at", market.locks_at)
    .order("recorded_at", { ascending: false })
    .limit(50);

  for (const row of events ?? []) {
    const payload = (row as { payload: Record<string, unknown> }).payload ?? {};
    if (payload.roundId !== meta.roundId) continue;
    if (typeof payload.roundCount === "number") {
      finalCount = payload.roundCount;
      break;
    }
  }

  if (finalCount == null) {
    if (Date.now() < countDeadline) {
      return { outcome: "refund", reason: "vehicle_count_still_counting" };
    }
    return { outcome: "refund", reason: "vehicle_count_no_telemetry" };
  }

  return {
    outcome: "win",
    optionId: winningOptionId(finalCount),
    reason: `vehicle_count_settled_${finalCount}`,
  };
}
