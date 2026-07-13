import type { Overtake30sSubtitle } from "@/actions/live-overtake-market";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

function parseSubtitle(subtitle: string | null): Overtake30sSubtitle | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as Partial<Overtake30sSubtitle>;
    if (typeof meta.trackId === "string" && typeof meta.windowMs === "number") {
      return meta as Overtake30sSubtitle;
    }
  } catch {
    // ignore
  }
  return null;
}

const APPROACHING = new Set([
  "approaching",
  "slowing_or_rider_approaching",
]);

/**
 * Resolve overtake_30s from lead_vehicle_events after market open.
 *
 * yes  → lead track lost within window after an approaching-like state
 * no   → window elapsed without that pattern (still ahead / moved away)
 * refund → missing telemetry
 */
export async function overtake30sResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const meta = parseSubtitle(market.subtitle);
  if (!meta) {
    return { outcome: "refund", reason: "overtake_missing_subtitle" };
  }

  const opensAt = new Date(market.opens_at).getTime();
  const deadline = opensAt + meta.windowMs;

  const { data: events } = await service
    .from("lead_vehicle_events")
    .select("event_type, track_id, relative_state, recorded_at, client_timestamp_ms")
    .eq("live_session_id", market.live_session_id)
    .gte("recorded_at", market.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(200);

  if (!events || events.length === 0) {
    return { outcome: "refund", reason: "overtake_no_events" };
  }

  let sawApproaching = meta.relativeState
    ? APPROACHING.has(meta.relativeState)
    : false;
  let lostWithinWindow = false;

  for (const row of events as Array<{
    event_type: string;
    track_id: string | null;
    relative_state: string | null;
    recorded_at: string;
    client_timestamp_ms: number | null;
  }>) {
    const ts = row.client_timestamp_ms ?? new Date(row.recorded_at).getTime();
    if (row.track_id && row.track_id !== meta.trackId) continue;
    if (row.relative_state && APPROACHING.has(row.relative_state)) {
      sawApproaching = true;
    }
    if (
      row.event_type === "lead_vehicle_lost" &&
      ts <= deadline &&
      (!row.track_id || row.track_id === meta.trackId)
    ) {
      lostWithinWindow = true;
      break;
    }
  }

  if (lostWithinWindow && sawApproaching) {
    return {
      outcome: "win",
      optionId: "overtake_yes",
      reason: "overtake_lead_lost_while_approaching",
    };
  }

  if (lostWithinWindow && !sawApproaching) {
    return {
      outcome: "win",
      optionId: "overtake_no",
      reason: "lead_lost_without_approach",
    };
  }

  // Deadline passed without overtake signal.
  if (Date.now() >= deadline) {
    return {
      outcome: "win",
      optionId: "overtake_no",
      reason: "overtake_window_elapsed",
    };
  }

  return { outcome: "refund", reason: "overtake_still_pending" };
}
