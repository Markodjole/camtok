"use server";

import { createServerClient, createServiceClient } from "@/lib/supabase/server";

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

  if (input.stake_amount <= 0 || input.stake_amount > 10000) {
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

  await serviceClient
    .from("clip_nodes")
    .update({ bet_count: (market.bet_count || 0) + 1 })
    .eq("id", market.clip_node_id);

  return { data: bet };
}

export async function getUserBets(status?: string) {
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
      clip_nodes(video_storage_path, poster_storage_path, stories(title))
    `
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data } = await query;
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
    .select("*")
    .eq("user_id", user.id)
    .eq("clip_node_id", clipNodeId);

  return data || [];
}
