"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  Markets,
  RouteState,
  type LiveMarketOption,
  type RouteDecisionOption,
} from "@bettok/live";
import {
  cellIdForPosition,
  parseGridOptionId as parseGridFromId,
  type CityGridSpecCompact,
} from "@/lib/live/grid/cityGrid500";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";

type LockEvidence = {
  currentNodeId: string;
  candidateOptionIds: string[];
  selectedOptionId: string;
  normalizedSnapshotTs: string;
  etaToDecisionSeconds: number | null;
  confidence: number;
};

async function recordDecisionAuditLock(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: {
    liveSessionId: string;
    marketId: string;
    decisionNodeId: string | null;
    routeSnapshotId: string | null;
    commitHash: string;
    evidence: LockEvidence;
  },
) {
  const { data: session } = await service
    .from("character_live_sessions")
    .select("character_id")
    .eq("id", args.liveSessionId)
    .maybeSingle();
  const characterId = (session as { character_id?: string } | null)?.character_id;
  if (!characterId) return;
  await service.from("character_decision_audit_log").insert({
    character_id: characterId,
    live_session_id: args.liveSessionId,
    market_id: args.marketId,
    decision_node_id: args.decisionNodeId,
    route_snapshot_id: args.routeSnapshotId,
    lock_timestamp: new Date().toISOString(),
    commit_hash: args.commitHash,
    gps_confidence_score: args.evidence.confidence,
    evidence_json: args.evidence as unknown as Record<string, unknown>,
  });
}

async function finalizeDecisionAudit(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  marketId: string,
  args: { anomalyFlags?: string[]; operatorIntervention?: boolean },
) {
  await service
    .from("character_decision_audit_log")
    .update({
      reveal_timestamp: new Date().toISOString(),
      anomaly_flags: args.anomalyFlags ?? [],
      operator_intervention_flag: args.operatorIntervention ?? false,
    })
    .eq("market_id", marketId);
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

async function applyBehaviorLearningNudges(
  service: Awaited<ReturnType<typeof createServiceClient>>,
  args: {
    characterId: string;
    winningOptionId: string;
    reason: string;
    settledAt: string;
  },
) {
  const { data: current } = await service
    .from("character_behavior_profiles")
    .select(
      "risk_level_score, prefers_main_roads_score, speed_style_score, hesitation_tendency_score, safest_route_bias_score, exploration_bias_score, history_window_size",
    )
    .eq("character_id", args.characterId)
    .maybeSingle();

  const cur = (current ?? {}) as {
    risk_level_score?: number | null;
    prefers_main_roads_score?: number | null;
    speed_style_score?: number | null;
    hesitation_tendency_score?: number | null;
    safest_route_bias_score?: number | null;
    exploration_bias_score?: number | null;
    history_window_size?: number | null;
  };

  let risk = cur.risk_level_score ?? 0.5;
  let mainRoad = cur.prefers_main_roads_score ?? 0.5;
  let speed = cur.speed_style_score ?? 0.5;
  let hesitation = cur.hesitation_tendency_score ?? 0.5;
  let safeBias = cur.safest_route_bias_score ?? 0.5;
  let explore = cur.exploration_bias_score ?? 0.5;

  const id = args.winningOptionId.toLowerCase();
  const reason = args.reason.toLowerCase();
  const delta = 0.03;

  if (id.includes("left") || id.includes("right") || id.includes("turn")) {
    explore += delta;
    safeBias -= delta * 0.7;
    mainRoad -= delta * 0.5;
  }
  if (id.includes("continue") || id.includes("straight")) {
    safeBias += delta;
    mainRoad += delta * 0.6;
    explore -= delta * 0.6;
  }
  if (id.includes("stop") || id.includes("wait")) {
    hesitation += delta;
    speed -= delta;
    risk -= delta * 0.7;
  }
  if (reason.includes("low_confidence") || reason.includes("ambiguous")) {
    hesitation += delta * 0.8;
  }
  if (reason.includes("high_confidence")) {
    hesitation -= delta * 0.5;
  }

  await service.from("character_behavior_profiles").upsert(
    {
      character_id: args.characterId,
      risk_level_score: clamp01(risk),
      prefers_main_roads_score: clamp01(mainRoad),
      speed_style_score: clamp01(speed),
      hesitation_tendency_score: clamp01(hesitation),
      safest_route_bias_score: clamp01(safeBias),
      exploration_bias_score: clamp01(explore),
      history_window_size: cur.history_window_size ?? 50,
      learned_model_version: "v1-outcome-nudges",
      updated_at: args.settledAt,
    },
    { onConflict: "character_id" },
  );
}

/**
 * Locks an open market: snapshots the current route state, selects a
 * candidate outcome internally for evidence, and records an immutable
 * commit hash. Users' bets cannot change after this point.
 */
export async function lockMarket(marketId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select(
      "id, room_id, live_session_id, status, option_set, decision_node_id, locks_at, market_type, city_grid_spec",
    )
    .eq("id", marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };
  if ((market as { status: string }).status !== "open") {
    return { error: "Market not open" };
  }

  const { data: snapshot } = await service
    .from("live_route_snapshots")
    .select(
      "id, recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
    )
    .eq("live_session_id", (market as { live_session_id: string }).live_session_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const options = (market as { option_set: LiveMarketOption[] }).option_set;
  const marketType = (market as { market_type?: string }).market_type ?? "";
  void marketType;
  void cellIdForPosition;

  /**
   * `selected` is the system's provisional "best guess" outcome stored on
   * the lock record for audit / commit-hash purposes. The real winner is
   * resolved later in `revealAndSettleMarket`. For all three active bet
   * types (`next_turn`, `next_zone`, `zone_exit_time`) the option set is
   * small and bounded; using the first option as the placeholder is fine.
   */
  const selected = options[0]?.id ?? "unknown";

  const candidateOptionIds = options.map((o) => o.id);

  const evidence: LockEvidence = {
    currentNodeId: (snapshot as { id: string } | null)?.id ?? "no_snapshot",
    candidateOptionIds,
    selectedOptionId: selected,
    normalizedSnapshotTs:
      (snapshot as { recorded_at: string } | null)?.recorded_at ??
      new Date().toISOString(),
    etaToDecisionSeconds: null,
    confidence: (snapshot as { confidence_score: number } | null)?.confidence_score ?? 0,
  };
  const commitHash = RouteState.computeCommitHash(evidence);

  await service.from("market_lock_records").insert({
    market_id: marketId,
    selected_option_id: selected,
    candidate_option_ids: candidateOptionIds,
    route_snapshot_id: (snapshot as { id: string } | null)?.id ?? null,
    decision_node_id: (market as { decision_node_id: string | null }).decision_node_id,
    commit_hash: commitHash,
    evidence_json: evidence as unknown as Record<string, unknown>,
  });

  await service
    .from("live_betting_markets")
    .update({
      status: "locked",
      lock_commit_hash: commitHash,
      lock_evidence_json: evidence as unknown as Record<string, unknown>,
    })
    .eq("id", marketId);

  await recordDecisionAuditLock(service, {
    liveSessionId: (market as { live_session_id: string }).live_session_id,
    marketId,
    decisionNodeId: (market as { decision_node_id: string | null }).decision_node_id,
    routeSnapshotId: (snapshot as { id: string } | null)?.id ?? null,
    commitHash,
    evidence,
  });

  await service
    .from("live_rooms")
    .update({ phase: "market_locked", last_event_at: new Date().toISOString() })
    .eq("id", (market as { room_id: string }).room_id);

  await service
    .from("live_bets")
    .update({ status: "locked" })
    .eq("market_id", marketId)
    .eq("status", "active");

  await service.from("live_room_events").insert({
    room_id: (market as { room_id: string }).room_id,
    market_id: marketId,
    event_type: "market_locked",
    payload: { commitHash },
  });

  return { commitHash };
}

/**
 * After reveal window, compare actual committed path against locked
 * options. If ambiguous / low confidence, refund all bets.
 */
export async function revealAndSettleMarket(marketId: string) {
  unstable_noStore();
  const service = await createServiceClient();

  const { data: market } = await service
    .from("live_betting_markets")
    .select(
      "id, room_id, live_session_id, status, option_set, decision_node_id, opens_at, reveal_at, market_type, city_grid_spec, subtitle",
    )
    .eq("id", marketId)
    .maybeSingle();
  if (!market) return { error: "Market not found" };
  if ((market as { status: string }).status !== "locked") {
    return { error: "Market not locked" };
  }

  const marketType = (market as { market_type?: string }).market_type ?? "";
  const gridSpec = (market as { city_grid_spec: CityGridSpecCompact | null })
    .city_grid_spec;

  const revealAtMs = new Date((market as { reveal_at: string }).reveal_at).getTime();
  const since = new Date(revealAtMs - 15_000).toISOString();

  const { data: points } = await service
    .from("live_route_snapshots")
    .select(
      "recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
    )
    .eq("live_session_id", (market as { live_session_id: string }).live_session_id)
    .gte("recorded_at", since)
    .order("recorded_at", { ascending: true });

  const committed = (points ?? []).map((r) => {
    const lat = (r.normalized_lat ?? r.raw_lat) as number;
    const lng = (r.normalized_lng ?? r.raw_lng) as number;
    return {
      recordedAt: r.recorded_at as string,
      lat,
      lng,
      speedMps: (r.speed_mps as number | null) ?? undefined,
      headingDeg: (r.heading_deg as number | null) ?? undefined,
      normalizedLat: lat,
      normalizedLng: lng,
      confidence: (r.confidence_score as number | null) ?? 0.5,
      discarded: false,
    };
  });

  /**
   * `next_turn` (left / straight / right): compare the driver's committed
   * heading change against the bet options. Build a synthetic decision row
   * on the fly so `revealFromMovement` has direction labels to match — the
   * market itself doesn't have a `route_decision_nodes` row because it's
   * gated on pin distance rather than the decision detector.
   */
  if (marketType === "next_turn") {
    const opts = (market as { option_set: LiveMarketOption[] }).option_set;

    /**
     * Pull GPS from the lock moment forward — the settle path fires the
     * instant the driver is within ~15 m of the pin, well before
     * `reveal_at`, so the default `revealAt - 15 s` window would return
     * nothing and refund the bet. We anchor on `opens_at` to capture the
     * pre-pin heading too.
     */
    const opensAtStr = (market as { opens_at?: string }).opens_at;
    let nextTurnCommitted = committed;
    if (opensAtStr) {
      const { data: snaps } = await service
        .from("live_route_snapshots")
        .select(
          "recorded_at, normalized_lat, normalized_lng, raw_lat, raw_lng, speed_mps, heading_deg, confidence_score",
        )
        .eq(
          "live_session_id",
          (market as { live_session_id: string }).live_session_id,
        )
        .gte("recorded_at", opensAtStr)
        .order("recorded_at", { ascending: true })
        .limit(120);
      nextTurnCommitted = (snaps ?? []).map((r) => {
        const lat = (r.normalized_lat ?? r.raw_lat) as number;
        const lng = (r.normalized_lng ?? r.raw_lng) as number;
        return {
          recordedAt: r.recorded_at as string,
          lat,
          lng,
          speedMps: (r.speed_mps as number | null) ?? undefined,
          headingDeg: (r.heading_deg as number | null) ?? undefined,
          normalizedLat: lat,
          normalizedLng: lng,
          confidence: (r.confidence_score as number | null) ?? 0.5,
          discarded: false,
        };
      });
    }

    const syntheticDecision: { options: RouteDecisionOption[] } = {
      options: opts.map((o) => ({
        optionId: o.id,
        label: o.label,
        directionType: o.id as RouteDecisionOption["directionType"],
      })),
    };
    const result = RouteState.revealFromMovement(
      opts,
      syntheticDecision,
      nextTurnCommitted,
    );
    if (result.status !== "matched") {
      await refundMarket(marketId, result.reason);
      return { status: result.status, reason: result.reason };
    }
    return await settleMarketWithWinner(marketId, result.winningOptionId, result.reason);
  }

  if (marketType === "zone_exit_time" && gridSpec) {
    const liveSessionId = (market as { live_session_id: string }).live_session_id;
    const subtitleStr = (market as { subtitle: string | null }).subtitle;
    let startCellKey: string | null = null;
    try {
      const meta = JSON.parse(subtitleStr ?? "{}") as { cellKey?: string | null };
      startCellKey = meta.cellKey ?? null;
    } catch {
      // ignore parse failures — handled below.
    }
    if (!startCellKey) {
      await refundMarket(marketId, "zone_exit_missing_start_cell");
      return { status: "ambiguous", reason: "zone_exit_missing_start_cell" };
    }

    const { data: latestGps } = await service
      .from("live_route_snapshots")
      .select("recorded_at, normalized_lat,normalized_lng,raw_lat,raw_lng")
      .eq("live_session_id", liveSessionId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestGps) {
      await refundMarket(marketId, "zone_exit_no_gps");
      return { status: "insufficient_confidence", reason: "zone_exit_no_gps" };
    }

    const g = latestGps as {
      recorded_at: string;
      normalized_lat: number | null;
      normalized_lng: number | null;
      raw_lat: number;
      raw_lng: number;
    };
    const currentCellId = cellIdForPosition(
      gridSpec,
      g.normalized_lat ?? g.raw_lat,
      g.normalized_lng ?? g.raw_lng,
    );
    const currentCell = currentCellId ? parseGridFromId(currentCellId) : null;
    const currentCellKey =
      currentCell != null ? `cell:r${currentCell.row}:c${currentCell.col}` : null;
    if (!currentCellKey || currentCellKey === startCellKey) {
      await refundMarket(marketId, "zone_exit_still_in_zone");
      return { status: "ambiguous", reason: "zone_exit_still_in_zone" };
    }

    const opensAtMs = new Date((market as { opens_at: string }).opens_at).getTime();
    const exitAtMs = new Date(g.recorded_at).getTime();
    const elapsedSec =
      Number.isFinite(opensAtMs) && Number.isFinite(exitAtMs)
        ? Math.max(0, (exitAtMs - opensAtMs) / 1000)
        : Number.POSITIVE_INFINITY;

    // Read the estimated threshold T stored at market-open time.
    let estimatedSec = 60; // safe fallback
    try {
      const meta = JSON.parse(subtitleStr ?? "{}") as { estimatedSec?: number };
      if (typeof meta.estimatedSec === "number") estimatedSec = meta.estimatedSec;
    } catch {
      // ignore
    }

    // ±20 % window around T → "at"; outside → under / over.
    const lo = estimatedSec * 0.8;
    const hi = estimatedSec * 1.2;
    const winner =
      elapsedSec < lo ? "exit_under" : elapsedSec <= hi ? "exit_at" : "exit_over";

    return await settleMarketWithWinner(
      marketId,
      winner,
      `zone_exit_${Math.round(elapsedSec)}s_est${estimatedSec}s`,
    );
  }

  // Fallback for any future engine bet that does not yet have telemetry logic.
  if (isEngineMarketType(marketType)) {
    const opts = (market as { option_set: LiveMarketOption[] }).option_set;
    if (!opts.length) {
      await refundMarket(marketId, "engine_no_options");
      return { status: "voided", reason: "engine_no_options" };
    }
    const winIdx = Math.floor(Math.random() * opts.length);
    const winId = opts[winIdx]!.id;
    return await settleMarketWithWinner(marketId, winId, "engine_provisional");
  }

  if (marketType === "city_grid" && gridSpec) {
    /**
     * `next_zone`: winning option is the cell the driver is in **right
     * now**, as long as it differs from the start cell captured at open
     * time. Driver still sitting in the start cell when settlement runs →
     * refund (we only call this from the tick once the driver actually
     * crossed out, but `reveal_at` timeout can still hit it stuck inside).
     */
    const liveSessionId = (market as { live_session_id: string })
      .live_session_id;
    const subtitleStr = (market as { subtitle: string | null }).subtitle;
    let startRow: number | null = null;
    let startCol: number | null = null;
    try {
      const meta = JSON.parse(subtitleStr ?? "{}") as {
        startRow?: number;
        startCol?: number;
      };
      startRow = typeof meta.startRow === "number" ? meta.startRow : null;
      startCol = typeof meta.startCol === "number" ? meta.startCol : null;
    } catch {
      // ignore parse failures — start-cell fallback handled below.
    }

    const { data: latestGps } = await service
      .from("live_route_snapshots")
      .select("normalized_lat,normalized_lng,raw_lat,raw_lng")
      .eq("live_session_id", liveSessionId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestGps) {
      await refundMarket(marketId, "city_grid_no_gps");
      return { status: "insufficient_confidence", reason: "city_grid_no_gps" };
    }
    const g = latestGps as {
      normalized_lat: number | null;
      normalized_lng: number | null;
      raw_lat: number;
      raw_lng: number;
    };
    const lat = g.normalized_lat ?? g.raw_lat;
    const lng = g.normalized_lng ?? g.raw_lng;
    const currCellId = cellIdForPosition(gridSpec, lat, lng);
    if (!currCellId) {
      await refundMarket(marketId, "city_grid_outside_cells");
      return { status: "ambiguous", reason: "city_grid_outside_cells" };
    }
    const curr = parseGridFromId(currCellId);
    if (!curr) {
      await refundMarket(marketId, "city_grid_bad_cell_id");
      return { status: "ambiguous", reason: "city_grid_bad_cell_id" };
    }
    if (
      startRow != null &&
      startCol != null &&
      curr.row === startRow &&
      curr.col === startCol
    ) {
      await refundMarket(marketId, "city_grid_still_in_zone");
      return { status: "ambiguous", reason: "city_grid_still_in_zone" };
    }
    return await settleMarketWithWinner(marketId, currCellId, "gps_cell_enter");
  }

  const { data: decision } = await service
    .from("route_decision_nodes")
    .select("options")
    .eq("id", (market as { decision_node_id: string | null }).decision_node_id ?? "")
    .maybeSingle();

  const options = (market as { option_set: LiveMarketOption[] }).option_set;
  const decisionOptions = (decision as { options: RouteDecisionOption[] } | null)?.options ?? [];
  const result = RouteState.revealFromMovement(
    options,
    decisionOptions.length ? { options: decisionOptions } : null,
    committed,
  );

  if (result.status !== "matched") {
    await refundMarket(marketId, result.reason);
    return { status: result.status, reason: result.reason };
  }

  return await settleMarketWithWinner(marketId, result.winningOptionId, result.reason);
}

async function refundMarket(marketId: string, reason: string) {
  const service = await createServiceClient();
  const { data: bets } = await service
    .from("live_bets")
    .select("id, user_id, stake_amount")
    .eq("market_id", marketId)
    .eq("status", "locked");

  for (const b of bets ?? []) {
    const userId = b.user_id as string;
    const stake = b.stake_amount as number;
    const { data: wallet } = await service
      .from("wallets")
      .select("balance_demo")
      .eq("user_id", userId)
      .maybeSingle();
    const newBal = ((wallet as { balance_demo: number } | null)?.balance_demo ?? 0) + stake;
    await service.from("wallets").update({ balance_demo: newBal }).eq("user_id", userId);
    await service
      .from("live_bets")
      .update({
        status: "refunded",
        settled_at: new Date().toISOString(),
        won: null,
        payout_amount: stake,
      })
      .eq("id", b.id as string);
  }

  await service
    .from("live_betting_markets")
    .update({ status: "cancelled", settlement_reason: reason })
    .eq("id", marketId);

  const { data: market } = await service
    .from("live_betting_markets")
    .select("room_id, live_session_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    const rid = (market as { room_id: string }).room_id;
    await service.from("live_room_events").insert({
      room_id: rid,
      market_id: marketId,
      event_type: "market_cancelled",
      payload: { reason },
    });
    /**
     * Only reset the room's phase / current_market_id when we just refunded
     * the market that IS the room's current market. Settlements now run in
     * a background sweep against orphaned locked markets, so clearing the
     * pointer unconditionally would knock the currently-visible bet off the
     * viewer screen mid-window.
     */
    const { data: roomNow } = await service
      .from("live_rooms")
      .select("current_market_id")
      .eq("id", rid)
      .maybeSingle();
    const currentId =
      (roomNow as { current_market_id: string | null } | null)
        ?.current_market_id ?? null;
    if (currentId === marketId) {
      await service.from("live_rooms").update({
        phase: "waiting_for_next_market",
        current_market_id: null,
      }).eq("id", rid);
    }
  }
  await finalizeDecisionAudit(service, marketId, {
    anomalyFlags: ["refund", reason],
    operatorIntervention: false,
  });
}

async function settleMarketWithWinner(
  marketId: string,
  winningOptionId: string,
  reason: string,
) {
  const service = await createServiceClient();
  const { data: bets } = await service
    .from("live_bets")
    .select("id, user_id, option_id, stake_amount")
    .eq("market_id", marketId)
    .eq("status", "locked");

  const betRows = (bets ?? []).map((b) => ({
    userId: b.user_id as string,
    optionId: b.option_id as string,
    stakeAmount: b.stake_amount as number,
  }));

  const payouts = Markets.computeParimutuelPayouts(betRows, winningOptionId);
  const settledAt = new Date().toISOString();

  for (let i = 0; i < (bets ?? []).length; i++) {
    const b = (bets ?? [])[i];
    const p = payouts[i];
    const { data: wallet } = await service
      .from("wallets")
      .select("balance_demo")
      .eq("user_id", p.userId)
      .maybeSingle();
    const balance = (wallet as { balance_demo: number } | null)?.balance_demo ?? 0;
    if (p.payoutAmount > 0) {
      await service
        .from("wallets")
        .update({ balance_demo: balance + p.payoutAmount })
        .eq("user_id", p.userId);
    }
    await service
      .from("live_bets")
      .update({
        status: p.won ? "settled_win" : "settled_loss",
        settled_at: settledAt,
        won: p.won,
        payout_amount: p.payoutAmount,
      })
      .eq("id", b.id as string);
  }

  await service
    .from("live_betting_markets")
    .update({
      status: "settled",
      locked_outcome_option_id: winningOptionId,
      settlement_reason: reason,
    })
    .eq("id", marketId);

  const { data: market } = await service
    .from("live_betting_markets")
    .select("room_id, live_session_id")
    .eq("id", marketId)
    .maybeSingle();
  if (market) {
    const rid = (market as { room_id: string }).room_id;
    await service.from("live_room_events").insert({
      room_id: rid,
      market_id: marketId,
      event_type: "market_settled",
      payload: { winningOptionId, reason },
    });
    /**
     * Same rationale as `refundMarket` — only knock the room back to
     * `waiting_for_next_market` when the freshly-settled market is still the
     * one displayed in the viewer popup. Background sweeps for orphan
     * locked markets must not clear the active card.
     */
    const { data: roomNow } = await service
      .from("live_rooms")
      .select("current_market_id")
      .eq("id", rid)
      .maybeSingle();
    const currentId =
      (roomNow as { current_market_id: string | null } | null)
        ?.current_market_id ?? null;
    if (currentId === marketId) {
      await service
        .from("live_rooms")
        .update({
          phase: "waiting_for_next_market",
          current_market_id: null,
          last_event_at: new Date().toISOString(),
        })
        .eq("id", rid);
    }
  }

  await finalizeDecisionAudit(service, marketId, { anomalyFlags: [], operatorIntervention: false });

  const liveSessionId = (market as { live_session_id?: string } | null)?.live_session_id;
  const { data: sess } = liveSessionId
    ? await service
        .from("character_live_sessions")
        .select("character_id")
        .eq("id", liveSessionId)
        .maybeSingle()
    : { data: null };
  const characterId = (sess as { character_id?: string } | null)?.character_id;
  if (characterId) {
    const winners = payouts.filter((p) => p.won).length;
    const total = payouts.length;
    const crowdAcc = total > 0 ? winners / total : null;
    const { data: pub } = await service
      .from("character_public_game_stats")
      .select("favorite_turn_tendencies")
      .eq("character_id", characterId)
      .maybeSingle();
    const fav = ((pub as { favorite_turn_tendencies?: Record<string, number> } | null)?.favorite_turn_tendencies ??
      {}) as Record<string, number>;
    fav[winningOptionId] = (fav[winningOptionId] ?? 0) + 1;

    // Detect a missed turn: market had directional turn options but driver went straight.
    const winId = winningOptionId.toLowerCase();
    const wentStraight = winId.includes("straight") || winId.includes("continue") || winId.includes("forward");
    const settledOptionSet = (bets != null
      ? (await service.from("live_betting_markets").select("option_set").eq("id", marketId).maybeSingle()).data
      : null) as { option_set?: Array<{ id: string; label?: string }> } | null;
    const marketHadTurns = (settledOptionSet?.option_set ?? []).some((o) => {
      const ol = (o.id + " " + (o.label ?? "")).toLowerCase();
      return ol.includes("left") || ol.includes("right") || ol.includes("turn");
    });
    const isMissedTurn = wentStraight && marketHadTurns;

    const { data: currentDriverStats } = await service
      .from("character_public_game_stats")
      .select("missed_turns_total")
      .eq("character_id", characterId)
      .maybeSingle();
    const currentMissed = (currentDriverStats as { missed_turns_total?: number } | null)?.missed_turns_total ?? 0;

    await service.from("character_public_game_stats").upsert(
      {
        character_id: characterId,
        crowd_prediction_accuracy: crowdAcc,
        favorite_turn_tendencies: fav,
        missed_turns_total: isMissedTurn ? currentMissed + 1 : currentMissed,
        updated_at: settledAt,
      },
      { onConflict: "character_id" },
    );

    if (isMissedTurn) {
      await service.from("character_route_game_state").upsert(
        {
          character_id: characterId,
          live_session_id: liveSessionId,
          missed_turn: true,
          updated_at: settledAt,
        },
        { onConflict: "character_id" },
      );
    }
    await applyBehaviorLearningNudges(service, {
      characterId,
      winningOptionId,
      reason,
      settledAt,
    });
  }

  return { status: "settled" as const, winningOptionId };
}
