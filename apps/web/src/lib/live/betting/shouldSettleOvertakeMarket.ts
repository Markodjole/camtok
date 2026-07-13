import type { ServiceClient } from "@/lib/live/market-resolvers/types";
import type { Overtake30sSubtitle } from "@/actions/live-overtake-market";

function parseSubtitle(subtitle: string | null): Overtake30sSubtitle | null {
  try {
    const meta = JSON.parse(subtitle ?? "{}") as Partial<Overtake30sSubtitle>;
    if (typeof meta.trackId === "string" && typeof meta.windowMs === "number") {
      return meta as Overtake30sSubtitle;
    }
  } catch {
    return null;
  }
  return null;
}

/** True when overtake market can settle (lost signal or window elapsed). */
export async function shouldSettleOvertakeMarket(
  service: ServiceClient,
  opts: {
    liveSessionId: string | null;
    opensAt: string;
    revealAt: string;
    subtitle: string | null;
  },
): Promise<boolean> {
  if (!opts.liveSessionId) return false;
  const meta = parseSubtitle(opts.subtitle);
  if (!meta) return Date.now() >= new Date(opts.revealAt).getTime();

  const opensAt = new Date(opts.opensAt).getTime();
  const deadline = opensAt + meta.windowMs;
  if (Date.now() >= deadline) return true;

  const { data: lost } = await service
    .from("lead_vehicle_events")
    .select("id")
    .eq("live_session_id", opts.liveSessionId)
    .eq("event_type", "lead_vehicle_lost")
    .eq("track_id", meta.trackId)
    .gte("recorded_at", opts.opensAt)
    .limit(1)
    .maybeSingle();

  return !!lost;
}
