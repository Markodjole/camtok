import type { BetResolutionV2, BetTypeV2, UserBetV2 } from "../types";

/**
 * Live state passed to resolvers — replace with concrete domain types when wiring services.
 */
export type LiveStateV2 = Record<string, unknown>;

/**
 * Per–bet-type resolution (guide §18). Implementations live in app/server layers.
 */
export interface BetResolverV2 {
  readonly betType: BetTypeV2;
  canResolve(bet: UserBetV2, liveState: LiveStateV2): boolean;
  resolve(bet: UserBetV2, liveState: LiveStateV2): BetResolutionV2;
}
