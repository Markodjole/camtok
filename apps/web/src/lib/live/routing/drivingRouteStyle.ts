/**
 * Driver route "persona" — stored on `characters.driving_route_style` (JSONB).
 * Feeds Google Routes modifiers + pin-selection thresholds + viewer-facing badges.
 */

export const DRIVING_ROUTE_STYLE_VERSION = 1 as const;

export type ComfortVsSpeed = "comfort" | "balanced" | "speed";
export type PathStyle = "smooth" | "balanced" | "direct";

export type DrivingRouteStyle = {
  version: typeof DRIVING_ROUTE_STYLE_VERSION;
  comfortVsSpeed: ComfortVsSpeed;
  pathStyle: PathStyle;
  ecoConscious: boolean;
};

export const DEFAULT_DRIVING_ROUTE_STYLE: DrivingRouteStyle = {
  version: DRIVING_ROUTE_STYLE_VERSION,
  comfortVsSpeed: "balanced",
  pathStyle: "balanced",
  ecoConscious: false,
};

function isComfortVsSpeed(v: unknown): v is ComfortVsSpeed {
  return v === "comfort" || v === "balanced" || v === "speed";
}

function isPathStyle(v: unknown): v is PathStyle {
  return v === "smooth" || v === "balanced" || v === "direct";
}

export function normalizeDrivingRouteStyle(raw: unknown): DrivingRouteStyle {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DRIVING_ROUTE_STYLE };
  const o = raw as Record<string, unknown>;
  const comfortVsSpeed = isComfortVsSpeed(o.comfortVsSpeed)
    ? o.comfortVsSpeed
    : DEFAULT_DRIVING_ROUTE_STYLE.comfortVsSpeed;
  const pathStyle = isPathStyle(o.pathStyle)
    ? o.pathStyle
    : DEFAULT_DRIVING_ROUTE_STYLE.pathStyle;
  const ecoConscious =
    typeof o.ecoConscious === "boolean"
      ? o.ecoConscious
      : DEFAULT_DRIVING_ROUTE_STYLE.ecoConscious;
  return {
    version: DRIVING_ROUTE_STYLE_VERSION,
    comfortVsSpeed,
    pathStyle,
    ecoConscious,
  };
}

/** Motor modes where avoidHighways / toll semantics apply. */
export function isMotorizedRoadMode(transportMode?: string | null): boolean {
  const m = (transportMode ?? "").toLowerCase();
  return (
    m.includes("car") ||
    m.includes("drive") ||
    m.includes("scooter") ||
    m.includes("motor")
  );
}

export type GoogleRouteRequestTuning = {
  routingPreference?: "TRAFFIC_AWARE" | "TRAFFIC_AWARE_OPTIMAL" | "TRAFFIC_UNAWARE";
  routeModifiers?: {
    avoidHighways?: boolean;
    avoidTolls?: boolean;
    avoidFerries?: boolean;
  };
};

export function googleRouteTuningFromDrivingStyle(
  style: DrivingRouteStyle,
  transportMode?: string | null,
): GoogleRouteRequestTuning {
  const motor = isMotorizedRoadMode(transportMode);
  let routingPreference: GoogleRouteRequestTuning["routingPreference"] =
    "TRAFFIC_AWARE";
  if (style.comfortVsSpeed === "speed") {
    routingPreference = "TRAFFIC_AWARE_OPTIMAL";
  } else if (style.comfortVsSpeed === "comfort") {
    routingPreference = "TRAFFIC_AWARE";
  }

  const routeModifiers: NonNullable<GoogleRouteRequestTuning["routeModifiers"]> =
    {};

  if (motor) {
    if (style.pathStyle === "smooth") {
      routeModifiers.avoidHighways = true;
    } else if (style.pathStyle === "direct") {
      routeModifiers.avoidHighways = false;
    }
    if (style.ecoConscious) {
      routeModifiers.avoidTolls = true;
    }
    if (style.pathStyle === "smooth" && style.comfortVsSpeed !== "speed") {
      routeModifiers.avoidFerries = true;
    }
  }

  const hasMod = Object.keys(routeModifiers).some(
    (k) => routeModifiers[k as keyof typeof routeModifiers] === true,
  );

  return {
    routingPreference,
    ...(hasMod ? { routeModifiers } : {}),
  };
}

/** Softer pin filter for "direct" drivers; stricter for "smooth". */
export function minBranchComfortForDrivingStyle(style: DrivingRouteStyle): number {
  if (style.pathStyle === "smooth") return 0.52;
  if (style.pathStyle === "direct") return 0.38;
  return 0.45;
}

/** Human-readable chips for map overlay (max length enforced by caller). */
export function drivingRouteStyleBadges(
  style: DrivingRouteStyle,
  transportMode?: string | null,
): string[] {
  const motor = isMotorizedRoadMode(transportMode);
  const tags: string[] = [];

  if (style.pathStyle === "smooth") {
    tags.push(motor ? "Avoids highways" : "Calmer paths");
    tags.push("Smooth driving");
  } else if (style.pathStyle === "direct") {
    tags.push("Likes shortcuts");
    tags.push("Direct routes");
  }

  if (style.comfortVsSpeed === "comfort") {
    tags.push("Comfort over speed");
  } else if (style.comfortVsSpeed === "speed") {
    tags.push("Prioritizes ETA");
  }

  if (style.ecoConscious) {
    tags.push(motor ? "Saves gas & tolls" : "Light footprint");
  }

  const dedup = [...new Set(tags)];
  if (dedup.length === 0) {
    dedup.push("Everyday routing");
  }
  return dedup.slice(0, 4);
}
