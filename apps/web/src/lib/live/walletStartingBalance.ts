/**
 * Starting balance for `wallets.balance` + `wallets.balance_demo` (live bets debit the latter).
 *
 * - Set `CAMTOK_WALLET_STARTING_BALANCE` (e.g. 5000000) to override everywhere.
 * - Non-production defaults high for QA; production defaults to 1000 unless env is set.
 */
const MAX_WALLET = 9_999_999.99;

export function walletStartingBalance(): number {
  const raw = process.env.CAMTOK_WALLET_STARTING_BALANCE?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, MAX_WALLET);
  }
  if (process.env.NODE_ENV === "production") return 1000;
  return 5_000_000;
}
