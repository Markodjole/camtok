import { GOOGLE_ROUTE_OFF_PATH_DISPLAY_M } from "@/lib/live/routing/googleRouteCache";
import { projectOntoPolyline, type LatLng } from "@/lib/live/routing/geometry";

/** True when GPS is too far from the cached Google polyline to show it. */
export function isDriverOffGoogleDestinationRoute(
  driver: LatLng,
  polyline: LatLng[],
  thresholdM = GOOGLE_ROUTE_OFF_PATH_DISPLAY_M,
): boolean {
  if (polyline.length < 2) return true;
  const proj = projectOntoPolyline(polyline, driver);
  return proj == null || proj.distanceMeters > thresholdM;
}
