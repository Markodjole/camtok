/**
 * In-process API usage caps and counters (per server instance).
 * Pair with Google Cloud billing alerts + API key restrictions in GCP.
 */

export const API_USAGE_SERVICES = [
  "google_routes",
  "google_geocode",
  "google_places_autocomplete",
  "google_places_details",
  "google_places_nearby",
  "google_geo_context",
  "osrm",
  "openai",
  "fal",
] as const;

export type ApiUsageService = (typeof API_USAGE_SERVICES)[number];

export type ApiBlockReason = "disabled" | "rate_limited_minute" | "rate_limited_day";

export type ApiGuardResult =
  | { allowed: true }
  | { allowed: false; reason: ApiBlockReason };

type ServiceLimits = {
  disabled: boolean;
  maxPerMinute: number;
  maxPerDay: number;
};

type ServiceCounters = {
  minuteWindowStartMs: number;
  minuteAllowed: number;
  minuteBlocked: number;
  dayWindowStartMs: number;
  dayAllowed: number;
  dayBlocked: number;
  blockedByReason: Record<ApiBlockReason, number>;
  lastAllowedAtMs: number | null;
  lastBlockedAtMs: number | null;
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const DEFAULT_LIMITS: Record<ApiUsageService, { perMin: number; perDay: number }> = {
  google_routes: { perMin: 20, perDay: 800 },
  google_geocode: { perMin: 30, perDay: 1500 },
  google_places_autocomplete: { perMin: 40, perDay: 2000 },
  google_places_details: { perMin: 25, perDay: 1200 },
  google_places_nearby: { perMin: 15, perDay: 600 },
  google_geo_context: { perMin: 6, perDay: 200 },
  osrm: { perMin: 120, perDay: 15_000 },
  openai: { perMin: 15, perDay: 500 },
  fal: { perMin: 8, perDay: 200 },
};

const counters = new Map<ApiUsageService, ServiceCounters>();

function envFlag(name: string): boolean | null {
  const v = process.env[name];
  if (v == null || v === "") return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function googleMapsApisDisabled(): boolean {
  const flag = envFlag("GOOGLE_MAPS_APIS_DISABLED");
  if (flag != null) return flag;
  return false;
}

export function googleRoutesDisabled(): boolean {
  const disabled = envFlag("GOOGLE_ROUTES_DISABLED");
  if (disabled != null) return disabled;
  const enabled = envFlag("GOOGLE_ROUTES_ENABLED");
  if (enabled != null) return !enabled;
  if (process.env.NODE_ENV === "production") {
    return process.env.GOOGLE_ROUTES_ENABLED !== "1";
  }
  return false;
}

function serviceEnvPrefix(service: ApiUsageService): string {
  return service.toUpperCase();
}

function limitsFor(service: ApiUsageService): ServiceLimits {
  const prefix = serviceEnvPrefix(service);
  const defaults = DEFAULT_LIMITS[service];

  let disabled = envFlag(`${prefix}_DISABLED`) === true;
  if (service === "google_routes") {
    disabled = disabled || googleRoutesDisabled();
  }
  if (
    service.startsWith("google_") &&
    service !== "google_routes" &&
    googleMapsApisDisabled()
  ) {
    disabled = true;
  }

  const maxPerMinute = envInt(`${prefix}_MAX_PER_MIN`, defaults.perMin);
  const maxPerDay = envInt(
    `${prefix}_MAX_PER_DAY`,
    envInt("API_USAGE_DEFAULT_MAX_PER_DAY", defaults.perDay),
  );

  return { disabled, maxPerMinute, maxPerDay };
}

function getCounters(service: ApiUsageService): ServiceCounters {
  let c = counters.get(service);
  if (!c) {
    c = {
      minuteWindowStartMs: Date.now(),
      minuteAllowed: 0,
      minuteBlocked: 0,
      dayWindowStartMs: Date.now(),
      dayAllowed: 0,
      dayBlocked: 0,
      blockedByReason: {
        disabled: 0,
        rate_limited_minute: 0,
        rate_limited_day: 0,
      },
      lastAllowedAtMs: null,
      lastBlockedAtMs: null,
    };
    counters.set(service, c);
  }
  return c;
}

function rollWindows(c: ServiceCounters, now: number): void {
  if (now - c.minuteWindowStartMs >= MINUTE_MS) {
    c.minuteWindowStartMs = now;
    c.minuteAllowed = 0;
    c.minuteBlocked = 0;
  }
  if (now - c.dayWindowStartMs >= DAY_MS) {
    c.dayWindowStartMs = now;
    c.dayAllowed = 0;
    c.dayBlocked = 0;
  }
}

function recordBlock(c: ServiceCounters, reason: ApiBlockReason, now: number): void {
  c.minuteBlocked++;
  c.dayBlocked++;
  c.blockedByReason[reason]++;
  c.lastBlockedAtMs = now;
}

/** Returns whether an outbound API call is permitted. */
export function checkApiAllowed(service: ApiUsageService): ApiGuardResult {
  const limits = limitsFor(service);
  const c = getCounters(service);
  const now = Date.now();
  rollWindows(c, now);

  if (limits.disabled) {
    recordBlock(c, "disabled", now);
    return { allowed: false, reason: "disabled" };
  }

  if (c.minuteAllowed >= limits.maxPerMinute) {
    recordBlock(c, "rate_limited_minute", now);
    console.warn("[apiUsage] minute cap", { service, maxPerMinute: limits.maxPerMinute });
    return { allowed: false, reason: "rate_limited_minute" };
  }

  if (c.dayAllowed >= limits.maxPerDay) {
    recordBlock(c, "rate_limited_day", now);
    console.warn("[apiUsage] day cap", { service, maxPerDay: limits.maxPerDay });
    return { allowed: false, reason: "rate_limited_day" };
  }

  return { allowed: true };
}

/** Call immediately before issuing the outbound request. */
export function recordApiCall(service: ApiUsageService, count = 1): void {
  const c = getCounters(service);
  const now = Date.now();
  rollWindows(c, now);
  const n = Math.max(1, Math.floor(count));
  c.minuteAllowed += n;
  c.dayAllowed += n;
  c.lastAllowedAtMs = now;
}

export function assertApiAllowed(service: ApiUsageService): ApiGuardResult {
  const guard = checkApiAllowed(service);
  if (guard.allowed) recordApiCall(service);
  return guard;
}

export type ApiUsageServiceReport = {
  service: ApiUsageService;
  disabled: boolean;
  limits: { perMinute: number; perDay: number };
  minute: {
    windowStartMs: number;
    allowed: number;
    blocked: number;
    remaining: number;
  };
  day: {
    windowStartMs: number;
    allowed: number;
    blocked: number;
    remaining: number;
  };
  blockedByReason: Record<ApiBlockReason, number>;
  lastAllowedAt: string | null;
  lastBlockedAt: string | null;
};

export type ApiUsageReport = {
  generatedAt: string;
  nodeEnv: string | undefined;
  note: string;
  totals: {
    minuteAllowed: number;
    minuteBlocked: number;
    dayAllowed: number;
    dayBlocked: number;
  };
  services: ApiUsageServiceReport[];
};

export function getApiUsageReport(): ApiUsageReport {
  const now = Date.now();
  const services: ApiUsageServiceReport[] = API_USAGE_SERVICES.map((service) => {
    const limits = limitsFor(service);
    const c = getCounters(service);
    rollWindows(c, now);
    return {
      service,
      disabled: limits.disabled,
      limits: { perMinute: limits.maxPerMinute, perDay: limits.maxPerDay },
      minute: {
        windowStartMs: c.minuteWindowStartMs,
        allowed: c.minuteAllowed,
        blocked: c.minuteBlocked,
        remaining: Math.max(0, limits.maxPerMinute - c.minuteAllowed),
      },
      day: {
        windowStartMs: c.dayWindowStartMs,
        allowed: c.dayAllowed,
        blocked: c.dayBlocked,
        remaining: Math.max(0, limits.maxPerDay - c.dayAllowed),
      },
      blockedByReason: { ...c.blockedByReason },
      lastAllowedAt: c.lastAllowedAtMs
        ? new Date(c.lastAllowedAtMs).toISOString()
        : null,
      lastBlockedAt: c.lastBlockedAtMs
        ? new Date(c.lastBlockedAtMs).toISOString()
        : null,
    };
  });

  const totals = services.reduce(
    (acc, s) => {
      acc.minuteAllowed += s.minute.allowed;
      acc.minuteBlocked += s.minute.blocked;
      acc.dayAllowed += s.day.allowed;
      acc.dayBlocked += s.day.blocked;
      return acc;
    },
    { minuteAllowed: 0, minuteBlocked: 0, dayAllowed: 0, dayBlocked: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV,
    note:
      "Per server instance (Vercel may run many). Use with GCP billing alerts and API key restrictions.",
    totals,
    services,
  };
}
