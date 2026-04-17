/**
 * CamTok live betting domain — canonical TypeScript types mirroring the
 * database schema introduced in migration 00038_live_route_betting.sql.
 *
 * All timestamps are ISO-8601 strings at the boundary; internal math can
 * parse them into Date/number where needed.
 */

export type TransportMode =
  | "walking"
  | "bike"
  | "scooter"
  | "car"
  | "other_vehicle";

export type LiveSessionStatus =
  | "starting"
  | "live"
  | "paused"
  | "ended"
  | "errored";

export type LiveSafetyLevel = "normal" | "restricted" | "blocked";

export type LiveRoomPhase =
  | "idle"
  | "waiting_for_next_market"
  | "market_open"
  | "market_locked"
  | "reveal_pending"
  | "revealed"
  | "settled";

export type LiveMarketSource = "system_generated" | "user_generated";

export type LiveMarketType =
  | "next_direction"
  | "next_stop"
  | "next_place_type"
  | "entry_vs_skip"
  | "left_right_split"
  | "continue_vs_turn"
  | "route_choice"
  | "custom_validated";

export type LiveMarketStatus =
  | "draft"
  | "open"
  | "locked"
  | "revealed"
  | "settled"
  | "cancelled";

export type LiveDecisionStatus =
  | "candidate"
  | "open"
  | "locked"
  | "revealed"
  | "expired"
  | "cancelled";

export type LiveDecisionDirection =
  | "left"
  | "right"
  | "straight"
  | "enter"
  | "stop"
  | "continue"
  | "turn_back"
  | "lane_choice"
  | "destination_choice"
  | "other";

export type LiveUserMarketStatus =
  | "submitted"
  | "validated"
  | "rejected"
  | "converted_to_market";

export type CharacterLiveSession = {
  id: string;
  characterId: string;
  ownerUserId: string;
  status: LiveSessionStatus;
  transportMode: TransportMode;
  streamProvider: "webrtc";
  streamKey?: string | null;
  sessionStartedAt: string;
  sessionEndedAt?: string | null;
  lastHeartbeatAt?: string | null;
  currentRoomId?: string | null;
  currentStatusText?: string | null;
  currentIntentLabel?: string | null;
  regionLabel?: string | null;
  placeType?: string | null;
  safetyLevel: LiveSafetyLevel;
};

export type LiveRouteSnapshot = {
  id: string;
  liveSessionId: string;
  recordedAt: string;
  rawLat: number;
  rawLng: number;
  normalizedLat?: number | null;
  normalizedLng?: number | null;
  speedMps?: number | null;
  headingDeg?: number | null;
  accuracyMeters?: number | null;
  altitudeMeters?: number | null;
  transportMode: TransportMode;
  matchedNodeId?: string | null;
  matchedEdgeId?: string | null;
  regionLabel?: string | null;
  placeType?: string | null;
  confidenceScore?: number | null;
};

export type RouteDecisionOption = {
  optionId: string;
  label: string;
  directionType: LiveDecisionDirection;
  mapTargetNodeId?: string | null;
  mapTargetEdgeId?: string | null;
  confidenceScore?: number | null;
};

export type RouteDecisionNode = {
  id: string;
  liveSessionId: string;
  generatedAt: string;
  currentNodeId: string;
  currentEdgeId?: string | null;
  triggerDistanceMeters: number;
  triggerEtaSeconds?: number | null;
  optionCount: number;
  options: RouteDecisionOption[];
  status: LiveDecisionStatus;
  safetyLevel: LiveSafetyLevel;
};

export type LiveMarketOption = {
  id: string;
  label: string;
  shortLabel?: string | null;
  odds?: number | null;
  displayOrder: number;
};

export type LiveBettingMarket = {
  id: string;
  roomId: string;
  liveSessionId: string;
  decisionNodeId?: string | null;
  source: LiveMarketSource;
  sourceUserId?: string | null;
  title: string;
  subtitle?: string | null;
  marketType: LiveMarketType;
  optionSet: LiveMarketOption[];
  opensAt: string;
  locksAt: string;
  revealAt: string;
  status: LiveMarketStatus;
  lockedOutcomeOptionId?: string | null;
  lockCommitHash?: string | null;
  lockEvidenceJson?: Record<string, unknown> | null;
  settlementReason?: string | null;
  totalBetAmount: number;
  participantCount: number;
};

export type UserMarketProposal = {
  id: string;
  roomId: string;
  liveSessionId: string;
  proposerUserId: string;
  title: string;
  optionSet: Array<{ id: string; label: string }>;
  status: LiveUserMarketStatus;
  rejectionReason?: string | null;
  validationNotes?: string[] | null;
  convertedMarketId?: string | null;
  createdAt: string;
};

export type LiveRoom = {
  id: string;
  liveSessionId: string;
  characterId: string;
  phase: LiveRoomPhase;
  currentMarketId?: string | null;
  viewerCount: number;
  participantCount: number;
  lastEventAt: string;
};

export type MarketLockRecord = {
  id: string;
  marketId: string;
  lockedAt: string;
  selectedOptionId: string;
  candidateOptionIds: string[];
  routeSnapshotId?: string | null;
  decisionNodeId?: string | null;
  commitHash: string;
  evidenceJson: Record<string, unknown>;
};

export type LiveRoomEvent = {
  id: string;
  roomId: string;
  marketId?: string | null;
  occurredAt: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type LiveContext = {
  liveSessionId: string;
  statusText?: string | null;
  intentLabel?: string | null;
  transportMode: TransportMode;
  placeType?: string | null;
  regionLabel?: string | null;
  timeOfDay?: "morning" | "afternoon" | "evening" | "night" | null;
  recentActivitySummary?: string[];
};

export type LiveBet = {
  id: string;
  marketId: string;
  roomId: string;
  userId: string;
  optionId: string;
  stakeAmount: number;
  placedAt: string;
  settledAt?: string | null;
  won?: boolean | null;
  payoutAmount?: number | null;
  status:
    | "active"
    | "locked"
    | "settled_win"
    | "settled_loss"
    | "refunded"
    | "cancelled";
};
