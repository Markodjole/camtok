import type { RoutePoint } from "@/actions/live-feed";

export type GuidanceKind = "straight" | "left" | "right" | "back" | "brake";

export function computeStreamGuidance(points: RoutePoint[]): {
  kind: GuidanceKind;
  label: string;
  /** 0 = north, clockwise, for icon rotation in Leaflet/ CSS */
  rotationDeg: number;
} {
  if (points.length < 2) {
    return { kind: "straight", label: "GO", rotationDeg: 0 };
  }
  const last = points[points.length - 1]!;
  const speed = last.speedMps;
  if (speed != null && speed < 0.35) {
    return { kind: "brake", label: "BRAKE", rotationDeg: last.heading ?? 0 };
  }

  if (points.length >= 3) {
    const a = points[points.length - 3]!;
    const b = points[points.length - 2]!;
    const c = last;
    const b1 = bearing(a.lat, a.lng, b.lat, b.lng);
    const b2 = bearing(b.lat, b.lng, c.lat, c.lng);
    let d = b2 - b1;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (Math.abs(d) < 18) {
      return { kind: "straight", label: "STRAIGHT", rotationDeg: last.heading ?? b2 };
    }
    if (d < -18) {
      return { kind: "left", label: "TURN LEFT", rotationDeg: last.heading ?? b2 };
    }
    return { kind: "right", label: "TURN RIGHT", rotationDeg: last.heading ?? b2 };
  }
  if (last.heading != null) {
    return { kind: "straight", label: "GO", rotationDeg: last.heading };
  }
  return { kind: "straight", label: "GO", rotationDeg: 0 };
}

function bearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
