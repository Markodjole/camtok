import type { LocationPoint } from "../schemas";
import type { TransportMode } from "../types";

const MAX_ACCELERATION_MPS2: Record<TransportMode, number> = {
  walking: 2,
  bike: 3,
  scooter: 3.5,
  car: 6,
  other_vehicle: 6,
};

const MAX_SPEED_MPS: Record<TransportMode, number> = {
  walking: 3.5,
  bike: 12,
  scooter: 12,
  car: 45,
  other_vehicle: 45,
};

const MAX_ACCURACY_METERS = 60;

export type NormalizedPoint = LocationPoint & {
  normalizedLat: number;
  normalizedLng: number;
  confidence: number;
  discarded: boolean;
  discardReason?: string;
};

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const la1 = toRad(aLat);
  const la2 = toRad(bLat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(aLat);
  const φ2 = toRad(bLat);
  const λ1 = toRad(aLng);
  const λ2 = toRad(bLng);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Smooth a batch of GPS points using an exponential moving average and
 * sanity-check each point against transport-mode kinematics. Returns one
 * NormalizedPoint per input, with `discarded=true` for implausible points.
 */
export function normalizeGpsBatch(
  prior: NormalizedPoint | null,
  transportMode: TransportMode,
  points: LocationPoint[],
): NormalizedPoint[] {
  const alpha = 0.4;
  const out: NormalizedPoint[] = [];
  let last: NormalizedPoint | null = prior;

  const sorted = [...points].sort((a, b) =>
    a.recordedAt.localeCompare(b.recordedAt),
  );

  for (const p of sorted) {
    const acc = p.accuracyMeters ?? 20;
    if (acc > MAX_ACCURACY_METERS) {
      out.push({
        ...p,
        normalizedLat: p.lat,
        normalizedLng: p.lng,
        confidence: 0,
        discarded: true,
        discardReason: "low_accuracy",
      });
      continue;
    }

    let normalizedLat = p.lat;
    let normalizedLng = p.lng;
    let confidence = Math.max(0, 1 - acc / MAX_ACCURACY_METERS);
    let discarded = false;
    let discardReason: string | undefined;

    if (last) {
      const dtSec = Math.max(
        0.1,
        (new Date(p.recordedAt).getTime() - new Date(last.recordedAt).getTime()) / 1000,
      );
      const meters = haversineMeters(
        last.normalizedLat,
        last.normalizedLng,
        p.lat,
        p.lng,
      );
      const impliedSpeed = meters / dtSec;
      const impliedAccel = Math.abs(impliedSpeed - (last.speedMps ?? 0)) / dtSec;

      if (
        impliedSpeed > MAX_SPEED_MPS[transportMode] * 1.5 ||
        impliedAccel > MAX_ACCELERATION_MPS2[transportMode] * 2
      ) {
        discarded = true;
        discardReason = "implausible_kinematics";
        confidence = 0;
      } else {
        normalizedLat = last.normalizedLat * (1 - alpha) + p.lat * alpha;
        normalizedLng = last.normalizedLng * (1 - alpha) + p.lng * alpha;
      }
    }

    const heading =
      p.headingDeg ??
      (last
        ? bearingDeg(last.normalizedLat, last.normalizedLng, normalizedLat, normalizedLng)
        : undefined);

    const np: NormalizedPoint = {
      ...p,
      headingDeg: heading,
      normalizedLat,
      normalizedLng,
      confidence,
      discarded,
      discardReason,
    };
    out.push(np);
    if (!discarded) last = np;
  }

  return out;
}
