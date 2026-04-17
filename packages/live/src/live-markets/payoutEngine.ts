export type BetRow = {
  userId: string;
  optionId: string;
  stakeAmount: number;
};

export type PayoutRow = {
  userId: string;
  stakeAmount: number;
  won: boolean;
  payoutAmount: number;
};

/**
 * Simple parimutuel payout:
 *   - winners split the total stake proportionally to their stake
 *   - house fee configurable (default 0)
 *   - if no winners: refund all
 */
export function computeParimutuelPayouts(
  bets: BetRow[],
  winningOptionId: string,
  houseFeeBps = 0,
): PayoutRow[] {
  const totalStake = bets.reduce((s, b) => s + b.stakeAmount, 0);
  const feeBps = Math.max(0, Math.min(1000, houseFeeBps));
  const pool = Math.floor(totalStake * (10000 - feeBps) / 10000);
  const winners = bets.filter((b) => b.optionId === winningOptionId);
  const winningStake = winners.reduce((s, b) => s + b.stakeAmount, 0);

  if (winners.length === 0 || winningStake === 0) {
    return bets.map((b) => ({
      userId: b.userId,
      stakeAmount: b.stakeAmount,
      won: false,
      payoutAmount: b.stakeAmount,
    }));
  }

  return bets.map((b) => {
    const won = b.optionId === winningOptionId;
    const payout = won
      ? Math.floor((b.stakeAmount / winningStake) * pool)
      : 0;
    return {
      userId: b.userId,
      stakeAmount: b.stakeAmount,
      won,
      payoutAmount: payout,
    };
  });
}
