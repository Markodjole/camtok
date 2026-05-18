"use server";

import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { walletNumericField } from "@/lib/live/walletBalance";
import { walletStartingBalance } from "@/lib/live/walletStartingBalance";

/** Create profile and wallet for the current user if missing (e.g. user created before trigger existed). */
export async function ensureProfileAndWallet(): Promise<
  { profile: unknown; wallet: unknown } | { error: string }
> {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const shortId = user.id.replace(/-/g, "").slice(0, 12);
  const meta = (user.user_metadata as Record<string, string> | null) || {};
  const username =
    (meta.username && meta.username.length >= 3 && meta.username.length <= 30)
      ? meta.username.slice(0, 30)
      : `user_${shortId}`;
  const displayName =
    (meta.display_name && meta.display_name.trim().length >= 1)
      ? meta.display_name.trim().slice(0, 60)
      : meta.username?.slice(0, 60) || user.email?.split("@")[0]?.slice(0, 60) || "User";

  const { data: existingProfile } = await serviceClient
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (!existingProfile) {
    const { error: profileErr } = await serviceClient.from("profiles").insert({
      id: user.id,
      username,
      display_name: displayName,
    });
    if (profileErr) return { error: "Failed to create profile: " + profileErr.message };
  }

  const { data: existingWallet } = await serviceClient
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existingWallet) {
    const start = walletStartingBalance();
    const { data: newWallet, error: walletErr } = await serviceClient
      .from("wallets")
      .insert({
        user_id: user.id,
        balance: start,
        balance_demo: start,
        total_deposited: start,
      })
      .select()
      .single();
    if (walletErr) return { error: "Failed to create wallet: " + walletErr.message };
    await serviceClient.from("wallet_transactions").insert({
      wallet_id: newWallet.id,
      type: "deposit_demo",
      amount: start,
      balance_after: start,
      description: "Welcome bonus",
    });
  }

  const [
    { data: profile },
    { data: wallet },
  ] = await Promise.all([
    serviceClient.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    serviceClient.from("wallets").select("*").eq("user_id", user.id).maybeSingle(),
  ]);

  return { profile: profile ?? null, wallet: wallet ?? null };
}

/**
 * Ensure the user's live/demo balance is initialized and persisted (not reset per session).
 * - Never funded (both lanes 0, no deposits): grant starting balance once.
 * - Main balance funded but demo lane empty (legacy rows): copy main → demo.
 */
export async function ensureWalletLiveBalance(): Promise<
  { wallet: unknown } | { error: string }
> {
  const ensured = await ensureProfileAndWallet();
  if ("error" in ensured) return ensured;

  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: walletRow } = await serviceClient
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!walletRow) return { error: "Wallet not found" };

  const balance = walletNumericField(walletRow.balance);
  const balanceDemo = walletNumericField(walletRow.balance_demo);
  const totalDeposited = walletNumericField(walletRow.total_deposited);
  const start = walletStartingBalance();

  let nextDemo = balanceDemo;
  let nextMain = balance;

  if (balanceDemo <= 0 && balance > 0) {
    nextDemo = balance;
  } else if (balanceDemo <= 0 && balance <= 0 && totalDeposited <= 0) {
    nextMain = start;
    nextDemo = start;
  }

  if (nextDemo !== balanceDemo || nextMain !== balance) {
    const { error: updateErr } = await serviceClient
      .from("wallets")
      .update({
        balance: nextMain,
        balance_demo: nextDemo,
        ...(nextMain > balance && totalDeposited <= 0
          ? { total_deposited: start }
          : {}),
      })
      .eq("id", walletRow.id);

    if (updateErr) return { error: updateErr.message };

    if (nextMain > balance && totalDeposited <= 0) {
      await serviceClient.from("wallet_transactions").insert({
        wallet_id: walletRow.id,
        type: "deposit_demo",
        amount: start,
        balance_after: start,
        description: "Welcome bonus",
      });
    }
  }

  const { data: wallet } = await serviceClient
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return { wallet: wallet ?? null };
}

export async function getWallet() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return data ?? null;
}

export async function getWalletTransactions(limit = 50) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: wallet } = await supabase
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wallet) return [];

  const { data } = await supabase
    .from("wallet_transactions")
    .select("*")
    .eq("wallet_id", wallet.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  return data || [];
}

export async function depositDemo(amount: number) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  if (amount <= 0 || amount > 100000) {
    return { error: "Invalid amount" };
  }

  const { data: wallet } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wallet) return { error: "Wallet not found" };

  const newBalance = walletNumericField(wallet.balance) + amount;
  const newDemo = walletNumericField(wallet.balance_demo) + amount;

  const { error: txError } = await serviceClient
    .from("wallet_transactions")
    .insert({
      wallet_id: wallet.id,
      type: "deposit_demo",
      amount,
      balance_after: newBalance,
      description: `Demo deposit of $${amount.toFixed(2)}`,
    });

  if (txError) return { error: "Transaction failed" };

  await serviceClient
    .from("wallets")
    .update({
      balance: newBalance,
      balance_demo: newDemo,
      total_deposited: walletNumericField(wallet.total_deposited) + amount,
    })
    .eq("id", wallet.id);

  return { data: { balance: newBalance, balance_demo: newDemo } };
}

export async function getAvailableBalance() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 0;

  const { data: wallet } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wallet) return 0;

  const { data: holds } = await supabase
    .from("wallet_holds")
    .select("amount")
    .eq("wallet_id", wallet.id)
    .eq("status", "active");

  const holdTotal = (holds || []).reduce(
    (sum, h) => sum + Number(h.amount),
    0
  );

  return Math.max(0, Number(wallet.balance) - holdTotal);
}
