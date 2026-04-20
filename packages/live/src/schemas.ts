import { z } from "zod";

export const transportModeSchema = z.enum([
  "walking",
  "bike",
  "scooter",
  "car",
  "other_vehicle",
]);

export const liveSessionStatusSchema = z.enum([
  "starting",
  "live",
  "paused",
  "ended",
  "errored",
]);

export const liveRoomPhaseSchema = z.enum([
  "idle",
  "waiting_for_next_market",
  "market_open",
  "market_locked",
  "reveal_pending",
  "revealed",
  "settled",
]);

export const liveMarketTypeSchema = z.enum([
  "next_direction",
  "next_stop",
  "next_place_type",
  "entry_vs_skip",
  "left_right_split",
  "continue_vs_turn",
  "route_choice",
  "custom_validated",
]);

export const liveMarketStatusSchema = z.enum([
  "draft",
  "open",
  "locked",
  "revealed",
  "settled",
  "cancelled",
]);

export const decisionDirectionSchema = z.enum([
  "left",
  "right",
  "straight",
  "enter",
  "stop",
  "continue",
  "turn_back",
  "lane_choice",
  "destination_choice",
  "other",
]);

export const startSessionInputSchema = z.object({
  characterId: z.string().uuid(),
  transportMode: transportModeSchema,
  statusText: z.string().max(200).optional(),
  intentLabel: z.string().max(80).optional(),
});

export const heartbeatInputSchema = z.object({
  sessionId: z.string().uuid(),
  statusText: z.string().max(200).optional(),
  intentLabel: z.string().max(80).optional(),
});

export const locationPointSchema = z.object({
  recordedAt: z.string().datetime(),
  lat: z.number().finite(),
  lng: z.number().finite(),
  speedMps: z.number().finite().nonnegative().optional(),
  headingDeg: z.number().finite().min(0).max(360).optional(),
  accuracyMeters: z.number().finite().nonnegative().optional(),
  altitudeMeters: z.number().finite().optional(),
});

export const locationBatchInputSchema = z.object({
  sessionId: z.string().uuid(),
  transportMode: transportModeSchema,
  points: z.array(locationPointSchema).min(1).max(50),
});

export const marketOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  shortLabel: z.string().max(32).optional().nullable(),
  odds: z.number().finite().positive().optional().nullable(),
  displayOrder: z.number().int().nonnegative(),
});

export const proposeMarketInputSchema = z.object({
  roomId: z.string().uuid(),
  title: z.string().min(3).max(120),
  options: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(80) }))
    .min(2)
    .max(3),
});

export const placeLiveBetInputSchema = z.object({
  marketId: z.string().uuid(),
  optionId: z.string().min(1).max(64),
  stakeAmount: z.number().int().positive(),
});

export const camtokEntityTypeSchema = z.enum([
  "pedestrian",
  "bike",
  "car",
  "other",
]);

export const camtokBehaviorProfileUpdateSchema = z.object({
  characterId: z.string().uuid(),
  riskLevelScore: z.number().min(0).max(1).optional(),
  prefersMainRoadsScore: z.number().min(0).max(1).optional(),
  speedStyleScore: z.number().min(0).max(1).optional(),
  hesitationTendencyScore: z.number().min(0).max(1).optional(),
  safestRouteBiasScore: z.number().min(0).max(1).optional(),
  explorationBiasScore: z.number().min(0).max(1).optional(),
  learnedModelVersion: z.string().max(120).optional(),
  historyWindowSize: z.number().int().min(10).max(500).optional(),
});

export const camtokSafetyProfileUpdateSchema = z.object({
  characterId: z.string().uuid(),
  allowedZones: z.array(z.record(z.string(), z.unknown())).optional(),
  forbiddenZones: z.array(z.record(z.string(), z.unknown())).optional(),
  maximumMissionRadiusMeters: z.number().positive().optional(),
  emergencyStopState: z.boolean().optional(),
  moderationFlags: z.array(z.string()).optional(),
  operatorIdentityVerified: z.boolean().optional(),
});

export type StartSessionInput = z.infer<typeof startSessionInputSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatInputSchema>;
export type LocationPoint = z.infer<typeof locationPointSchema>;
export type LocationBatchInput = z.infer<typeof locationBatchInputSchema>;
export type ProposeMarketInput = z.infer<typeof proposeMarketInputSchema>;
export type PlaceLiveBetInput = z.infer<typeof placeLiveBetInputSchema>;
export type MarketOption = z.infer<typeof marketOptionSchema>;
export type CamtokBehaviorProfileUpdateInput = z.infer<typeof camtokBehaviorProfileUpdateSchema>;
export type CamtokSafetyProfileUpdateInput = z.infer<typeof camtokSafetyProfileUpdateSchema>;
