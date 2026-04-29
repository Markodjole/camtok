/**
 * Single reverse-geocode call to obtain a city-scale viewport (no POIs,
 * no Voronoi). Used only to bound the 500 m grid.
 */

export type CityViewport = {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  cityLabel: string | null;
};

export async function fetchCityViewportFromGoogle(
  lat: number,
  lng: number,
  key: string,
): Promise<
  | { ok: true; viewport: CityViewport }
  | { ok: false; status: string; message: string | null }
> {
  const revUrl =
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}` +
    `&key=${key}&language=en`;
  const rev = await fetch(revUrl, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as
    | {
        status?: string;
        error_message?: string;
        results?: Array<{
          formatted_address?: string;
          types?: string[];
          geometry?: {
            bounds?: {
              northeast: { lat: number; lng: number };
              southwest: { lat: number; lng: number };
            };
            viewport?: {
              northeast: { lat: number; lng: number };
              southwest: { lat: number; lng: number };
            };
          };
        }>;
      }
    | null;

  if (!rev || rev.status === "REQUEST_DENIED") {
    return {
      ok: false,
      status: rev?.status ?? "NO_RESPONSE",
      message: rev?.error_message ?? null,
    };
  }

  const results = rev.results ?? [];
  const locality = results.find((r) => (r.types ?? []).includes("locality"));
  const admin2 = results.find((r) =>
    (r.types ?? []).includes("administrative_area_level_2"),
  );
  const pick = locality ?? admin2 ?? results[0];
  const geom = pick?.geometry;
  const bounds = geom?.bounds ?? geom?.viewport;
  if (!bounds?.northeast || !bounds?.southwest) {
    const pad = 0.04;
    return {
      ok: true,
      viewport: {
        swLat: lat - pad,
        swLng: lng - pad,
        neLat: lat + pad,
        neLng: lng + pad,
        cityLabel: pick?.formatted_address ?? null,
      },
    };
  }

  const ne = bounds.northeast;
  const sw = bounds.southwest;

  return {
    ok: true,
    viewport: {
      swLat: sw.lat,
      swLng: sw.lng,
      neLat: ne.lat,
      neLng: ne.lng,
      cityLabel: pick?.formatted_address ?? null,
    },
  };
}
