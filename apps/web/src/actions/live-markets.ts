"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  proposeMarketInputSchema,
  placeLiveBetInputSchema,
  type ProposeMarketInput,
  type PlaceLiveBetInput,
  Markets,
  Safety,
  RouteState,
  type TransportMode,
  type LiveMarketOption,
} from "@bettok/live";

/**
 * Propose a user market on top of the current live room context.
 * Validates lexically (V1) and writes a pending proposal; owner/moderator
 * can convert it into a live market via convertProposalToMarket (TBD).
 */
export async function proposeUserMarket(input: ProposeMarketInput) {
  unstable_noStore();

  const parsed = proposeMarketInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const service = await createServiceClient();
  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id")
    .eq("id", parsed.data.roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };

  const { data: session } = await service
    .from("character_live_sessions")
    .select("transport_mode")
    .eq("id", (room as { live_session_id: string }).live_session_id)
    .maybeSingle();
  if (!session) return { error: "Session not found" };
  const mode = (session as { transport_mode: TransportMode }).transport_mode;
  const policy = Safety.policyFor(mode);
  const validation = Markets.validateUserMarket(parsed.data, policy);
  if (!validation.ok) {
    await service.from("user_market_proposals").insert({
      room_id: parsed.data.roomId,
      live_session_id: (room as { live_session_id: string }).live_session_id,
      proposer_user_id: user.id,
      title: parsed.data.title,
      option_set: parsed.data.options,
      status: "rejected",
      rejection_reason: validation.reason,
      validation_notes: validation.notes,
    });
    return { error: validation.reason };
  }

  const { data: proposal, error } = await service
    .from("user_market_proposals")
    .insert({
      room_id: parsed.data.roomId,
      live_session_id: (room as { live_session_id: string }).live_session_id,
      proposer_user_id: user.id,
      title: parsed.data.title,
      option_set: parsed.data.options,
      status: policy.requireOwnerApproval ? "submitted" : "validated",
      validation_notes: validation.notes,
    })
    .select("*")
    .single();

  if (error || !proposal) return { error: error?.message ?? "Propose failed" };
  return { proposalId: proposal.id, status: (proposal as { status: string }).status };
}

export async function placeLiveBet(input: PlaceLiveBetInput) {
  unstable_noStore();

  const parsed = placeLiveBetInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const service = await createServiceClient();
  const { data: market } = await service
    .from("live_betting_markets")
    .select("id, room_id, status, locks_at, option_set")
    .eq("id", parsed.data.marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };

  if ((market as { status: string }).status !== "open") {
    return { error: "Market not open" };
  }
  const locksAt = new Date((market as { locks_at: string }).locks_at).getTime();
  if (Date.now() >= locksAt) {
    return { error: "Market has locked" };
  }

  const options = (market as { option_set: LiveMarketOption[] }).option_set;
  if (!options.some((o) => o.id === parsed.data.optionId)) {
    return { error: "Invalid option" };
  }

  if (parsed.data.stakeAmount > 50) {
    return { error: "Stake too high (max 50 for now)" };
  }

  const { data: walletRow } = await service
    .from("wallets")
    .select("balance_demo")
    .eq("user_id", user.id)
    .maybeSingle();
  const balance = (walletRow as { balance_demo: number } | null)?.balance_demo ?? 0;
  if (balance < parsed.data.stakeAmount) {
    return { error: "Insufficient balance" };
  }

  const { error: betError, data: bet } = await service
    .from("live_bets")
    .insert({
      market_id: parsed.data.marketId,
      room_id: (market as { room_id: string }).room_id,
      user_id: user.id,
      option_id: parsed.data.optionId,
      stake_amount: parsed.data.stakeAmount,
      status: "active",
    })
    .select("*")
    .single();
  if (betError || !bet) return { error: betError?.message ?? "Bet failed" };

  await service
    .from("wallets")
    .update({ balance_demo: balance - parsed.data.stakeAmount })
    .eq("user_id", user.id);

  await service.from("live_room_events").insert({
    room_id: (market as { room_id: string }).room_id,
    market_id: parsed.data.marketId,
    event_type: "bet_placed",
    payload: { optionId: parsed.data.optionId, stakeAmount: parsed.data.stakeAmount },
  });

  const { data: currentMarket } = await service
    .from("live_betting_markets")
    .select("total_bet_amount, participant_count")
    .eq("id", parsed.data.marketId)
    .maybeSingle();
  if (currentMarket) {
    await service
      .from("live_betting_markets")
      .update({
        total_bet_amount:
          (currentMarket as { total_bet_amount: number }).total_bet_amount +
          parsed.data.stakeAmount,
        participant_count:
          (currentMarket as { participant_count: number }).participant_count + 1,
      })
      .eq("id", parsed.data.marketId);
  }

  return { betId: bet.id };
}

type MarketDraftOption = {
  id: string;
  label: string;
  shortLabel?: string | null;
  odds?: number | null;
  displayOrder: number;
};

type MarketDraft = {
  title: string;
  subtitle?: string | null;
  marketType: string;
  options: MarketDraftOption[];
};

function buildMidRangeMarketDraft(
  baseDraft: MarketDraft,
  characterName: string,
  templateIdx: number,
): MarketDraft {
  if (templateIdx === 0) {
    return {
      ...baseDraft,
      title: `Which route does ${characterName} take?`,
      subtitle: "Route choice prediction",
      marketType: "route_choice",
      options: baseDraft.options.map((o) => ({
        ...o,
        label:
          o.id === "straight"
            ? "Main road"
            : o.id === "left"
              ? "Side street left"
              : "Side street right",
        shortLabel:
          o.id === "straight" ? "Main" : o.id === "left" ? "Side L" : "Side R",
      })),
    };
  }
  // Template 1: continue vs turn
  return {
    ...baseDraft,
    title: `Does ${characterName} continue or take a turn?`,
    subtitle: null,
    marketType: "continue_vs_turn",
    options: baseDraft.options.map((o) => ({
      ...o,
      label: o.id === "straight" ? "Continue straight" : "Take a turn",
      shortLabel: o.id === "straight" ? "Straight" : "Turn",
    })),
  };
}

export async function openSystemMarketForRoom(roomId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: room } = await service
    .from("live_rooms")
    .select("id, live_session_id, phase, current_market_id")
    .eq("id", roomId)
    .maybeSingle();
  if (!room) return { error: "Room not found" };
  if ((room as { phase: string }).phase === "market_open") {
    return { error: "Market already open" };
  }

  const sessionId = (room as { live_session_id: string }).live_session_id;

  const { data: sessionRow } = await service
    .from("character_live_sessions")
    .select("transport_mode, character_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!sessionRow) return { error: "Session not found" };

  const transportMode = (sessionRow as { transport_mode: TransportMode }).transport_mode;
  const characterId = (sessionRow as { character_id: string }).character_id;

  const { data: characterRow } = await service
    .from("characters")
    .select("name")
    .eq("id", characterId)
    .maybeSingle();
  const characterName = (characterRow as { name: string } | null)?.name ?? "character";

  const policy = Safety.policyFor(transportMode);
  if (!policy.allowSystemMarkets) {
    return { error: "System markets disabled for this mode" };
  }

  const { data: recent } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, speed_mps, heading_deg, accuracy_meters, transport_mode")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(10);
  if (!recent || recent.length < 3) {
    return { error: "Not enough route data yet" };
  }

  const points = [...recent].reverse().map((r) => ({
    recordedAt: r.recorded_at as string,
    lat: r.normalized_lat as number,
    lng: r.normalized_lng as number,
    speedMps: (r.speed_mps as number | null) ?? undefined,
    headingDeg: (r.heading_deg as number | null) ?? undefined,
    accuracyMeters: (r.accuracy_meters as number | null) ?? undefined,
    normalizedLat: r.normalized_lat as number,
    normalizedLng: r.normalized_lng as number,
    confidence: 0.8,
    discarded: false,
  }));

  const decision = RouteState.detectNextDecision(points, transportMode);
  if (!decision) return { error: "No decision node detected" };

  // Enforce minimum spacing between betting crosses. If the last market in
  // this room opened or settled recently we skip — a fresh market every
  // crossroad is noise when intersections are dense (one-way clusters etc).
  {
    const { data: prevMkt } = await service
      .from("live_betting_markets")
      .select("opens_at, reveal_at, status")
      .eq("room_id", roomId)
      .order("opens_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevMkt) {
      const nowMs = Date.now();
      const prevRevealMs = (prevMkt as { reveal_at: string | null }).reveal_at
        ? Date.parse((prevMkt as { reveal_at: string }).reveal_at)
        : null;
      const prevOpensMs = Date.parse((prevMkt as { opens_at: string }).opens_at);
      const referenceMs = Number.isFinite(prevRevealMs as number)
        ? (prevRevealMs as number)
        : prevOpensMs;
      // 12 s minimum gap between any two markets in the same room.
      if (Number.isFinite(referenceMs) && nowMs - referenceMs < 12_000) {
        return { error: "Spacing: previous decision too recent" };
      }
    }
  }

  // Count settled markets to vary framing: every 3rd market use a mid-range template
  const { count: settledCount } = await service
    .from("live_betting_markets")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId)
    .in("status", ["settled", "cancelled"]);

  const baseDraft = RouteState.buildMarketDraftFromOptions(
    characterName,
    transportMode,
    decision.options,
  ) as MarketDraft;

  const midRangeIdx = ((settledCount ?? 0) % 3) === 2 ? (decision.options.length > 2 ? 0 : 1) : -1;
  const draft = midRangeIdx >= 0
    ? buildMidRangeMarketDraft(baseDraft, characterName, midRangeIdx)
    : baseDraft;

  // Project the real turn point from the latest GPS position + heading + distance
  const latestGps = points[points.length - 1];
  const headingRad = ((latestGps.headingDeg ?? 0) * Math.PI) / 180;
  const dist = Math.max(15, Math.min(400, decision.triggerDistanceMeters));
  const turnPointLat =
    latestGps.lat + (Math.cos(headingRad) * dist) / 111_320;
  const turnPointLng =
    latestGps.lng +
    (Math.sin(headingRad) * dist) /
      (111_320 * Math.cos((latestGps.lat * Math.PI) / 180));

  // Compute a speed-adaptive betting window. The product contract is:
  //   · bets stay open 4-8 s after the dot appears
  //   · bets close 4-8 s before the turn so the driver has a clear runway
  // The decision detector gives us `triggerEtaSeconds` (total time to the
  // turn). We split that budget between a bet-open window and a pre-turn
  // buffer. If the detector's ETA is too short for a safe split we bail —
  // better to skip than to open a market the driver can't react to.
  const speedMps = latestGps.speedMps ?? 0;
  const { betOpenSec, preTurnBufferSec } = (() => {
    if (speedMps > 12) return { betOpenSec: 4, preTurnBufferSec: 8 }; // fast car
    if (speedMps > 6) return { betOpenSec: 5, preTurnBufferSec: 6 }; // city drive
    if (speedMps > 2) return { betOpenSec: 6, preTurnBufferSec: 5 }; // bike / scooter
    return { betOpenSec: 5, preTurnBufferSec: 4 }; // walking / crawl
  })();
  const minTotal = betOpenSec + preTurnBufferSec;
  if (decision.triggerEtaSeconds < minTotal) {
    return { error: "ETA too short for safe betting window" };
  }
  // Anchor the lock to the turn minus the pre-turn buffer. This keeps the
  // promised "bets close N s before the turn" contract even when the
  // detector picks an ETA longer than betOpenSec + preTurnBufferSec.
  const effectiveBetOpenSec = Math.max(
    betOpenSec,
    decision.triggerEtaSeconds - preTurnBufferSec,
  );
  const now = new Date();
  const opensAt = now;
  const locksAtMs = now.getTime() + effectiveBetOpenSec * 1000;
  const locksAt = new Date(locksAtMs);
  // Reveal lines up with the expected turn completion so UI drops the rail
  // shortly after the driver passes the point.
  const revealAt = new Date(
    now.getTime() + (decision.triggerEtaSeconds + 2) * 1000,
  );

  const { data: decisionRow, error: decisionError } = await service
    .from("route_decision_nodes")
    .insert({
      live_session_id: sessionId,
      current_node_id: decision.currentNodeId,
      current_edge_id: decision.currentEdgeId ?? null,
      trigger_distance_meters: decision.triggerDistanceMeters,
      trigger_eta_seconds: decision.triggerEtaSeconds,
      option_count: decision.options.length,
      options: decision.options,
      status: "open",
      safety_level: policy.safetyLevel,
    })
    .select("*")
    .single();
  if (decisionError || !decisionRow) {
    return { error: decisionError?.message ?? "decision_insert_failed" };
  }

  const { data: market, error: marketError } = await service
    .from("live_betting_markets")
    .insert({
      room_id: roomId,
      live_session_id: sessionId,
      decision_node_id: decisionRow.id,
      source: "system_generated",
      title: draft.title,
      subtitle: draft.subtitle ?? null,
      market_type: draft.marketType,
      option_set: draft.options,
      opens_at: opensAt.toISOString(),
      locks_at: locksAt.toISOString(),
      reveal_at: revealAt.toISOString(),
      status: "open",
      turn_point_lat: turnPointLat,
      turn_point_lng: turnPointLng,
    })
    .select("*")
    .single();
  if (marketError || !market) {
    return { error: marketError?.message ?? "market_insert_failed" };
  }

  await service.from("live_rooms").update({
    phase: "market_open",
    current_market_id: market.id,
    last_event_at: now.toISOString(),
  }).eq("id", roomId);

  await service.from("live_room_events").insert({
    room_id: roomId,
    market_id: market.id,
    event_type: "market_open",
    payload: { title: draft.title, optionCount: draft.options.length },
  });

  return { marketId: market.id };
}
