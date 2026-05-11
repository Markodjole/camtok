import type { PickedDestination } from "@/components/live/DestinationPicker";

const STORAGE_KEY = "camtok:liveRecentDestinations:v1";
const MAX = 25;

export function destinationStorageKey(d: PickedDestination): string {
  if (d.placeId) return `p:${d.placeId}`;
  return `c:${d.lat.toFixed(5)}_${d.lng.toFixed(5)}`;
}

function readAll(): Record<string, PickedDestination[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, PickedDestination[]>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, PickedDestination[]>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}

export function loadRecentDriveDestinations(characterId: string): PickedDestination[] {
  const all = readAll();
  const list = all[characterId];
  return Array.isArray(list) ? list : [];
}

export function rememberDriveDestination(
  characterId: string,
  destination: PickedDestination,
): void {
  const key = destinationStorageKey(destination);
  const all = readAll();
  const prev = Array.isArray(all[characterId]) ? all[characterId]! : [];
  const deduped = prev.filter((d) => destinationStorageKey(d) !== key);
  const next = [destination, ...deduped].slice(0, MAX);
  all[characterId] = next;
  writeAll(all);
}
