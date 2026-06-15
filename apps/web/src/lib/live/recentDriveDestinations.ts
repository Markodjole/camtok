import type { PickedDestination } from "@/components/live/DestinationPicker";
import { isGoogleLatLngExpired } from "@/lib/google/mapsCachingPolicy";

const STORAGE_KEY = "camtok:liveRecentDestinations:v2";
const LEGACY_STORAGE_KEY = "camtok:liveRecentDestinations:v1";
const MAX = 25;

/** Persisted recent destination — place_id indefinite; lat/lng only for map pins. */
export type StoredRecentDestination = {
  placeId: string | null;
  label: string;
  /** User map pin only (not Google-sourced). */
  lat?: number;
  lng?: number;
  googleCoordsAtMs?: number;
};

export function destinationStorageKey(
  d: Pick<PickedDestination, "placeId"> & { lat?: number; lng?: number },
): string {
  if (d.placeId) return `p:${d.placeId}`;
  const lat = d.lat ?? 0;
  const lng = d.lng ?? 0;
  return `c:${lat.toFixed(5)}_${lng.toFixed(5)}`;
}

function readAll(): Record<string, StoredRecentDestination[]> {
  if (typeof window === "undefined") return {};
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, StoredRecentDestination[]>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, StoredRecentDestination[]>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}

function normalizeStored(entry: StoredRecentDestination): StoredRecentDestination | null {
  const label = (entry.label ?? "").trim();
  if (!label) return null;

  if (entry.placeId) {
    return { placeId: entry.placeId, label };
  }

  if (
    typeof entry.lat === "number" &&
    typeof entry.lng === "number" &&
    Number.isFinite(entry.lat) &&
    Number.isFinite(entry.lng)
  ) {
    if (
      entry.googleCoordsAtMs != null &&
      isGoogleLatLngExpired(new Date(entry.googleCoordsAtMs))
    ) {
      return null;
    }
    return {
      placeId: null,
      label,
      lat: entry.lat,
      lng: entry.lng,
    };
  }

  return null;
}

export function loadRecentDriveDestinations(characterId: string): StoredRecentDestination[] {
  const all = readAll();
  const list = all[characterId];
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => normalizeStored(d))
    .filter((d): d is StoredRecentDestination => d != null);
}

export function rememberDriveDestination(
  characterId: string,
  destination: PickedDestination,
): void {
  const key = destinationStorageKey(destination);
  const stored: StoredRecentDestination = destination.placeId
    ? { placeId: destination.placeId, label: destination.label }
    : {
        placeId: null,
        label: destination.label,
        lat: destination.lat,
        lng: destination.lng,
      };

  const all = readAll();
  const prev = Array.isArray(all[characterId]) ? all[characterId]! : [];
  const deduped = prev.filter(
    (d) => destinationStorageKey(d as PickedDestination) !== key,
  );
  const next = [stored, ...deduped].slice(0, MAX);
  all[characterId] = next;
  writeAll(all);
}

/** Resolve a saved place to coordinates (fresh Places Details — not cached locally). */
export async function resolveRecentDestination(
  stored: StoredRecentDestination,
): Promise<PickedDestination | null> {
  if (stored.placeId) {
    try {
      const res = await fetch(
        `/api/live/places/details?placeId=${encodeURIComponent(stored.placeId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        destination?: PickedDestination | null;
      };
      if (!json.destination) return null;
      return {
        lat: json.destination.lat,
        lng: json.destination.lng,
        label: json.destination.label || stored.label,
        placeId: stored.placeId,
      };
    } catch {
      return null;
    }
  }

  if (
    typeof stored.lat === "number" &&
    typeof stored.lng === "number" &&
    Number.isFinite(stored.lat) &&
    Number.isFinite(stored.lng)
  ) {
    return {
      lat: stored.lat,
      lng: stored.lng,
      label: stored.label,
      placeId: null,
    };
  }

  return null;
}
