import { z } from "zod";

export const transportModeSchema = z.enum([
  "walking",
  "run",
  "bike",
  "scooter",
  "car",
  "motorcycle",
  "other_vehicle",
  "other",
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

export const destinationInputSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  label: z.string().min(1).max(160),
  placeId: z.string().max(200).optional().nullable(),
});

export const startSessionInputSchema = z.object({
  characterId: z.string().uuid(),
  transportMode: transportModeSchema,
  statusText: z.string().max(200).optional(),
  intentLabel: z.string().max(80).optional(),
  destination: destinationInputSchema.optional().nullable(),
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

export const leadVehicleTelemetryEventSchema = z.object({
  eventType: z.enum([
    "lead_vehicle_acquired",
    "lead_vehicle_updated",
    "lead_vehicle_state_changed",
    "lead_vehicle_changed",
    "lead_vehicle_lost",
  ]),
  rideId: z.string().min(1).max(80),
  riderId: z.string().min(1).max(80),
  sessionId: z.string().uuid(),
  timestampMs: z.number().finite().nonnegative(),
  payload: z
    .object({
      trackId: z.string().max(64).optional(),
      vehicleType: z.string().max(40).optional(),
      confidence: z.number().finite().min(0).max(1).optional(),
      sameDirectionConfidence: z.number().finite().min(0).max(1).optional(),
      relativeState: z.string().max(64).optional(),
      visibleDurationMs: z.number().finite().nonnegative().optional(),
      lateralPosition: z.enum(["left", "center", "right"]).optional(),
      normalizedBoundingBox: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite(),
          height: z.number().finite(),
        })
        .optional(),
      detections: z
        .array(
          z.object({
            trackId: z.string().max(64).optional(),
            vehicleType: z.string().max(40).optional(),
            confidence: z.number().finite().min(0).max(1).optional(),
            isLead: z.boolean().optional(),
            normalizedBoundingBox: z.object({
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().finite(),
              height: z.number().finite(),
            }),
          }),
        )
        .max(20)
        .optional(),
      vehiclesOnScreen: z.number().int().nonnegative().max(100).optional(),
      vehiclesPassed: z.number().int().nonnegative().max(100000).optional(),
      lastPass: z
        .object({
          trackId: z.string().max(64),
          vehicleType: z.string().max(40).optional(),
          timestampMs: z.number().finite().nonnegative(),
        })
        .optional(),
      predictionReady: z.boolean().optional(),
      predictionConfidence: z.number().finite().min(0).max(1).optional(),
      predictionReasons: z.array(z.string().max(64)).max(20).optional(),
      predictionBlockers: z.array(z.string().max(64)).max(20).optional(),
    })
    .default({}),
  modelMetadata: z.object({
    modelName: z.string().max(80),
    modelVersion: z.string().max(40),
    inferenceMode: z.enum(["on_device", "remote", "mock"]),
  }),
});

export const leadVehicleEventsInputSchema = z.object({
  sessionId: z.string().uuid(),
  events: z.array(leadVehicleTelemetryEventSchema).min(1).max(20).optional(),
  /** Single-event shorthand used by mobile client. */
  event: leadVehicleTelemetryEventSchema.optional(),
}).refine((v) => !!(v.event || (v.events && v.events.length > 0)), {
  message: "event_or_events_required",
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
  /**
   * Epoch ms captured on the client the instant the user tapped "bet".
   * The server uses this as the effective bet time for lock/status checks so
   * that bets placed before locks_at are not rejected due to network latency
   * causing the request to arrive after the market transitions to "locked".
   * Subject to clock-skew and max-latency validation on the server side.
   */
  clientBetAt: z.number().int().positive().optional(),
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
export type DestinationInput = z.infer<typeof destinationInputSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatInputSchema>;
export type LocationPoint = z.infer<typeof locationPointSchema>;
export type LocationBatchInput = z.infer<typeof locationBatchInputSchema>;
export type LeadVehicleTelemetryEventInput = z.infer<
  typeof leadVehicleTelemetryEventSchema
>;
export type LeadVehicleEventsInput = z.infer<typeof leadVehicleEventsInputSchema>;
export type ProposeMarketInput = z.infer<typeof proposeMarketInputSchema>;
export type PlaceLiveBetInput = z.infer<typeof placeLiveBetInputSchema>;
export type MarketOption = z.infer<typeof marketOptionSchema>;
export type CamtokBehaviorProfileUpdateInput = z.infer<typeof camtokBehaviorProfileUpdateSchema>;
export type CamtokSafetyProfileUpdateInput = z.infer<typeof camtokSafetyProfileUpdateSchema>;
