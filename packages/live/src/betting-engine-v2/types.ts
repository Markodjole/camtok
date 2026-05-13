/**
 * Betting Engine V2 — domain types.
 * Active bet types: next_turn, next_zone, zone_exit_time.
 */

export type RoundKind = "shared_event" | "personal_snapshot";

export type RoundState =
  | "available"
  | "selected"
  | "locked"
  | "resolving"
  | "resolved"
  | "voided";

export type BetTypeV2 =
  | "next_turn"
  | "next_zone"
  | "zone_exit_time";

export type VoidReasonV2 =
  | "gps_uncertain"
  | "map_match_ambiguous"
  | "driver_deviation"
  | "pin_invalid"
  | "zone_ambiguous"
  | "route_changed"
  | "late_bet"
  | "measurement_failed";

export type BettingPatternV2 =
  | "approaching_turn"
  | "time_to_pin"
  | "zone_exit"
  | "traffic_slowdown"
  | "route_deviation"
  | "dense_city"
  | "main_vs_side";

export type BetOptionV2 = {
  id: string;
  label: string;
  subtitle?: string;
};

export type ProvisionalDataV2 = {
  googleEtaMs?: number;
  etaMs?: number;
  distanceToPinMeters?: number;
  speedMps?: number;
  speedTrend?: "faster" | "slower" | "stable";
  deviationPercent?: number;
  currentZoneId?: string;
  currentZoneName?: string;
  zoneTimeMs?: number;
  zoneExitEstimateMs?: number;
  turnsUpcoming?: number;
  stopsLikely?: boolean;
};

export type BetSignalV2 = {
  id: string;
  label: string;
  value: string;
  trend?: "up" | "down" | "stable";
  importance: "primary" | "secondary";
};

export type RoundContextV2 = {
  streamId: string;
  roomId?: string;
  liveSessionId?: string;
  routeVersion?: string;
};

export type BetResolutionV2 = {
  correctOptionId?: string;
  actualValues?: Record<string, number | string>;
  voidReason?: VoidReasonV2;
};

export type UserBetSnapshotV2 = {
  betPlacedAt: string;
  driverPosition: { lat: number; lng: number };
  driverHeading?: number;
  driverSpeedMps?: number;
  googleEtaAtClickMs?: number;
  etaAtClickMs?: number;
  zoneId?: string;
  zoneEnteredAt?: string;
  zoneExitBaselineMs?: number;
  durationBaselineMs?: number;
  nextPinId?: string;
  distanceToPinMeters?: number;
  routeVersion?: string;
  mapConfidence?: number;
};

export type UserBetV2 = {
  id: string;
  userId: string;
  roundId: string;
  streamId: string;
  optionId: string;
  placedAt: string;
  snapshot: UserBetSnapshotV2;
  state: "placed" | "locked" | "won" | "lost" | "voided";
  result?: BetResolutionV2;
};

export type BetRoundV2 = {
  id: string;
  streamId: string;
  kind: RoundKind;
  type: BetTypeV2;
  state: RoundState;
  title: string;
  question: string;
  options: BetOptionV2[];
  createdAt: string;
  availableUntil?: string;
  lockAt?: string;
  resolveBy?: string;
  provisional: ProvisionalDataV2;
  signals: BetSignalV2[];
  context: RoundContextV2;
  pattern?: BettingPatternV2;
  result?: BetResolutionV2;
};

export type TimeVsGoogleSnapshotV2 = {
  betPlacedAt: string;
  driverPositionAtClick: { lat: number; lng: number };
  googleEtaAtClickMs: number;
  nextPinId: string;
  routeVersion?: string;
};

export type ZoneExitSnapshotV2 = {
  betPlacedAt: string;
  positionAtClick: { lat: number; lng: number };
  zoneId: string;
  zoneExitBaselineMs: number;
};

export type RoundPlanV2 = {
  type: BetTypeV2;
  priority: number;
  kind: RoundKind;
};
