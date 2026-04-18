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

  const draft = RouteState.buildMarketDraftFromOptions(
    characterName,
    transportMode,
    decision.options,
  );

  const now = new Date();
  const opensAt = now;
  const locksAtMs = now.getTime() + decision.triggerEtaSeconds * 1000;
  const locksAt = new Date(locksAtMs);
  const revealAt = new Date(locksAtMs + 4000);

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
