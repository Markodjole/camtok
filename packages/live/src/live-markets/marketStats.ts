export type MarketParticipationRow = {
  optionId: string;
  amount: number;
  bettors: number;
};

export type MarketParticipation = {
  totalAmount: number;
  totalBettors: number;
  rows: Array<MarketParticipationRow & { share: number }>;
};

export function aggregateParticipation(
  rows: MarketParticipationRow[],
): MarketParticipation {
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const totalBettors = rows.reduce((s, r) => s + r.bettors, 0);
  return {
    totalAmount,
    totalBettors,
    rows: rows.map((r) => ({
      ...r,
      share: totalAmount === 0 ? 0 : r.amount / totalAmount,
    })),
  };
}
