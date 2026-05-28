/**
 * Result from the nearest Wikipedia landmark lookup.
 */
export type NearbyLandmark = {
  /** Article title — the landmark name. */
  name: string;
  /** Thumbnail photo URL (200 px wide). */
  photo: string;
  /** Wikipedia article URL for attribution. */
  articleUrl: string;
};

/**
 * Fetches the nearest Wikipedia landmark with a photo within `radiusM` metres.
 *
 * Uses Wikipedia's generator+geosearch + pageimages API — CORS-enabled,
 * no API key required.
 *
 * Results are cached by a ~100 m grid bucket so rapid pin updates in the
 * same area hit memory rather than the network.
 */

const _cache = new Map<string, NearbyLandmark | null>();

export async function fetchNearbyLandmark(
  lat: number,
  lng: number,
  radiusM = 1000,
): Promise<NearbyLandmark | null> {
  const key = `${lat.toFixed(3)}:${lng.toFixed(3)}`;
  if (_cache.has(key)) return _cache.get(key) ?? null;

  try {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("generator", "geosearch");
    url.searchParams.set("ggscoord", `${lat}|${lng}`);
    url.searchParams.set("ggsradius", String(radiusM));
    url.searchParams.set("ggslimit", "10");
    url.searchParams.set("prop", "pageimages");
    url.searchParams.set("pithumbsize", "200");
    url.searchParams.set("pilimit", "10");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) { _cache.set(key, null); return null; }

    const data = (await res.json()) as {
      query?: {
        pages?: Record<string, {
          pageid?: number;
          title?: string;
          thumbnail?: { source: string };
        }>;
      };
    };

    const pages = data?.query?.pages;
    if (!pages) { _cache.set(key, null); return null; }

    for (const page of Object.values(pages)) {
      if (page.thumbnail?.source && page.title) {
        const result: NearbyLandmark = {
          name: page.title,
          photo: page.thumbnail.source,
          articleUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
        };
        _cache.set(key, result);
        return result;
      }
    }
  } catch {
    // Network error / timeout — don't cache so the next attempt retries.
    return null;
  }

  _cache.set(key, null);
  return null;
}

/** Convenience wrapper — returns just the photo URL (backward compat). */
export async function fetchNearbyLandmarkPhoto(
  lat: number,
  lng: number,
  radiusM = 1000,
): Promise<string | null> {
  const result = await fetchNearbyLandmark(lat, lng, radiusM);
  return result?.photo ?? null;
}
