import type { Wallet } from "@bettok/types";

/** Parse Supabase numeric columns (may arrive as string). */
export function walletNumericField(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Live room display + betting uses `balance_demo`, then falls back to `balance`. */
export function walletLiveBalance(
  wallet: Pick<Wallet, "balance_demo" | "balance"> | null | undefined,
): number {
  if (!wallet) return 0;
  const demo = walletNumericField(wallet.balance_demo);
  const main = walletNumericField(wallet.balance);
  if (demo > 0) return demo;
  return main;
}
