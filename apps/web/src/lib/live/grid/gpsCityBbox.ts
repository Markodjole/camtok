/**
 * City-scale bounding box from driver GPS — no Google Geocoding call.
 * Used to bound the 500 m zone grid (Maps ToS: do not cache geocode viewport).
 */

export type GpsCityBbox = {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
};

/** ~±radiusKm box around a point (WGS84, mid-latitude adjusted for longitude). */
export function bboxAroundGps(
  lat: number,
  lng: number,
  radiusKm = 2.5,
): GpsCityBbox {
  const dLat = radiusKm / 111.32;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLng = radiusKm / (111.32 * Math.max(0.2, cos));
  return {
    swLat: lat - dLat,
    swLng: lng - dLng,
    neLat: lat + dLat,
    neLng: lng + dLng,
  };
}
