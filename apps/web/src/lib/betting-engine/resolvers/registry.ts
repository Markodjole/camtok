import type {
  BetResolverV2,
  BetResolutionV2,
  BetTypeV2,
  LiveStateV2,
  UserBetV2,
} from "@bettok/live";

function notYet(betType: BetTypeV2): BetResolutionV2 {
  return {
    voidReason: "measurement_failed",
    actualValues: { note: `${betType}: resolver not wired to live telemetry yet` },
  };
}

export class NextTurnResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "next_turn";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

export class ZoneExitTimeResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "zone_exit_time";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

export class NextZoneResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "next_zone";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

const REGISTRY: Partial<Record<BetTypeV2, BetResolverV2>> = {
  next_turn: new NextTurnResolver(),
  zone_exit_time: new ZoneExitTimeResolver(),
  next_zone: new NextZoneResolver(),
};

export function getBetResolverV2(type: BetTypeV2): BetResolverV2 | undefined {
  return REGISTRY[type];
}
