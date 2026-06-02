import type { CityGridSpecCompact } from "@/lib/live/grid/cityGrid500";
import {
  cellIdForPosition,
  cellLabel,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import {
  bearingDegrees,
  metersBetween,
  projectPoint,
  type LatLng,
} from "@/lib/live/routing/geometry";

export type OverlayElementLayout = {
  xPct: number;
  yPct: number;
  scale: number;
  opacity: number;
  visible: boolean;
  distanceM?: number;
  label?: string;
};

const HORIZ_MAX_DEG = 60;

/** Normalize bearing delta to [-180, 180] then clamp to screen FOV. */
export function relativeAngleDeg(
  bearingToTarget: number,
  driverHeading: number,
): number {
  let rel = bearingToTarget - driverHeading;
  while (rel > 180) rel -= 360;
  while (rel < -180) rel += 360;
  return Math.max(-HORIZ_MAX_DEG, Math.min(HORIZ_MAX_DEG, rel));
}

/** Map relative angle to horizontal screen position (50 = center). */
export function horizontalPositionPct(relativeAngleDeg: number): number {
  return 50 + (relativeAngleDeg / HORIZ_MAX_DEG) * 40;
}

function lerpPiecewise(
  distanceM: number,
  breakpoints: ReadonlyArray<readonly [number, number]>,
): number {
  if (distanceM >= breakpoints[0]![0]) return breakpoints[0]![1];
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [d0, v0] = breakpoints[i]!;
    const [d1, v1] = breakpoints[i + 1]!;
    if (distanceM >= d1) {
      const span = d0 - d1;
      if (span <= 0) return v1;
      const t = (distanceM - d1) / span;
      return v1 + t * (v0 - v1);
    }
  }
  return breakpoints[breakpoints.length - 1]![1];
}

const PIN_Y = [
  [200, 20],
  [100, 30],
  [50, 45],
  [20, 60],
  [0, 65],
] as const;

const PIN_SCALE = [
  [200, 0.45],
  [150, 0.55],
  [100, 0.72],
  [50, 1.0],
  [20, 1.35],
  [0, 1.6],
] as const;

const ZONE_Y = [
  [150, 18],
  [100, 28],
  [50, 42],
  [20, 58],
  [0, 68],
] as const;

const ZONE_SCALE = [
  [150, 0.4],
  [100, 0.62],
  [50, 0.9],
  [20, 1.25],
  [0, 1.55],
] as const;

export function pinOverlayLayout(
  distanceM: number,
  relativeAngle: number,
): OverlayElementLayout {
  if (distanceM < 10) {
    const opacity = Math.max(0, distanceM / 10);
    return {
      xPct: horizontalPositionPct(relativeAngle),
      yPct: lerpPiecewise(distanceM, PIN_Y),
      scale: lerpPiecewise(distanceM, PIN_SCALE),
      opacity,
      visible: opacity > 0.04,
      distanceM,
    };
  }

  return {
    xPct: horizontalPositionPct(relativeAngle),
    yPct: lerpPiecewise(distanceM, PIN_Y),
    scale: lerpPiecewise(distanceM, PIN_SCALE),
    opacity: 1,
    visible: true,
    distanceM,
  };
}

export function zoneGateOverlayLayout(
  distanceM: number,
  relativeAngle: number,
): OverlayElementLayout {
  if (distanceM > 150) {
    return {
      xPct: 50,
      yPct: 18,
      scale: 0.35,
      opacity: 0,
      visible: false,
      distanceM,
    };
  }

  if (distanceM < 5) {
    const opacity = Math.max(0, distanceM / 5);
    return {
      xPct: horizontalPositionPct(relativeAngle),
      yPct: lerpPiecewise(distanceM, ZONE_Y),
      scale: lerpPiecewise(distanceM, ZONE_SCALE),
      opacity,
      visible: opacity > 0.04,
      distanceM,
    };
  }

  return {
    xPct: horizontalPositionPct(relativeAngle),
    yPct: lerpPiecewise(distanceM, ZONE_Y),
    scale: lerpPiecewise(distanceM, ZONE_SCALE),
    opacity: 1,
    visible: true,
    distanceM,
  };
}

/** Closest point on the current grid cell border (for bearing / perspective). */
export function nearestCellEdgePoint(
  spec: CityGridSpecCompact,
  lat: number,
  lng: number,
): LatLng & { distanceM: number } | null {
  const col = Math.floor((lng - spec.swLng) / spec.dLng);
  const row = Math.floor((lat - spec.swLat) / spec.dLat);
  if (col < 0 || col >= spec.nCols || row < 0 || row >= spec.nRows) return null;

  const southLat = spec.swLat + row * spec.dLat;
  const northLat = southLat + spec.dLat;
  const westLng = spec.swLng + col * spec.dLng;
  const eastLng = westLng + spec.dLng;

  const cos = Math.max(0.12, Math.cos((lat * Math.PI) / 180));
  const candidates: Array<LatLng & { distanceM: number }> = [
    { lat, lng: westLng, distanceM: Math.abs(lng - westLng) * 111_320 * cos },
    { lat, lng: eastLng, distanceM: Math.abs(eastLng - lng) * 111_320 * cos },
    { lat: southLat, lng, distanceM: Math.abs(lat - southLat) * 111_320 },
    { lat: northLat, lng, distanceM: Math.abs(northLat - lat) * 111_320 },
  ];

  return candidates.reduce((best, c) =>
    c.distanceM < best.distanceM ? c : best,
  );
}

/** Label for the zone ahead when approaching a cell border. */
export function nextZoneEnterLabel(
  spec: CityGridSpecCompact,
  driver: LatLng,
  headingDeg: number,
  fallbackLabel?: string | null,
): string {
  const ahead = projectPoint(driver, headingDeg, 80);
  const currentId = cellIdForPosition(spec, driver.lat, driver.lng);
  const aheadId = cellIdForPosition(spec, ahead.lat, ahead.lng);
  if (aheadId && aheadId !== currentId) {
    const p = parseGridOptionId(aheadId);
    if (p) return cellLabel(p.row, p.col);
  }
  return (
    fallbackLabel?.trim() ||
    spec.cityLabel?.trim() ||
    "ZONE"
  ).toUpperCase();
}

export function computePinOverlay(
  driver: LatLng & { heading?: number },
  pin: LatLng,
  distanceM: number,
): OverlayElementLayout {
  const heading = driver.heading ?? bearingDegrees(driver, pin);
  const bearing = bearingDegrees(driver, pin);
  const rel = relativeAngleDeg(bearing, heading);
  return pinOverlayLayout(distanceM, rel);
}

export function computeZoneGateOverlay(
  driver: LatLng & { heading?: number },
  spec: CityGridSpecCompact,
  fallbackLabel?: string | null,
): (OverlayElementLayout & { enterLabel: string }) | null {
  const edge = nearestCellEdgePoint(spec, driver.lat, driver.lng);
  if (!edge || edge.distanceM > 150) return null;

  const heading = driver.heading ?? 0;
  const bearing = bearingDegrees(driver, edge);
  const rel = relativeAngleDeg(bearing, heading);
  const layout = zoneGateOverlayLayout(edge.distanceM, rel);
  if (!layout.visible) return null;

  return {
    ...layout,
    enterLabel: nextZoneEnterLabel(spec, driver, heading, fallbackLabel),
  };
}

export { metersBetween };
