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

export class TimeVsGoogleResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "time_vs_google";
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

export class ZoneDurationResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "zone_duration";
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

export class TurnsBeforeZoneExitResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "turns_before_zone_exit";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

export class StopCountResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "stop_count";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

export class TurnCountToPinResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "turn_count_to_pin";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

export class EtaDriftResolver implements BetResolverV2 {
  readonly betType: BetTypeV2 = "eta_drift";
  canResolve(_bet: UserBetV2, _live: LiveStateV2): boolean {
    return false;
  }
  resolve(_bet: UserBetV2, _live: LiveStateV2): BetResolutionV2 {
    return notYet(this.betType);
  }
}

const REGISTRY: Partial<Record<BetTypeV2, BetResolverV2>> = {
  next_turn: new NextTurnResolver(),
  time_vs_google: new TimeVsGoogleResolver(),
  zone_exit_time: new ZoneExitTimeResolver(),
  zone_duration: new ZoneDurationResolver(),
  next_zone: new NextZoneResolver(),
  turns_before_zone_exit: new TurnsBeforeZoneExitResolver(),
  stop_count: new StopCountResolver(),
  turn_count_to_pin: new TurnCountToPinResolver(),
  eta_drift: new EtaDriftResolver(),
};

export function getBetResolverV2(type: BetTypeV2): BetResolverV2 | undefined {
  return REGISTRY[type];
}
