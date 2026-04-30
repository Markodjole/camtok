/**
 * OSM road-class normalization & comfort scoring used by the bettable
 * crossroad selector. Mirrors the spec in
 * `camtok_road_api_bettable_crossroads_cursor_instructions.md` so we can pick
 * meaningful intersections (real left/right/straight choices) and avoid
 * bets on tiny side streets, tracks, service alleys, or private roads.
 */

export type NormalizedRoadClass =
  | "motorway"
  | "major"
  | "medium"
  | "local"
  | "minor"
  | "service"
  | "bad"
  | "forbidden"
  | "unknown";

export type OsmRoadTags = {
  highway?: string | null;
  surface?: string | null;
  access?: string | null;
  motor_vehicle?: string | null;
  oneway?: string | null;
  lanes?: string | null;
  maxspeed?: string | null;
};

const FORBIDDEN_HIGHWAY = new Set([
  "track",
  "path",
  "footway",
  "cycleway",
  "pedestrian",
  "steps",
  "bridleway",
  "corridor",
  "elevator",
]);

export function normalizeOsmRoad(tags: OsmRoadTags): NormalizedRoadClass {
  if (tags.access === "private" || tags.motor_vehicle === "no") {
    return "forbidden";
  }
  const highway = (tags.highway ?? "").toLowerCase();
  const surface = (tags.surface ?? "").toLowerCase();

  if (
    highway === "motorway" ||
    highway === "motorway_link" ||
    highway === "trunk" ||
    highway === "trunk_link"
  ) {
    return "motorway";
  }
  if (
    highway === "primary" ||
    highway === "primary_link" ||
    highway === "secondary" ||
    highway === "secondary_link"
  ) {
    return "major";
  }
  if (highway === "tertiary" || highway === "tertiary_link") return "medium";
  if (highway === "residential" || highway === "living_street") return "local";
  if (highway === "unclassified") return "minor";
  if (highway === "service") return "service";
  if (FORBIDDEN_HIGHWAY.has(highway)) return "bad";

  if (
    surface === "dirt" ||
    surface === "gravel" ||
    surface === "unpaved" ||
    surface === "ground" ||
    surface === "mud" ||
    surface === "sand"
  ) {
    return "bad";
  }

  return "unknown";
}

export function scoreRoadComfort(
  roadClass: NormalizedRoadClass,
  surface?: string | null,
  access?: string | null,
): number {
  let score = 0.4;
  switch (roadClass) {
    case "motorway":
      score = 0.75;
      break;
    case "major":
      score = 1.0;
      break;
    case "medium":
      score = 0.85;
      break;
    case "local":
      score = 0.65;
      break;
    case "minor":
      score = 0.45;
      break;
    case "service":
      score = 0.25;
      break;
    case "bad":
      score = 0.05;
      break;
    case "forbidden":
      score = 0;
      break;
    case "unknown":
      score = 0.4;
      break;
  }
  if (surface === "gravel") score -= 0.25;
  if (surface === "dirt") score -= 0.45;
  if (surface === "unpaved") score -= 0.3;
  if (access === "private") score = 0;
  return Math.max(0, Math.min(1, score));
}

/**
 * Hard-reject branches that should never be considered for betting.
 * Aligns with §8 "Skip bad branches" of the integration spec.
 */
export function isHardRejected(
  roadClass: NormalizedRoadClass,
  tags: OsmRoadTags,
): boolean {
  if (roadClass === "forbidden" || roadClass === "bad") return true;
  const hw = (tags.highway ?? "").toLowerCase();
  if (FORBIDDEN_HIGHWAY.has(hw)) return true;
  if (tags.access === "private" || tags.motor_vehicle === "no") return true;
  return false;
}

const MAJOR_OR_BETTER: NormalizedRoadClass[] = ["motorway", "major", "medium"];

export function isMajorOrBetter(rc: NormalizedRoadClass): boolean {
  return MAJOR_OR_BETTER.includes(rc);
}
