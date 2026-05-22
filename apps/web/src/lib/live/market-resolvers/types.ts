import type { createServiceClient } from "@/lib/supabase/server";
import type { LiveMarketOption } from "@bettok/live";
import type { CityGridSpecCompact } from "@/lib/live/grid/cityGrid500";

export type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;

/**
 * Subset of `live_betting_markets` fields required by any resolver.
 * Resolvers receive this instead of the raw DB row to keep them
 * type-safe and independent of the Supabase generated types.
 */
export type MarketForResolution = {
  id: string;
  room_id: string;
  live_session_id: string;
  market_type: string;
  option_set: LiveMarketOption[];
  opens_at: string;
  reveal_at: string;
  city_grid_spec: CityGridSpecCompact | null;
  subtitle: string | null;
  turn_point_lat: number | null;
  turn_point_lng: number | null;
  decision_node_id: string | null;
};

/**
 * The decision a resolver reaches.
 *
 * - `"win"` → a specific option won; `optionId` is the winner.
 * - `"refund"` → GPS was insufficient, driver didn't move, or another
 *    unresolvable condition; all stakes are returned.
 */
export type MarketResolution =
  | { outcome: "win"; optionId: string; reason: string }
  | { outcome: "refund"; reason: string };

/**
 * A resolver for one market type.
 *
 * MUST be side-effect-free — only read GPS/DB data and return the decision.
 * The caller (`revealAndSettleMarket`) performs all DB writes.
 */
export type MarketResolverFn = (
  market: MarketForResolution,
  service: ServiceClient,
) => Promise<MarketResolution>;
