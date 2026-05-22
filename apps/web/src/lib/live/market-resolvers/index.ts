/**
 * Market resolver registry.
 *
 * # Adding a new bet type
 * 1. Create `apps/web/src/lib/live/market-resolvers/<yourType>Resolver.ts`
 *    implementing `MarketResolverFn`.
 * 2. Import it here and add one line to the `resolverRegistry` map.
 * 3. That's it — the tick, lock, and settlement paths all call `resolveMarket`
 *    and will automatically dispatch to your resolver.
 */

import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { cityGridResolver } from "./cityGridResolver";
import { legacyDecisionNodeResolver } from "./legacyDecisionNodeResolver";
import { nextTurnResolver } from "./nextTurnResolver";
import { zoneExitTimeResolver } from "./zoneExitTimeResolver";

export type {
  MarketForResolution,
  MarketResolution,
  MarketResolverFn,
  ServiceClient,
} from "./types";

// ─── Registry ──────────────────────────────────────────────────────────────────

type MarketResolverFnLocal = (
  market: import("./types").MarketForResolution,
  service: import("./types").ServiceClient,
) => Promise<import("./types").MarketResolution>;

const resolverRegistry = new Map<string, MarketResolverFnLocal>([
  ["next_turn", nextTurnResolver],
  ["city_grid", cityGridResolver],
  ["zone_exit_time", zoneExitTimeResolver],
]);

/**
 * Register a resolver for a custom market type at runtime.
 *
 * Useful for feature-flagged or dynamically loaded bet types. Call before
 * any market of that type reaches the settlement path.
 */
export function registerMarketResolver(
  marketType: string,
  resolver: MarketResolverFnLocal,
): void {
  resolverRegistry.set(marketType, resolver);
}

// ─── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Resolve the winning option (or refund decision) for a locked market.
 *
 * Dispatches to the registered resolver for the market type. Falls back to
 * the legacy decision-node resolver for markets with a `decision_node_id`.
 * Unknown types that lack a resolver are refunded (not randomly picked) so
 * missing resolvers are immediately visible in logs.
 */
export async function resolveMarket(
  market: import("./types").MarketForResolution,
  service: import("./types").ServiceClient,
): Promise<import("./types").MarketResolution> {
  const resolver = resolverRegistry.get(market.market_type);
  if (resolver) {
    return resolver(market, service);
  }

  // Legacy markets backed by a route_decision_nodes row.
  if (market.decision_node_id) {
    return legacyDecisionNodeResolver(market, service);
  }

  // Unknown type — refund rather than randomly picking a winner.
  // This makes missing resolvers immediately obvious in logs.
  if (isEngineMarketType(market.market_type)) {
    console.warn(
      `[resolveMarket] Engine market type "${market.market_type}" has no registered ` +
        `resolver — refunding. Add a resolver in market-resolvers/ to fix this.`,
    );
  } else {
    console.warn(
      `[resolveMarket] Unknown market type "${market.market_type}" has no registered ` +
        `resolver — refunding.`,
    );
  }

  return { outcome: "refund", reason: `no_resolver_for_${market.market_type}` };
}
