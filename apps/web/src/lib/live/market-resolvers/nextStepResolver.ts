import { metersBetween } from "@/lib/live/routing/geometry";
import { NEXT_STEP_APPROACH_M } from "@/lib/live/betting/betWindowConstants";
import type { MarketForResolution, MarketResolution, ServiceClient } from "./types";

// ─── Subtitle parsing ─────────────────────────────────────────────────────────

type NextStepMeta = {
  stepLat: number;
  stepLng: number;
  estimatedSec: number;
};

function parseNextStepMeta(subtitle: string | null): NextStepMeta | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as {
      stepLat?: unknown;
      stepLng?: unknown;
      estimatedSec?: unknown;
    };
    if (
      typeof meta.stepLat === "number" &&
      typeof meta.stepLng === "number" &&
      typeof meta.estimatedSec === "number"
    ) {
      return {
        stepLat: meta.stepLat,
        stepLng: meta.stepLng,
        estimatedSec: meta.estimatedSec,
      };
    }
  } catch {
    // malformed subtitle
  }
  return null;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve a `next_step` market.
 *
 * Scans GPS snapshots since `opens_at` for the first point that falls within
 * NEXT_STEP_APPROACH_M of the OSRM step maneuver location stored in the
 * market subtitle.  The timestamp of that GPS point is the driver's arrival
 * time; elapsed seconds from `opens_at` are compared to the Google-projected
 * ETA (`estimatedSec`) with a ±20% tolerance band.
 *
 * Refunds if no GPS snapshot was close enough to the step maneuver point,
 * which means the driver either deviated or the route was recalculated.
 *
 * ±20 % tolerance
 * ───────────────
 * GPS polling at ~1 Hz means the arrival timestamp can be up to ~1 s off,
 * and at highway speeds (30 m/s) that translates to a ~30 m positional error.
 * The 20% band avoids mis-scoring the boundary between under/at/over due to
 * this inherent measurement jitter.
 */
export async function nextStepResolver(
  market: MarketForResolution,
  service: ServiceClient,
): Promise<MarketResolution> {
  const meta = parseNextStepMeta(market.subtitle);
  if (!meta) {
    return { outcome: "refund", reason: "next_step_missing_subtitle" };
  }

  const { stepLat, stepLng, estimatedSec } = meta;

  // ── Load GPS snapshots since market open ────────────────────────────────────
  const { data: snaps } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", market.live_session_id)
    .gte("recorded_at", market.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(300);

  if (!snaps || snaps.length === 0) {
    return { outcome: "refund", reason: "next_step_no_gps" };
  }

  // ── Find the first GPS point within approach radius of the step ─────────────
  let arrivalMs: number | null = null;

  for (const p of snaps as Array<{
    recorded_at: string;
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  }>) {
    const lat = p.normalized_lat ?? p.raw_lat;
    const lng = p.normalized_lng ?? p.raw_lng;
    const dist = metersBetween({ lat, lng }, { lat: stepLat, lng: stepLng });
    if (dist <= NEXT_STEP_APPROACH_M) {
      arrivalMs = new Date(p.recorded_at).getTime();
      break;
    }
  }

  if (!arrivalMs) {
    // Driver never came close enough — route deviation or data gap.
    return { outcome: "refund", reason: "next_step_not_reached" };
  }

  // ── Classify elapsed time vs ETA ────────────────────────────────────────────
  const opensAtMs = new Date(market.opens_at).getTime();
  const elapsedSec = Number.isFinite(opensAtMs)
    ? Math.max(0, (arrivalMs - opensAtMs) / 1000)
    : Number.POSITIVE_INFINITY;

  const lo = estimatedSec * 0.8;
  const hi = estimatedSec * 1.2;
  const optionId =
    elapsedSec < lo ? "step_under" : elapsedSec <= hi ? "step_at" : "step_over";

  const reason = `next_step_${Math.round(elapsedSec)}s_est${estimatedSec}s`;

  console.log(`[nextStepResolver] ${optionId}`, {
    marketId: market.id,
    elapsedSec,
    estimatedSec,
    lo,
    hi,
    reason,
  });

  return { outcome: "win", optionId, reason };
}
