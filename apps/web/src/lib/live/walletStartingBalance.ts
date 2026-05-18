/**
 * Starting balance for `wallets.balance` + `wallets.balance_demo` (live bets debit the latter).
 * Default is $1000 per user (persisted in DB, not reset each session).
 * Override with `CAMTOK_WALLET_STARTING_BALANCE` if needed.
 */
const MAX_WALLET = 9_999_999.99;
export const DEFAULT_WALLET_STARTING_BALANCE = 1000;

export function walletStartingBalance(): number {
  const raw = process.env.CAMTOK_WALLET_STARTING_BALANCE?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, MAX_WALLET);
  }
  return DEFAULT_WALLET_STARTING_BALANCE;
}
