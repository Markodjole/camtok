"use client";

export type SkillFeedbackData = {
  marketId: string;
  title: string;
  options: Array<{
    id: string;
    label: string;
    shortLabel: string | null;
    crowd_pct: number | null;
  }>;
  myOptionId: string;
  winningOptionId: string | null;
  won: boolean;
  stakeAmount: number;
  payoutAmount: number;
};

export function SkillFeedbackCard({
  data,
  onDismiss,
}: {
  data: SkillFeedbackData;
  onDismiss: () => void;
}) {
  const profit = data.won
    ? data.payoutAmount - data.stakeAmount
    : -data.stakeAmount;

  return (
    <div className="fixed inset-x-3 z-[300] bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] rounded-2xl border border-white/15 bg-black/90 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-4 duration-300">
      <div className="p-4">
        {/* Header */}
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">
            Result
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-white/30 text-xs leading-none"
          >
            ✕
          </button>
        </div>

        <p className="mb-3 text-sm font-semibold text-white leading-snug">
          {data.title}
        </p>

        {/* Options with crowd bars */}
        <div className="space-y-1.5 mb-3">
          {data.options.map((opt) => {
            const isWinner = opt.id === data.winningOptionId;
            const isMine = opt.id === data.myOptionId;
            const pct = opt.crowd_pct ?? 0;

            return (
              <div key={opt.id} className="relative">
                {/* Background fill bar */}
                <div
                  className={`absolute inset-0 rounded-lg transition-all duration-500 ${
                    isWinner ? "bg-emerald-500/20" : "bg-white/5"
                  }`}
                  style={{ width: `${Math.max(pct, 6)}%` }}
                />
                <div
                  className={`relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                    isWinner
                      ? "border-emerald-500/40"
                      : isMine
                        ? "border-violet-500/40"
                        : "border-white/8"
                  }`}
                >
                  <span
                    className={`flex-1 text-xs font-semibold ${
                      isWinner
                        ? "text-emerald-300"
                        : isMine
                          ? "text-violet-200"
                          : "text-white/50"
                    }`}
                  >
                    {opt.shortLabel ?? opt.label}
                    {isMine && isWinner && (
                      <span className="ml-1 text-emerald-400"> ✓ you</span>
                    )}
                    {isMine && !isWinner && (
                      <span className="ml-1 text-white/30"> ← you</span>
                    )}
                    {isWinner && !isMine && (
                      <span className="ml-1 text-emerald-400"> ✓</span>
                    )}
                  </span>
                  {opt.crowd_pct !== null && (
                    <span className="shrink-0 text-[10px] text-white/35">
                      {pct}%
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* P&L result */}
        <div className="flex items-center justify-center gap-2">
          <span
            className={`text-base font-extrabold tracking-tight ${
              profit >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {profit >= 0 ? `+$${profit}` : `-$${Math.abs(profit)}`}
          </span>
          <span className="text-xs text-white/30">
            {data.won ? "correct pick" : "wrong pick"}
          </span>
        </div>
      </div>
    </div>
  );
}
