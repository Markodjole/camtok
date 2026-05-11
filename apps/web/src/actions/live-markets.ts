"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { metersBetween } from "@/lib/live/routing/geometry";
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
import {
  distanceToCurrentCellEdgeMeters,
  isValidGridOptionForSpec,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { LIVE_BET_LOCK_DISTANCE_M } from "@/lib/live/liveBetLockDistance";
import { liveBetRelaxServer } from "@/lib/live/liveBetRelax";
import {
  MIN_MARKET_OPEN_MS_BEFORE_LOCK,
  MIN_MS_BETWEEN_SYSTEM_MARKETS,
} from "@/lib/live/liveBetMinOpenMs";
import { buildServerClickSnapshot } from "@/lib/live/betting/clickSnapshot";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";

/** See `@/lib/live/liveBetLockDistance` — shared with tick route + viewer UI. */
const BET_LOCK_DISTANCE_M = LIVE_BET_LOCK_DISTANCE_M;

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
    .select(
      "id, room_id, status, opens_at, locks_at, option_set, turn_point_lat, turn_point_lng, live_session_id, market_type, city_grid_spec",
    )
    .eq("id", parsed.data.marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };

  const marketStatus = (market as { status: string }).status;
  /**
   * While we're tuning the bet cycle, accept bets on markets that have just
   * `locked` too — viewers regularly tap an option a hair after the 5s lock
   * fires, the market is moments from settle. Cancelled / settled still
   * return an error so payouts cannot be double-touched.
   */
  if (marketStatus !== "open") {
    if (!(liveBetRelaxServer() && marketStatus === "locked")) {
      return { error: "Market not open" };
    }
  }
  const roomIdForRoom = (market as { room_id: string }).room_id;
  const opensAtMs = Date.parse((market as { opens_at: string }).opens_at);
  const insideOpenGrace =
    Number.isFinite(opensAtMs) &&
    Date.now() < opensAtMs + MIN_MARKET_OPEN_MS_BEFORE_LOCK;
  const locksAt = new Date((market as { locks_at: string }).locks_at).getTime();
  const marketType = (market as { market_type?: string }).market_type ?? "";
  if (
    !liveBetRelaxServer() &&
    !insideOpenGrace &&
    Date.now() >= locksAt
  ) {
    return { error: "Market has locked" };
  }

  // Distance gate with per-bet thresholds:
  // - next_turn (turn-point markets): lock at <= 70 m before turn/pin
  // - time_vs_google: lock at <= 160 m to next pin
  // - next_zone (city_grid): lock when <= 60 m from current cell edge
  const turnLat = (market as { turn_point_lat: number | null }).turn_point_lat;
  const turnLng = (market as { turn_point_lng: number | null }).turn_point_lng;
  const sessionId = (market as { live_session_id: string | null }).live_session_id;

  const { data: latestGpsRow } = sessionId
    ? await service
        .from("live_route_snapshots")
        .select(
          "normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg,speed_mps,confidence_score",
        )
        .eq("live_session_id", sessionId)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  if (
    !liveBetRelaxServer() &&
    !insideOpenGrace &&
    turnLat != null &&
    turnLng != null &&
    sessionId &&
    latestGpsRow
  ) {
    const gps = latestGpsRow as {
      normalized_lat: number | null;
      normalized_lng: number | null;
      raw_lat: number;
      raw_lng: number;
      heading_deg: number | null;
      speed_mps: number | null;
      confidence_score: number | null;
    };
    const lat = gps.normalized_lat ?? gps.raw_lat;
    const lng = gps.normalized_lng ?? gps.raw_lng;
    const dist = metersBetween(
      { lat, lng },
      { lat: turnLat, lng: turnLng },
    );
    if (dist <= 70) {
      return { error: "Too close to turn — betting closed" };
    }
  }

  const gridSpec = (market as { city_grid_spec: CityGridSpecCompact | null })
    .city_grid_spec;
  if (!liveBetRelaxServer() && !insideOpenGrace && latestGpsRow) {
    const gps = latestGpsRow as {
      normalized_lat: number | null;
      normalized_lng: number | null;
      raw_lat: number;
      raw_lng: number;
    };
    const lat = gps.normalized_lat ?? gps.raw_lat;
    const lng = gps.normalized_lng ?? gps.raw_lng;

    if (marketType === "time_vs_google") {
      const drv = await computeDriverRouteInstruction(roomIdForRoom);
      const pinDist = drv.instruction?.pins?.[0]?.distanceMeters ?? null;
      if (pinDist != null && pinDist <= 160) {
        return { error: "Too close to next pin — betting closed" };
      }
    }

    if (marketType === "city_grid" && gridSpec) {
      const edgeM = distanceToCurrentCellEdgeMeters(gridSpec, lat, lng);
      if (edgeM != null && edgeM <= 60) {
        return { error: "Too close to zone edge — betting closed" };
      }
    }
  }
  if (marketType === "city_grid") {
    if (!gridSpec || !isValidGridOptionForSpec(gridSpec, parsed.data.optionId)) {
      return { error: "Invalid grid square" };
    }
  } else {
    const options = (market as { option_set: LiveMarketOption[] }).option_set;
    if (!options.some((o) => o.id === parsed.data.optionId)) {
      return { error: "Invalid option" };
    }
  }

  if (parsed.data.stakeAmount > 50) {
    return { error: "Stake too high (max 50 for now)" };
  }

  let nextPinId: string | null = null;
  try {
    const drv = await computeDriverRouteInstruction(roomIdForRoom);
    if (drv.instruction?.pins[0]) {
      nextPinId = String(drv.instruction.pins[0].id);
    }
  } catch {
    /* optional enrichment */
  }

  let clickSnapshot: ReturnType<typeof buildServerClickSnapshot> | null = null;
  if (sessionId && latestGpsRow) {
    const s = latestGpsRow as {
      normalized_lat: number | null;
      normalized_lng: number | null;
      raw_lat: number;
      raw_lng: number;
      heading_deg: number | null;
      speed_mps: number | null;
      confidence_score: number | null;
    };
    const lat = s.normalized_lat ?? s.raw_lat;
    const lng = s.normalized_lng ?? s.raw_lng;
    clickSnapshot = buildServerClickSnapshot({
      lat,
      lng,
      headingDeg: s.heading_deg,
      speedMps: s.speed_mps != null ? Number(s.speed_mps) : null,
      confidenceScore: s.confidence_score,
      turnPoint:
        turnLat != null && turnLng != null
          ? { lat: turnLat, lng: turnLng }
          : null,
      nextPinId,
    });
  }

  const { data: walletRow } = await service
    .from("wallets")
    .select("balance_demo, balance")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!walletRow) {
    return {
      error:
        "No wallet on file — open the Wallet page once while signed in, then try again.",
    };
  }

  const row = walletRow as { balance_demo: unknown; balance: unknown };
  const demoRaw = row.balance_demo;
  const mainRaw = row.balance;
  const toNum = (v: unknown) =>
    v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0;

  const stake = parsed.data.stakeAmount;
  let balanceDemo = toNum(demoRaw);
  const balanceMain = toNum(mainRaw);

  // Live bets only debit balance_demo. If demo is stale/zero but main covers the
  // stake, sync once so funded users aren’t blocked after top-ups that only touched balance.
  if (balanceDemo < stake && balanceMain >= stake) {
    const { error: syncErr } = await service
      .from("wallets")
      .update({ balance_demo: balanceMain })
      .eq("user_id", user.id);
    if (syncErr) {
      console.error("[placeLiveBet] balance_demo sync failed", syncErr, {
        userId: user.id,
      });
    } else {
      balanceDemo = balanceMain;
    }
  }

  if (balanceDemo < stake) {
    return {
      error: `Insufficient balance: $${balanceDemo.toFixed(2)} available for live (demo wallet), $${stake.toFixed(2)} needed.`,
    };
  }

  const newDemo = balanceDemo - stake;

  const { error: betError, data: bet } = await service
    .from("live_bets")
    .insert({
      market_id: parsed.data.marketId,
      room_id: (market as { room_id: string }).room_id,
      user_id: user.id,
      option_id: parsed.data.optionId,
      stake_amount: parsed.data.stakeAmount,
      status: "active",
      click_snapshot: clickSnapshot,
    })
    .select("*")
    .single();
  if (betError || !bet) {
    const raw = betError?.message ?? "Bet failed";
    if (
      betError?.code === "23505" ||
      raw.includes("idx_live_bets_one_per_user_per_market") ||
      raw.toLowerCase().includes("duplicate key")
    ) {
      return { error: "You already placed a bet on this market." };
    }
    return { error: raw };
  }

  await service
    .from("wallets")
    .update({ balance_demo: newDemo })
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

  return { betId: bet.id, clickSnapshot };
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
  if (!recent || recent.length < 2) {
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
      .select("opens_at")
      .eq("room_id", roomId)
      .order("opens_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prevMkt) {
      const nowMs = Date.now();
      const prevOpensMs = Date.parse((prevMkt as { opens_at: string }).opens_at);
      if (
        Number.isFinite(prevOpensMs) &&
        nowMs - prevOpensMs < MIN_MS_BETWEEN_SYSTEM_MARKETS
      ) {
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

  // Project the real turn point from the latest GPS position + heading.
  //
  // Device heading is unreliable at low speed or when the OS stops reporting
  // a compass value (common on phones in cars). Previously we fell back to
  // heading = 0 (due north) which caused the blue dot / rails to appear in
  // the opposite direction of travel. We instead derive heading from the
  // actual path: walk backwards through the recent points until we've
  // accumulated at least ~6 m of displacement, then take that vector as the
  // movement bearing. Only fall back to the GPS-reported heading if the
  // vehicle really hasn't moved.
  const latestGps = points[points.length - 1];

  const metersBetweenPoints = (
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
  ): number => {
    const latAvg = (a.lat + b.lat) / 2;
    const dy = (b.lat - a.lat) * 111_320;
    const dx =
      (b.lng - a.lng) * 111_320 * Math.cos((latAvg * Math.PI) / 180);
    return Math.hypot(dx, dy);
  };
  const bearingDeg = (
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
  ): number => {
    const aLatRad = (a.lat * Math.PI) / 180;
    const bLatRad = (b.lat * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(bLatRad);
    const x =
      Math.cos(aLatRad) * Math.sin(bLatRad) -
      Math.sin(aLatRad) * Math.cos(bLatRad) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };

  // Find the furthest-back point that still sits within ~12 s of the latest
  // so we capture recent motion, not ancient history. Require ≥ 6 m of
  // displacement to build a reliable bearing.
  let motionBearing: number | null = null;
  const latestTime = Date.parse(latestGps.recordedAt);
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const p = points[i]!;
    const age = Number.isFinite(latestTime)
      ? (latestTime - Date.parse(p.recordedAt)) / 1000
      : 0;
    if (age > 12) break;
    const d = metersBetweenPoints(p, latestGps);
    if (d >= 6) {
      motionBearing = bearingDeg(p, latestGps);
      break;
    }
  }

  // Final heading preference: motion-derived > device-reported > skip.
  let headingDeg: number;
  if (motionBearing != null) {
    headingDeg = motionBearing;
  } else if (
    latestGps.headingDeg != null &&
    Number.isFinite(latestGps.headingDeg) &&
    (latestGps.speedMps ?? 0) > 1.0
  ) {
    headingDeg = latestGps.headingDeg;
  } else {
    // Vehicle effectively stationary — do not open a market because we
    // cannot place the turn point in a meaningful direction.
    return { error: "Vehicle stationary: cannot determine heading" };
  }

  const headingRad = (headingDeg * Math.PI) / 180;
  const dist = Math.max(15, Math.min(400, decision.triggerDistanceMeters));
  // Standard compass-bearing projection: 0° = north (↑ lat), 90° = east (↑ lng).
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
  // The "betting window" is now driven by *distance* — bets close when
  // the vehicle reaches `BET_LOCK_DISTANCE_M` from the turn point
  // (handled in the tick route + placeLiveBet). We still need a
  // `locks_at` timestamp because downstream code (state machine, UI
  // countdown) depends on it, but we set it to a generous upper bound
  // so the distance-based trigger fires first under normal driving. If
  // the distance trigger never fires (e.g. GPS lost, vehicle stopped),
  // this acts as a safety timeout.
  const relax = liveBetRelaxServer();
  const effectiveBetOpenSec = Math.max(
    betOpenSec,
    decision.triggerEtaSeconds - preTurnBufferSec,
    relax ? 3600 : 600,
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
