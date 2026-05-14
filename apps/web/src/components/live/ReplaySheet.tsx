"use client";

import { useEffect, useState } from "react";

type ReplayOption = {
  id: string;
  label: string;
  shortLabel: string | null;
  crowd_pct: number | null;
  bet_count: number;
};

type ReplayMarket = {
  id: string;
  title: string;
  market_type: string;
  options: ReplayOption[];
  winning_option_id: string | null;
  commit_hash: string | null;
  settlement_reason: string | null;
  total_bet_amount: number;
  participant_count: number;
  locks_at: string;
  gps_confidence: number | null;
  anomaly_flags: string[];
  operator_intervention: boolean;
};

export function ReplaySheet({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const [markets, setMarkets] = useState<ReplayMarket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/live/rooms/${roomId}/history`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { markets: ReplayMarket[] }) => setMarkets(j.markets ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId]);

  return (
    <div className="fixed inset-0 z-[400] flex flex-col">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative mt-auto max-h-[78vh] flex flex-col rounded-t-3xl bg-[#111] shadow-2xl animate-in slide-in-from-bottom-4 duration-300">
        {/* Handle + header */}
        <div className="flex flex-col items-center pt-2 pb-0">
          <div className="h-1 w-10 rounded-full bg-white/20 mb-3" />
        </div>
        <div className="flex items-center justify-between px-4 pb-3 border-b border-white/8">
          <span className="text-sm font-bold text-white">Decision history</span>
          <button
            type="button"
            onClick={onClose}
            className="text-white/35 text-sm"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3 pb-[env(safe-area-inset-bottom,0.75rem)]">
          {loading && (
            <p className="py-10 text-center text-xs text-white/30">Loading…</p>
          )}
          {!loading && markets.length === 0 && (
            <p className="py-10 text-center text-xs text-white/30">
              No resolved markets yet.
            </p>
          )}

          {markets.map((m) => {
            const winner = m.options.find((o) => o.id === m.winning_option_id);
            const isNextZone = m.market_type === "city_grid";
            const winnerLabel = winner ? winner.shortLabel ?? winner.label : null;
            const gpsPct =
              m.gps_confidence !== null
                ? Math.round(m.gps_confidence * 100)
                : null;
            const lockedAt = new Date(m.locks_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });

            return (
              <div
                key={m.id}
                className="rounded-xl border border-white/10 bg-white/5 p-3"
              >
                {/* Title + winner badge */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold text-white leading-snug">
                    {m.title}
                  </p>
                  {winner ? (
                    <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                      {winnerLabel} ✓
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/35">
                      {m.settlement_reason === "refunded" ? "refunded" : "void"}
                    </span>
                  )}
                </div>

                {/* Option bars */}
                {isNextZone ? (
                  <div className="mb-2.5 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-center">
                    <span className="text-lg font-black tracking-tight text-emerald-200">
                      {winnerLabel ?? "pending"}
                    </span>
                  </div>
                ) : (
                  <div className="space-y-1 mb-2.5">
                    {m.options.map((opt) => {
                      const isWinner = opt.id === m.winning_option_id;
                      const pct = opt.crowd_pct ?? 0;
                      return (
                        <div
                          key={opt.id}
                          className="relative h-5 overflow-hidden rounded bg-white/5"
                        >
                          <div
                            className={`absolute inset-y-0 left-0 rounded transition-all duration-700 ${
                              isWinner ? "bg-emerald-500/30" : "bg-white/10"
                            }`}
                            style={{ width: `${Math.max(pct, 4)}%` }}
                          />
                          <div className="absolute inset-0 flex items-center justify-between px-2">
                            <span
                              className={`text-[10px] font-medium ${
                                isWinner ? "text-emerald-300" : "text-white/45"
                              }`}
                            >
                              {opt.shortLabel ?? opt.label}
                              {isWinner ? " ✓" : ""}
                            </span>
                            {opt.crowd_pct !== null && (
                              <span className="text-[10px] text-white/25">
                                {pct}%
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Trust / integrity row */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-white/25">
                  <span>locked {lockedAt}</span>
                  {m.commit_hash && (
                    <span
                      title={`Commit hash: ${m.commit_hash}`}
                      className="font-mono"
                    >
                      🔒 {m.commit_hash.slice(0, 8)}
                    </span>
                  )}
                  {gpsPct !== null && (
                    <span
                      className={gpsPct < 60 ? "text-amber-400/70" : ""}
                    >
                      GPS {gpsPct}%
                    </span>
                  )}
                  {m.anomaly_flags.length > 0 && (
                    <span className="text-amber-400/70">
                      ⚠ {m.anomaly_flags.join(", ")}
                    </span>
                  )}
                  {m.operator_intervention && (
                    <span className="text-rose-400/70">⚑ operator</span>
                  )}
                  <span>
                    {m.participant_count} bettors · ${m.total_bet_amount}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
