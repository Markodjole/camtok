/**
 * Privacy rule: never expose raw coordinates or precise addresses in public
 * UI. We only surface coarse `regionLabel` (neighborhood / district) and a
 * categorical `placeType` (e.g. "convenience", "residential", "retail_strip").
 *
 * This module exposes sanitization helpers; resolution against a real
 * geocoder plugs in later through a pluggable resolver interface.
 */
export type SanitizedLocation = {
  regionLabel: string | null;
  placeType: string | null;
};

export type ReverseGeocodeResolver = (lat: number, lng: number) =>
  | Promise<SanitizedLocation>
  | SanitizedLocation;

export async function sanitizeLocation(
  lat: number,
  lng: number,
  resolver?: ReverseGeocodeResolver,
): Promise<SanitizedLocation> {
  if (!resolver) return { regionLabel: null, placeType: null };
  const res = await resolver(lat, lng);
  return {
    regionLabel: res.regionLabel ? truncate(res.regionLabel, 60) : null,
    placeType: res.placeType ? truncate(res.placeType, 40) : null,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
