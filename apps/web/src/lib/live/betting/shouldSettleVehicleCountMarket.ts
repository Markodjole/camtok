import type { VehicleCount30sSubtitle } from "@/actions/live-vehicle-count-market";

function parseSubtitle(subtitle: string | null): VehicleCount30sSubtitle | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as Partial<VehicleCount30sSubtitle>;
    if (typeof meta.roundId === "string" && typeof meta.countWindowMs === "number") {
      return meta as VehicleCount30sSubtitle;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Settle when count window elapsed (locks_at + countWindowMs) or reveal_at passed. */
export function shouldSettleVehicleCountMarket(opts: {
  locksAt: string;
  revealAt: string;
  subtitle: string | null;
}): boolean {
  const now = Date.now();
  if (now >= new Date(opts.revealAt).getTime()) return true;
  const meta = parseSubtitle(opts.subtitle);
  if (!meta) return false;
  const countEnd = new Date(opts.locksAt).getTime() + meta.countWindowMs;
  return now >= countEnd;
}
