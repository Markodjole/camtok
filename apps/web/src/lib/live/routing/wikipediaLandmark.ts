/**
 * Nearby landmark lookup for the next_step map pin.
 *
 * Strategy (in order):
 *   1. Wikipedia Geosearch — articles within 5 km with a thumbnail photo.
 *      Returns name + photo.  Covers museums, churches, parks, hotels, etc.
 *   2. OpenStreetMap Overpass — ANY named POI within 300 m (café, shop,
 *      restaurant, hotel, bar, park, monument…).  Returns name only (no photo).
 *
 * Both levels are cached by a ~100 m grid key so rapid pin updates don't
 * hammer the APIs.
 */

export type NearbyLandmark = {
  /** Display name — article title or OSM `name` tag. */
  name: string;
  /**
   * Thumbnail photo URL, or null when only an OSM name was found.
   * The UI renders a colored initial-circle as fallback when null.
   */
  photo: string | null;
  /** Wikipedia article URL, or empty string for OSM-only results. */
  articleUrl: string;
};

const _cache = new Map<string, NearbyLandmark | null>();

function cacheKey(lat: number, lng: number) {
  return `${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

// ─── Level 1: Wikipedia Geosearch ────────────────────────────────────────────

async function fetchWikipediaLandmark(
  lat: number,
  lng: number,
  radiusM = 5_000,
): Promise<NearbyLandmark | null> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "geosearch");
  url.searchParams.set("ggscoord", `${lat}|${lng}`);
  url.searchParams.set("ggsradius", String(radiusM));
  url.searchParams.set("ggslimit", "20");
  url.searchParams.set("prop", "pageimages");
  url.searchParams.set("pithumbsize", "200");
  url.searchParams.set("pilimit", "20");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    query?: {
      pages?: Record<string, {
        title?: string;
        thumbnail?: { source: string };
      }>;
    };
  };

  const pages = data?.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    if (page.thumbnail?.source && page.title) {
      return {
        name: page.title,
        photo: page.thumbnail.source,
        articleUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
      };
    }
  }
  return null;
}

// ─── Level 2: OSM Overpass — any named POI ────────────────────────────────────
//
// Returns the nearest named amenity / shop / tourism / leisure / historic /
// natural feature within `radiusM` metres.  No API key required.

async function fetchOsmPoi(
  lat: number,
  lng: number,
  radiusM = 300,
): Promise<NearbyLandmark | null> {
  const tags = ["amenity", "shop", "tourism", "leisure", "historic", "natural", "building"];
  const nodeClauses = tags
    .map((t) => `node(around:${radiusM},${lat},${lng})[name][${t}];`)
    .join("\n  ");

  const query = `[out:json][timeout:5];\n(\n  ${nodeClauses}\n);\nout center 10;`;

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      elements?: Array<{
        tags?: Record<string, string>;
      }>;
    };

    const el = data.elements?.[0];
    const name = el?.tags?.name;
    if (!name) return null;

    return { name, photo: null, articleUrl: "" };
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchNearbyLandmark(
  lat: number,
  lng: number,
  radiusM = 5_000,
): Promise<NearbyLandmark | null> {
  const key = cacheKey(lat, lng);
  if (_cache.has(key)) return _cache.get(key) ?? null;

  try {
    // Level 1: Wikipedia (photo + name)
    const wiki = await fetchWikipediaLandmark(lat, lng, radiusM);
    if (wiki) {
      _cache.set(key, wiki);
      return wiki;
    }
  } catch {
    // Wikipedia unavailable — continue to fallback
  }

  try {
    // Level 2: Any named OSM POI within 300 m (name only, no photo)
    const osm = await fetchOsmPoi(lat, lng, 300);
    if (osm) {
      _cache.set(key, osm);
      return osm;
    }
  } catch {
    // Overpass unavailable
  }

  _cache.set(key, null);
  return null;
}

/** Convenience wrapper — returns just the photo URL (backward compat). */
export async function fetchNearbyLandmarkPhoto(
  lat: number,
  lng: number,
  radiusM = 5_000,
): Promise<string | null> {
  const result = await fetchNearbyLandmark(lat, lng, radiusM);
  return result?.photo ?? null;
}
