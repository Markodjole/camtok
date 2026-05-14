"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { parseMarketResultsFromResolutionText } from "@/lib/bet-display";

export async function placeBet(input: {
  prediction_market_id: string;
  side_key: "yes" | "no";
  stake_amount: number;
}) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  if (input.stake_amount <= 0 || input.stake_amount > 50) {
    return { error: "Invalid stake amount" };
  }

  const { data: market } = await supabase
    .from("prediction_markets")
    .select("*, market_sides(*), clip_nodes!inner(status, betting_deadline)")
    .eq("id", input.prediction_market_id)
    .single();

  if (!market) return { error: "Market not found" };

  const clipNode = (market as Record<string, unknown>).clip_nodes as {
    status: string;
    betting_deadline: string | null;
  };

  if (clipNode.status !== "betting_open") {
    return { error: "Betting is closed for this clip" };
  }

  if (
    clipNode.betting_deadline &&
    new Date(clipNode.betting_deadline) < new Date()
  ) {
    return { error: "Betting deadline has passed" };
  }

  const marketSide = (
    market.market_sides as Array<{ id: string; side_key: string; current_odds_decimal: number; pool_amount: number; bet_count: number }>
  ).find((s) => s.side_key === input.side_key);

  if (!marketSide) return { error: "Market side not found" };

  const { data: wallet } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wallet) return { error: "Wallet not found" };

  const { data: activeHolds } = await supabase
    .from("wallet_holds")
    .select("amount")
    .eq("wallet_id", wallet.id)
    .eq("status", "active");

  const holdTotal = (activeHolds || []).reduce(
    (sum, h) => sum + Number(h.amount),
    0
  );
  const available = Number(wallet.balance) - holdTotal;

  if (available < input.stake_amount) {
    return { error: `Insufficient balance. Available: $${available.toFixed(2)}` };
  }

  const { data: bet, error: betError } = await serviceClient
    .from("bets")
    .insert({
      user_id: user.id,
      clip_node_id: market.clip_node_id,
      prediction_market_id: market.id,
      market_side_id: marketSide.id,
      side_key: input.side_key,
      stake_amount: input.stake_amount,
      odds_at_bet: marketSide.current_odds_decimal,
      available_balance_snapshot: available,
      status: "active",
    })
    .select()
    .single();

  if (betError) return { error: "Failed to place bet" };

  await serviceClient.from("wallet_holds").insert({
    wallet_id: wallet.id,
    bet_id: bet.id,
    amount: input.stake_amount,
    status: "active",
  });

  await serviceClient
    .from("market_sides")
    .update({
      pool_amount: Number(marketSide.pool_amount || 0) + input.stake_amount,
      bet_count: Number(marketSide.bet_count || 0) + 1,
    })
    .eq("id", marketSide.id);

  // Recalculate odds for all sides based on pool distribution
  const { data: updatedSides } = await serviceClient
    .from("market_sides")
    .select("id, side_key, pool_amount")
    .eq("prediction_market_id", market.id);

  if (updatedSides && updatedSides.length > 0) {
    const totalPool = updatedSides.reduce((sum, s) => sum + Number(s.pool_amount || 0), 0);

    for (const side of updatedSides) {
      const sidePool = Number(side.pool_amount || 0);
      // Minimum probability floor so odds don't go to infinity
      const probability = totalPool > 0
        ? Math.max(0.01, Math.min(0.99, sidePool / totalPool))
        : 0.5;
      const oddsDecimal = Math.round((1 / probability) * 100) / 100;

      await serviceClient
        .from("market_sides")
        .update({ probability, current_odds_decimal: oddsDecimal })
        .eq("id", side.id);
    }
  }

  await serviceClient
    .from("clip_nodes")
    .update({ bet_count: (market.bet_count || 0) + 1 })
    .eq("id", market.clip_node_id);

  return { data: bet };
}

export async function getUserBets(status?: string) {
  unstable_noStore();
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  let query = supabase
    .from("bets")
    .select(
      `
      *,
      prediction_markets(canonical_text, market_key),
      clip_nodes(video_storage_path, poster_storage_path)
    `
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[getUserBets]", error.message);
    return [];
  }
  return data || [];
}

export async function getUserBetsForClip(clipNodeId: string) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  

  const { data } = await supabase
    .from("bets")
    .select(
      `
      id,
      side_key,
      stake_amount,
      payout_amount,
      status,
      prediction_markets ( canonical_text, raw_creator_input )
    `,
    )
    .eq("user_id", user.id)
    .eq("clip_node_id", clipNodeId);

  return data || [];
}

export type ClipSettlementMarketRow = {
  winner_side: "yes" | "no";
  canonical_text: string;
  explanation_short: string | null;
};

/** Per-market winners + short LLM line for the “why” drawer. */
export async function getClipSettlementDetails(
  clipNodeId: string,
  resolutionReasonTextFallback: string
): Promise<ClipSettlementMarketRow[]> {
  const supabase = await createServerClient();

  const { data: sr } = await supabase
    .from("settlement_results")
    .select("id")
    .eq("clip_node_id", clipNodeId)
    .order("settled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sr?.id) {
    const { data: sides } = await supabase
      .from("settlement_side_results")
      .select(
        `
        winner_side,
        explanation_short,
        prediction_markets ( canonical_text )
      `,
      )
      .eq("settlement_result_id", sr.id);

    if (sides?.length) {
      const rows: ClipSettlementMarketRow[] = [];
      for (const row of sides) {
        const ws = row.winner_side as string | null;
        if (ws !== "yes" && ws !== "no") continue;
        const pm = row.prediction_markets as { canonical_text?: string | null } | null;
        rows.push({
          winner_side: ws,
          canonical_text: (pm?.canonical_text ?? "Prediction").replace(/\s+/g, " ").trim(),
          explanation_short:
            typeof row.explanation_short === "string" ? row.explanation_short : null,
        });
      }
      if (rows.length > 0) return rows;
    }
  }

  return parseMarketResultsFromResolutionText(resolutionReasonTextFallback).map((r) => ({
    ...r,
    explanation_short: null,
  }));
}

export type UserCharacterBettingSummary = {
  winRatePct: number;
  settledCount: number;
  currentWinStreak: number;
};

/** Win rate + current win streak for this user on clips tagged with the character. */
export async function getUserCharacterBettingSummary(
  characterId: string | null | undefined
): Promise<UserCharacterBettingSummary | null> {
  if (!characterId) return null;

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const winsFilter = supabase
    .from("bets")
    .select("id, clip_nodes!inner(character_id)", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("clip_nodes.character_id", characterId)
    .eq("status", "settled_win")
    .not("settled_at", "is", null);

  const lossesFilter = supabase
    .from("bets")
    .select("id, clip_nodes!inner(character_id)", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("clip_nodes.character_id", characterId)
    .eq("status", "settled_loss")
    .not("settled_at", "is", null);

  const [winsRes, lossesRes] = await Promise.all([winsFilter, lossesFilter]);

  const wins = winsRes.count ?? 0;
  const losses = lossesRes.count ?? 0;
  const settledCount = wins + losses;
  if (settledCount === 0) return null;

  const winRatePct = Math.round((wins / settledCount) * 1000) / 10;

  const { data: recent } = await supabase
    .from("bets")
    .select("status, settled_at, clip_nodes!inner(character_id)")
    .eq("user_id", user.id)
    .eq("clip_nodes.character_id", characterId)
    .in("status", ["settled_win", "settled_loss"])
    .not("settled_at", "is", null)
    .order("settled_at", { ascending: false })
    .limit(80);

  let currentWinStreak = 0;
  for (const row of recent || []) {
    if (row.status === "settled_win") currentWinStreak++;
    else break;
  }

  return { winRatePct, settledCount, currentWinStreak };
}
