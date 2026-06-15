/**
 * Google Maps Platform caching limits (Service Specific Terms).
 * place_id — indefinite; lat/lng from Google APIs — max 30 days.
 */

export const GOOGLE_LAT_LNG_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function isGoogleLatLngExpired(
  cachedAt: string | Date | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (cachedAt == null) return true;
  const t =
    cachedAt instanceof Date ? cachedAt.getTime() : new Date(cachedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > GOOGLE_LAT_LNG_MAX_AGE_MS;
}

export function googleLatLngExpiresAtIso(
  cachedAt: string | Date = new Date(),
): string {
  const t =
    cachedAt instanceof Date ? cachedAt.getTime() : new Date(cachedAt).getTime();
  return new Date(t + GOOGLE_LAT_LNG_MAX_AGE_MS).toISOString();
}
