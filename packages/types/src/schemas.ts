import { z } from "zod";
import {
  ClipNodeStatus,
  ClipSourceType,
  BetStatus,
  PredictionStatus,
  ContinuationJobStatus,
  WalletTransactionType,
  MarketSideKey,
  NotificationType,
  UserRole,
  Genre,
  Tone,
  RealismLevel,
} from "./enums";

// ─── Profile ──────────────────────────────────────────────────

export const profileSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(3).max(30),
  display_name: z.string().min(1).max(60),
  avatar_path: z.string().nullable(),
  bio: z.string().max(300).nullable(),
  country_code: z.string().length(2).nullable(),
  wallet_visibility: z.enum(["public", "private"]).default("private"),
  preferred_language: z.string().default("en"),
  notification_preferences: z
    .object({
      in_app: z.boolean().default(true),
      push: z.boolean().default(false),
    })
    .default({}),
  role: z.nativeEnum(UserRole).default("viewer"),
  total_bets: z.number().int().default(0),
  total_wins: z.number().int().default(0),
  total_predictions: z.number().int().default(0),
  /** User-owned character used like default seeded characters (same clip / prediction stack). */
  primary_character_id: z.string().uuid().nullable().optional(),
  character_onboarding_completed_at: z.string().datetime().nullable().optional(),
  character_onboarding_draft: z.record(z.unknown()).nullish(),
  created_at: z.string().datetime(),
});

export type Profile = z.infer<typeof profileSchema>;

export const profileUpdateSchema = profileSchema
  .pick({
    display_name: true,
    bio: true,
    country_code: true,
    wallet_visibility: true,
    preferred_language: true,
    notification_preferences: true,
  })
  .partial();

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

// ─── Wallet ───────────────────────────────────────────────────

export const walletSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  balance: z.number().default(0),
  balance_demo: z.number().default(0),
  total_deposited: z.number().default(0),
  total_withdrawn: z.number().default(0),
  total_won: z.number().default(0),
  total_lost: z.number().default(0),
  created_at: z.string().datetime(),
});

export type Wallet = z.infer<typeof walletSchema>;

export const walletTransactionSchema = z.object({
  id: z.string().uuid(),
  wallet_id: z.string().uuid(),
  type: z.nativeEnum(WalletTransactionType),
  amount: z.number(),
  balance_after: z.number(),
  reference_type: z.string().nullable(),
  reference_id: z.string().uuid().nullable(),
  description: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string().datetime(),
});

export type WalletTransaction = z.infer<typeof walletTransactionSchema>;

export const walletHoldSchema = z.object({
  id: z.string().uuid(),
  wallet_id: z.string().uuid(),
  bet_id: z.string().uuid(),
  amount: z.number().positive(),
  status: z.enum(["active", "released", "converted"]),
  created_at: z.string().datetime(),
  released_at: z.string().datetime().nullable(),
});

export type WalletHold = z.infer<typeof walletHoldSchema>;

// ─── Story & Clip ─────────────────────────────────────────────

export const storySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  genre: z.nativeEnum(Genre).nullable(),
  tone: z.nativeEnum(Tone).nullable(),
  realism_level: z.nativeEnum(RealismLevel).nullable(),
  creator_user_id: z.string().uuid(),
  root_clip_node_id: z.string().uuid().nullable(),
  max_depth: z.number().int().default(0),
  total_bets: z.number().int().default(0),
  total_clips: z.number().int().default(1),
  created_at: z.string().datetime(),
});

export type Story = z.infer<typeof storySchema>;

export const clipNodeSchema = z.object({
  id: z.string().uuid(),
  story_id: z.string().uuid(),
  parent_clip_node_id: z.string().uuid().nullable(),
  depth: z.number().int().default(0),
  creator_user_id: z.string().uuid(),
  source_type: z.nativeEnum(ClipSourceType),
  status: z.nativeEnum(ClipNodeStatus),
  video_storage_path: z.string().nullable(),
  poster_storage_path: z.string().nullable(),
  transcript: z.string().nullable(),
  scene_summary: z.string().nullable(),
  genre: z.nativeEnum(Genre).nullable(),
  tone: z.nativeEnum(Tone).nullable(),
  realism_level: z.nativeEnum(RealismLevel).nullable(),
  pause_start_ms: z.number().int().nullable(),
  pause_end_ms: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  betting_deadline: z.string().datetime().nullable(),
  view_count: z.number().int().default(0),
  bet_count: z.number().int().default(0),
  created_at: z.string().datetime(),
  published_at: z.string().datetime().nullable(),
});

export type ClipNode = z.infer<typeof clipNodeSchema>;

// ─── Prediction Markets ───────────────────────────────────────

export const predictionMarketSchema = z.object({
  id: z.string().uuid(),
  clip_node_id: z.string().uuid(),
  raw_creator_input: z.string(),
  canonical_text: z.string(),
  market_key: z.string(),
  schema_version: z.number().int().default(1),
  normalization_confidence: z.number().min(0).max(1),
  normalization_explanation: z.string().nullable(),
  created_by_user_id: z.string().uuid(),
  status: z.nativeEnum(PredictionStatus),
  created_at: z.string().datetime(),
});

export type PredictionMarket = z.infer<typeof predictionMarketSchema>;

export const marketSideSchema = z.object({
  id: z.string().uuid(),
  prediction_market_id: z.string().uuid(),
  side_key: z.nativeEnum(MarketSideKey),
  current_odds_decimal: z.number().positive(),
  probability: z.number().min(0).max(1),
  pool_amount: z.number().default(0),
  bet_count: z.number().int().default(0),
  created_at: z.string().datetime(),
});

export type MarketSide = z.infer<typeof marketSideSchema>;

// ─── Bets ─────────────────────────────────────────────────────

export const betSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  clip_node_id: z.string().uuid(),
  prediction_market_id: z.string().uuid(),
  market_side_id: z.string().uuid(),
  side_key: z.nativeEnum(MarketSideKey),
  stake_amount: z.number().positive(),
  odds_at_bet: z.number().positive(),
  available_balance_snapshot: z.number(),
  status: z.nativeEnum(BetStatus),
  payout_amount: z.number().nullable(),
  created_at: z.string().datetime(),
  locked_at: z.string().datetime().nullable(),
  settled_at: z.string().datetime().nullable(),
});

export type Bet = z.infer<typeof betSchema>;

// ─── Odds ─────────────────────────────────────────────────────

export const oddsSnapshotSchema = z.object({
  id: z.string().uuid(),
  prediction_market_id: z.string().uuid(),
  clip_node_id: z.string().uuid(),
  probability_yes: z.number().min(0).max(1),
  probability_no: z.number().min(0).max(1),
  decimal_odds_yes: z.number().positive(),
  decimal_odds_no: z.number().positive(),
  reasoning_short: z.string(),
  reasoning_detailed: z.string().nullable(),
  plausibility_score: z.number().min(0).max(1),
  cinematic_score: z.number().min(0).max(1),
  surprise_score: z.number().min(0).max(1),
  retention_score: z.number().min(0).max(1),
  rejected_for_story_break: z.boolean().default(false),
  llm_run_id: z.string().uuid().nullable(),
  prompt_version: z.string(),
  algorithm_version: z.string(),
  created_at: z.string().datetime(),
});

export type OddsSnapshot = z.infer<typeof oddsSnapshotSchema>;

// ─── Continuation ─────────────────────────────────────────────

export const continuationJobSchema = z.object({
  id: z.string().uuid(),
  clip_node_id: z.string().uuid(),
  status: z.nativeEnum(ContinuationJobStatus),
  continuation_summary: z.string().nullable(),
  accepted_predictions: z.array(z.string()).nullable(),
  rejected_predictions: z.array(z.string()).nullable(),
  partially_matched: z.array(z.string()).nullable(),
  media_prompt: z.string().nullable(),
  scene_explanation: z.string().nullable(),
  result_clip_node_id: z.string().uuid().nullable(),
  llm_run_id: z.string().uuid().nullable(),
  error_message: z.string().nullable(),
  attempts: z.number().int().default(0),
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
});

export type ContinuationJob = z.infer<typeof continuationJobSchema>;

// ─── Settlement ───────────────────────────────────────────────

export const settlementResultSchema = z.object({
  id: z.string().uuid(),
  clip_node_id: z.string().uuid(),
  continuation_clip_node_id: z.string().uuid(),
  algorithm_version: z.string(),
  llm_run_id: z.string().uuid().nullable(),
  summary: z.string(),
  settled_at: z.string().datetime(),
});

export type SettlementResult = z.infer<typeof settlementResultSchema>;

export const settlementSideResultSchema = z.object({
  id: z.string().uuid(),
  settlement_result_id: z.string().uuid(),
  prediction_market_id: z.string().uuid(),
  yes_correctness: z.number().min(0).max(1),
  no_correctness: z.number().min(0).max(1),
  winner_side: z.nativeEnum(MarketSideKey).nullable(),
  strength: z.number().min(0).max(1),
  transfer_amount: z.number(),
  explanation_short: z.string(),
  explanation_long: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence_bullets: z.array(z.string()).nullable(),
});

export type SettlementSideResult = z.infer<
  typeof settlementSideResultSchema
>;

// ─── LLM Logging ──────────────────────────────────────────────

export const llmRunSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  model: z.string(),
  purpose: z.enum([
    "normalization",
    "odds",
    "continuation",
    "settlement",
    "moderation",
  ]),
  prompt_version: z.string(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  latency_ms: z.number().int().nullable(),
  input_snapshot: z.record(z.unknown()),
  output_snapshot: z.record(z.unknown()),
  validated: z.boolean(),
  error: z.string().nullable(),
  created_at: z.string().datetime(),
});

export type LlmRun = z.infer<typeof llmRunSchema>;

// ─── Notifications ────────────────────────────────────────────

export const notificationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  type: z.nativeEnum(NotificationType),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  reference_type: z.string().nullable(),
  reference_id: z.string().uuid().nullable(),
  read: z.boolean().default(false),
  created_at: z.string().datetime(),
});

export type Notification = z.infer<typeof notificationSchema>;

// ─── Reports ──────────────────────────────────────────────────

export const reportSchema = z.object({
  id: z.string().uuid(),
  reporter_user_id: z.string().uuid(),
  target_type: z.enum(["clip", "prediction", "profile", "comment"]),
  target_id: z.string().uuid(),
  reason: z.string(),
  status: z.enum(["pending", "reviewed", "dismissed", "actioned"]),
  moderator_notes: z.string().nullable(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
});

export type Report = z.infer<typeof reportSchema>;

// ─── API DTOs ─────────────────────────────────────────────────

export const createPredictionInput = z.object({
  clip_node_id: z.string().uuid(),
  raw_text: z.string().min(3).max(300),
});

export type CreatePredictionInput = z.infer<typeof createPredictionInput>;

export const placeBetInput = z.object({
  prediction_market_id: z.string().uuid(),
  side_key: z.nativeEnum(MarketSideKey),
  stake_amount: z.number().positive().max(50),
});

export type PlaceBetInput = z.infer<typeof placeBetInput>;

export const createClipInput = z.object({
  title: z.string().min(1).max(200),
  genre: z.nativeEnum(Genre).optional(),
  tone: z.nativeEnum(Tone).optional(),
  realism_level: z.nativeEnum(RealismLevel).optional(),
  pause_start_ms: z.number().int().positive().optional(),
  content_tags: z.array(z.string()).max(10).optional(),
});

export type CreateClipInput = z.infer<typeof createClipInput>;

export const depositInput = z.object({
  amount: z.number().positive().max(100000),
});

export type DepositInput = z.infer<typeof depositInput>;
