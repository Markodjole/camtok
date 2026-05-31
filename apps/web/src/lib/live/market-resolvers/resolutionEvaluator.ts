/**
 * Resolution condition evaluator.
 *
 * This module is the runtime counterpart of `resolutionPolicies.ts`.
 *
 * `evaluateResolutionConditions` walks the ordered conditions registered for
 * a market type and returns the first one that fires — or "no match" when none
 * do yet.  The sweep in `runRoomTick.ts` calls this once per tick per locked
 * market and settles the market as soon as the result says so.
 *
 * # Adding a new event type
 * 1. Add the type to `ResolutionEvent` in `resolutionPolicies.ts`.
 * 2. Add a `case` in `evaluateEvent` below.
 * 3. The evaluator picks it up automatically.
 *
 * All condition checks are read-only (SELECT only).  DB writes are the
 * responsibility of the caller (`revealAndSettleMarket`).
 */

import { metersBetween } from "@/lib/live/routing/geometry";
import {
  getResolutionPolicy,
  type ResolutionEvent,
  type HeadingChangeEvent,
  type IntersectionsPassedEvent,
  type RouteDeviationEvent,
  type TurnPinProximityEvent,
} from "@/lib/live/betting/resolutionPolicies";
import {
  cellIdForPosition,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import type { CityGridSpecCompact } from "@/lib/live/grid/cityGrid500";
import type { CrossroadBearing } from "@/lib/live/routing/straightStreakAnalyzer";
import {
  countStraightStreakProgress,
  hasCommittedTurn,
  type GpsSample,
} from "@/lib/live/routing/straightStreakPassage";
import {
  isDriverOffRouteToPin,
  type CompactLatLng,
} from "@/lib/live/routing/nextStepRoutePath";
import type { ServiceClient } from "./types";

// ─── Input type ────────────────────────────────────────────────────────────

/**
 * Minimal slice of a `live_betting_markets` row that the evaluator needs.
 * Constructed in the sweep from the locked-market SELECT result.
 */
export type MarketSweepRow = {
  id: string;
  market_type: string;
  live_session_id: string | null;
  opens_at: string;
  reveal_at: string;
  subtitle: string | null;
  turn_point_lat: number | null;
  turn_point_lng: number | null;
  city_grid_spec: CityGridSpecCompact | null;
};

// ─── Public API ────────────────────────────────────────────────────────────

export type EvaluationResult =
  | { shouldSettle: true; firedLabel: string; action: "settle" | "refund" }
  | { shouldSettle: false; firedLabel: null; action: null };

/**
 * Walk the resolution policy for `row.market_type` and return the first
 * condition that fires, or `shouldSettle: false` when none do.
 *
 * Unknown market types (no registered policy) fall back to a
 * `reveal_timeout`-only check so they eventually settle.
 *
 * @param service  Supabase service client (read-only usage here)
 * @param row      Sweep-time snapshot of the locked market row
 * @param nowMs    `Date.now()` captured once at the start of the tick sweep
 */
export async function evaluateResolutionConditions(
  service: ServiceClient,
  row: MarketSweepRow,
  nowMs: number,
): Promise<EvaluationResult> {
  const policy = getResolutionPolicy(row.market_type);

  const conditions = policy?.conditions ?? [
    { label: "reveal_timeout", event: { type: "reveal_timeout" as const } },
  ];

  for (const condition of conditions) {
    const fired = await evaluateEvent(service, row, condition.event, nowMs);
    if (fired) {
      const action = condition.event.type === "route_deviation" ? "refund" : "settle";
      return { shouldSettle: true, firedLabel: condition.label, action };
    }
  }

  return { shouldSettle: false, firedLabel: null, action: null };
}

// ─── Event dispatcher ─────────────────────────────────────────────────────

async function evaluateEvent(
  service: ServiceClient,
  row: MarketSweepRow,
  event: ResolutionEvent,
  nowMs: number,
): Promise<boolean> {
  switch (event.type) {
    case "reveal_timeout":
      return checkRevealTimeout(row, nowMs);

    case "heading_change":
      return checkHeadingChange(service, row, event);

    case "intersections_passed":
      return checkIntersectionsPassed(service, row, event);

    case "cell_crossed":
      return checkCellCrossed(service, row);

    case "route_deviation":
      return checkRouteDeviation(service, row, event);

    case "turn_pin_proximity":
      return checkTurnPinProximity(service, row, event);
  }
}

// ─── Individual condition implementations ─────────────────────────────────

/**
 * reveal_timeout — fires once `reveal_at` has passed.
 * Cheapest check; no DB query required.
 */
function checkRevealTimeout(row: MarketSweepRow, nowMs: number): boolean {
  const revealAtMs = new Date(row.reveal_at).getTime();
  return Number.isFinite(revealAtMs) && nowMs >= revealAtMs;
}

/**
 * heading_change — fires when the absolute heading delta between the first
 * and last GPS snapshot since `opens_at` reaches `thresholdDeg`.
 *
 * Requires ≥ 4 raw points (noise rejection) and ≥ 2 with valid heading.
 */
async function checkHeadingChange(
  service: ServiceClient,
  row: MarketSweepRow,
  event: HeadingChangeEvent,
): Promise<boolean> {
  if (!row.live_session_id) return false;

  const { data: points } = await service
    .from("live_route_snapshots")
    .select("heading_deg")
    .eq("live_session_id", row.live_session_id)
    .gte("recorded_at", row.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(120);

  if (!points || points.length < 4) return false;

  const headings = (points as Array<{ heading_deg: number | null }>)
    .map((p) => p.heading_deg)
    .filter((h): h is number => h != null);

  if (headings.length < 2) return false;

  const first = headings[0]!;
  const last = headings[headings.length - 1]!;
  return Math.abs(angleDelta(first, last)) >= event.thresholdDeg;
}

/**
 * intersections_passed — settles when the driver completes the expected number
 * of consecutive straight passages, or takes a turn at any reached junction.
 */
async function checkIntersectionsPassed(
  service: ServiceClient,
  row: MarketSweepRow,
  event: IntersectionsPassedEvent,
): Promise<boolean> {
  if (!row.live_session_id || !row.subtitle) return false;

  let intersections: CrossroadBearing[];
  let expectedStreak: number | null = null;
  try {
    const meta = JSON.parse(row.subtitle) as { intersections?: unknown; expectedStreak?: unknown };
    if (!Array.isArray(meta.intersections) || meta.intersections.length === 0) return false;
    intersections = meta.intersections as CrossroadBearing[];
    if (typeof meta.expectedStreak === "number" && meta.expectedStreak > 0) {
      expectedStreak = meta.expectedStreak;
    }
  } catch {
    return false;
  }

  const effectiveCount = expectedStreak ?? event.count;

  const { data: snaps } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng, heading_deg")
    .eq("live_session_id", row.live_session_id)
    .gte("recorded_at", row.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(300);

  if (!snaps || snaps.length === 0) return false;

  const gps: GpsSample[] = (snaps as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  }>).map((p) => ({
    lat: p.normalized_lat ?? p.raw_lat,
    lng: p.normalized_lng ?? p.raw_lng,
    heading: p.heading_deg,
  }));

  if (hasCommittedTurn(gps)) return true;

  const progress = countStraightStreakProgress(gps, intersections, effectiveCount);
  return progress.ended && (progress.endedReason === "complete" || progress.endedReason === "turn");
}

/**
 * cell_crossed — fires when the driver's latest GPS position is in a
 * different grid cell than the one stored in the market subtitle.
 */
async function checkCellCrossed(
  service: ServiceClient,
  row: MarketSweepRow,
): Promise<boolean> {
  const { city_grid_spec: gridSpec, live_session_id: sessionId } = row;
  if (!gridSpec || !sessionId) return false;

  let startRow: number | null = null;
  let startCol: number | null = null;
  try {
    const meta = JSON.parse(row.subtitle ?? "{}") as {
      startRow?: number;
      startCol?: number;
    };
    if (typeof meta.startRow === "number") startRow = meta.startRow;
    if (typeof meta.startCol === "number") startCol = meta.startCol;
  } catch {
    // ignore
  }
  if (startRow == null || startCol == null) return false;

  const { data: latest } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) return false;

  const g = latest as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };

  const currentCell = cellIdForPosition(
    gridSpec,
    g.normalized_lat ?? g.raw_lat,
    g.normalized_lng ?? g.raw_lng,
  );
  if (!currentCell) return false;

  return currentCell !== `grid:r${startRow}:c${startCol}`;
}

/**
 * route_deviation — fires when the driver's latest position is farther than
 * `maxOffRouteM` from the stored driver→pin polyline and they have not yet
 * entered the pin approach zone.
 */
async function checkRouteDeviation(
  service: ServiceClient,
  row: MarketSweepRow,
  event: RouteDeviationEvent,
): Promise<boolean> {
  if (row.market_type !== "next_step" || !row.live_session_id) return false;

  let routeToPin: CompactLatLng[] | null = null;
  let stepLat = row.turn_point_lat;
  let stepLng = row.turn_point_lng;
  try {
    const meta = JSON.parse(row.subtitle ?? "{}") as {
      routeToPin?: CompactLatLng[];
      stepLat?: number;
      stepLng?: number;
    };
    if (Array.isArray(meta.routeToPin) && meta.routeToPin.length >= 2) {
      routeToPin = meta.routeToPin;
    }
    if (typeof meta.stepLat === "number") stepLat = meta.stepLat;
    if (typeof meta.stepLng === "number") stepLng = meta.stepLng;
  } catch {
    return false;
  }
  if (!routeToPin) {
    const { data: first } = await service
      .from("live_route_snapshots")
      .select("normalized_lat, normalized_lng, raw_lat, raw_lng")
      .eq("live_session_id", row.live_session_id)
      .gte("recorded_at", row.opens_at)
      .order("recorded_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (first && stepLat != null && stepLng != null) {
      const g0 = first as {
        normalized_lat: number | null;
        normalized_lng: number | null;
        raw_lat: number;
        raw_lng: number;
      };
      routeToPin = [
        { lat: g0.normalized_lat ?? g0.raw_lat, lng: g0.normalized_lng ?? g0.raw_lng },
        { lat: stepLat, lng: stepLng },
      ];
    } else {
      return false;
    }
  }

  const { data: latest } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng")
    .eq("live_session_id", row.live_session_id)
    .gte("recorded_at", row.opens_at)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) return false;

  const g = latest as {
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
  };
  const driver = {
    lat: g.normalized_lat ?? g.raw_lat,
    lng: g.normalized_lng ?? g.raw_lng,
  };
  const pin =
    stepLat != null && stepLng != null ? { lat: stepLat, lng: stepLng } : null;

  return isDriverOffRouteToPin(driver, routeToPin, pin, event.maxOffRouteM);
}

/**
 * turn_pin_proximity — fires when:
 *   (a) heading fallback: overall heading change ≥ `headingFallbackDeg`, OR
 *   (b) proximity crossing: driver came within `approachRadiusM` of the pin
 *       AND the latest GPS point is ≥ `departureM` further than the closest.
 *
 * Both sub-checks share a single GPS fetch.
 */
async function checkTurnPinProximity(
  service: ServiceClient,
  row: MarketSweepRow,
  event: TurnPinProximityEvent,
): Promise<boolean> {
  if (!row.live_session_id) return false;
  const { turn_point_lat: turnLat, turn_point_lng: turnLng } = row;
  if (turnLat == null || turnLng == null) return false;

  const { data: points } = await service
    .from("live_route_snapshots")
    .select("normalized_lat, normalized_lng, raw_lat, raw_lng, heading_deg")
    .eq("live_session_id", row.live_session_id)
    .gte("recorded_at", row.opens_at)
    .order("recorded_at", { ascending: true })
    .limit(120);

  if (!points || points.length < 2) return false;

  const samples = (points as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  }>).map((p) => ({
    lat: p.normalized_lat ?? p.raw_lat,
    lng: p.normalized_lng ?? p.raw_lng,
    heading: p.heading_deg,
  }));

  // (a) Heading fallback — catches early turns before the pin is reached.
  const firstHeading = samples.find((p) => p.heading != null)?.heading ?? null;
  const lastHeading = [...samples].reverse().find((p) => p.heading != null)?.heading ?? null;
  if (
    firstHeading != null &&
    lastHeading != null &&
    Math.abs(angleDelta(firstHeading, lastHeading)) >= event.headingFallbackDeg
  ) {
    return true;
  }

  // (b) Proximity crossing — driver approached and then departed past the pin.
  const distances = samples.map((p) =>
    metersBetween({ lat: p.lat, lng: p.lng }, { lat: turnLat, lng: turnLng }),
  );
  const minDistance = Math.min(...distances);
  const latestDistance = distances[distances.length - 1] ?? Number.POSITIVE_INFINITY;

  return (
    minDistance <= event.approachRadiusM &&
    latestDistance >= minDistance + event.departureM
  );
}

// ─── Shared math ──────────────────────────────────────────────────────────

function angleDelta(fromDeg: number, toDeg: number): number {
  let d = toDeg - fromDeg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
