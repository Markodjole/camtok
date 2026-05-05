import type { UserBetSnapshotV2 } from "@bettok/live";
import { metersBetween } from "@/lib/live/routing/geometry";

/** Server-only snapshot at click time — never accept client-supplied baselines. */
export function buildServerClickSnapshot(params: {
  lat: number;
  lng: number;
  headingDeg?: number | null;
  speedMps?: number | null;
  confidenceScore?: number | null;
  turnPoint?: { lat: number; lng: number } | null;
  nextPinId?: string | null;
  routeVersion?: string | null;
}): UserBetSnapshotV2 {
  const betPlacedAt = new Date().toISOString();
  let distanceToPinMeters: number | undefined;
  if (params.turnPoint) {
    distanceToPinMeters = metersBetween(
      { lat: params.lat, lng: params.lng },
      params.turnPoint,
    );
  }
  return {
    betPlacedAt,
    driverPosition: { lat: params.lat, lng: params.lng },
    driverHeading:
      params.headingDeg != null && Number.isFinite(params.headingDeg)
        ? params.headingDeg
        : undefined,
    driverSpeedMps:
      params.speedMps != null && Number.isFinite(params.speedMps)
        ? params.speedMps
        : undefined,
    mapConfidence:
      params.confidenceScore != null && Number.isFinite(params.confidenceScore)
        ? params.confidenceScore
        : undefined,
    distanceToPinMeters,
    nextPinId: params.nextPinId ?? undefined,
    routeVersion: params.routeVersion ?? undefined,
  };
}
