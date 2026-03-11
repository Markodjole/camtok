"use client";

import { useState, useEffect } from "react";
import { placeBet } from "@/actions/bets";
import { useFeedStore } from "@/stores/feed-store";
import { useUserStore } from "@/stores/user-store";
import { useClipMarketsStore } from "@/stores/clip-markets-store";
import { useToast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

const MAX_VISIBLE_COMPACT = 2;
const STAKE_OPTIONS = [1, 2, 5, 10, 20, 50] as const;

interface LoopBetOverlayProps {
  clipId: string;
}

export function LoopBetOverlay({ clipId }: LoopBetOverlayProps) {
  const markets = useClipMarketsStore((s) => s.getMarkets(clipId));
  const refetchMarkets = useClipMarketsStore((s) => s.refetchMarkets);
  const [bettingId, setBettingId] = useState<string | null>(null);
  const lastStakeAmount = useFeedStore((s) => s.lastStakeAmount);
  const setLastStakeAmount = useFeedStore((s) => s.setLastStakeAmount);
  const wallet = useUserStore((s) => s.wallet);
  const setWallet = useUserStore((s) => s.setWallet);
  const { toast } = useToast();
  const [pendingBet, setPendingBet] = useState<{ marketId: string; side: "yes" | "no" } | null>(null);
  const [showAmountPicker, setShowAmountPicker] = useState(false);

  useEffect(() => {
    refetchMarkets(clipId);
  }, [clipId, refetchMarkets]);

  async function confirmAndPlaceBet(marketId: string, side: "yes" | "no") {
    setPendingBet(null);
    await handleOneClickBet(marketId, side);
  }

  async function handleOneClickBet(marketId: string, side: "yes" | "no") {
    const key = `${marketId}-${side}`;
    if (bettingId) return;
    setBettingId(key);
    const payload = {
      prediction_market_id: marketId,
      side_key: side as "yes" | "no",
      stake_amount: lastStakeAmount,
    };
    let result: Awaited<ReturnType<typeof placeBet>>;
    try {
      result = await placeBet(payload);
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message?.includes("Lock broken"));
      if (isAbort) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          result = await placeBet(payload);
        } catch {
          toast({ title: "Bet failed", description: "Connection conflict. Try again.", variant: "destructive" });
          setBettingId(null);
          return;
        }
      } else {
        toast({ title: "Bet failed", description: err instanceof Error ? err.message : "Something went wrong", variant: "destructive" });
        setBettingId(null);
        return;
      }
    }
    setBettingId(null);
    if (result!.error) {
      toast({ title: "Bet failed", description: result!.error, variant: "destructive" });
    } else {
      toast({ title: "Bet placed!", description: `${formatCurrency(lastStakeAmount)} on ${side.toUpperCase()}`, variant: "success" });
      if (wallet) setWallet({ ...wallet, balance: wallet.balance - lastStakeAmount });
      refetchMarkets(clipId);
    }
  }

  const balance = wallet?.balance ?? 0;
  const canBet = balance >= lastStakeAmount;
  const [expanded, setExpanded] = useState(false);
  const hasMore = markets.length > MAX_VISIBLE_COMPACT;
  const visibleMarkets = expanded ? markets : markets.slice(0, MAX_VISIBLE_COMPACT);

  function PredictionBlock({ market }: { market: (typeof markets)[0] }) {
    const yes = market.market_sides.find((s) => s.side_key === "yes");
    const no = market.market_sides.find((s) => s.side_key === "no");
    return (
      <div className="rounded-lg bg-black/50 px-2.5 py-2 shadow-md">
        <p className="text-xs text-white/95 mb-2 leading-snug">
          {market.canonical_text}
        </p>
        <div className="flex justify-between gap-2">
          <button
            type="button"
            disabled={!canBet || !!bettingId}
            onClick={() => setPendingBet({ marketId: market.id, side: "yes" })}
            className="rounded-lg bg-emerald-500/60 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500/80 disabled:opacity-50 touch-manipulation min-w-[64px]"
          >
            Yes {yes ? `· ${yes.current_odds_decimal.toFixed(1)}x` : ""}
          </button>
          <button
            type="button"
            disabled={!canBet || !!bettingId}
            onClick={() => setPendingBet({ marketId: market.id, side: "no" })}
            className="rounded-lg bg-rose-500/60 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-rose-500/80 disabled:opacity-50 touch-manipulation min-w-[64px]"
          >
            No {no ? `· ${no.current_odds_decimal.toFixed(1)}x` : ""}
          </button>
        </div>
      </div>
    );
  }

  const compactContent = (
    <div className="pointer-events-auto absolute left-3 right-3 bottom-[28%] flex flex-col gap-2">
      <div className="flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={() => setShowAmountPicker((v) => !v)}
          className="text-center text-[11px] font-medium text-white/90 rounded bg-black/40 px-2 py-0.5 hover:bg-black/55 touch-manipulation"
        >
          One-tap · {formatCurrency(lastStakeAmount)}
        </button>
        {showAmountPicker && (
          <div className="flex flex-wrap justify-center gap-1.5 rounded-lg bg-black/50 px-2 py-2">
            {STAKE_OPTIONS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => {
                  setLastStakeAmount(amount);
                  setShowAmountPicker(false);
                }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold touch-manipulation ${
                  amount === lastStakeAmount
                    ? "bg-primary text-primary-foreground"
                    : "bg-white/20 text-white hover:bg-white/30"
                }`}
              >
                ${amount}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        {visibleMarkets.map((market) => (
          <PredictionBlock key={market.id} market={market} />
        ))}
      </div>
      {hasMore && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center justify-center gap-1 py-1.5 text-white/70 hover:text-white/90 transition touch-manipulation"
          aria-label="Show all predictions"
        >
          <ChevronDown className="h-4 w-4" />
          <span className="text-[11px]">More</span>
        </button>
      )}
    </div>
  );

  const expandedContent = expanded && hasMore ? (
    <div
      className="pointer-events-auto absolute inset-0 z-30 bg-black/60 flex flex-col"
      onClick={() => setExpanded(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Escape" && setExpanded(false)}
      aria-label="Close full list"
    >
      <div
        className="flex-1 overflow-y-auto px-3 py-4 mt-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-1.5 mb-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowAmountPicker((v) => !v); }}
            className="text-center text-xs font-medium text-white/90 rounded bg-black/40 px-2 py-1 hover:bg-black/55 touch-manipulation"
          >
            One-tap · {formatCurrency(lastStakeAmount)}
          </button>
          {showAmountPicker && (
            <div className="flex flex-wrap justify-center gap-1.5 rounded-lg bg-black/50 px-2 py-2">
              {STAKE_OPTIONS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLastStakeAmount(amount);
                    setShowAmountPicker(false);
                  }}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold touch-manipulation ${
                    amount === lastStakeAmount
                      ? "bg-primary text-primary-foreground"
                      : "bg-white/20 text-white hover:bg-white/30"
                  }`}
                >
                  ${amount}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2">
          {markets.map((market) => (
            <PredictionBlock key={market.id} market={market} />
          ))}
        </div>
      </div>
      <div className="shrink-0 pb-6 pt-2 text-center">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
          className="text-white/70 hover:text-white text-sm touch-manipulation"
        >
          Close
        </button>
      </div>
    </div>
  ) : null;

  const pendingMarket = pendingBet ? markets.find((m) => m.id === pendingBet.marketId) : null;

  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      {markets.length === 0 ? (
        <div className="pointer-events-auto absolute left-3 right-3 bottom-[28%]">
          <p className="text-center text-xs text-white/60 rounded-md bg-black/40 px-2 py-1.5">
            No predictions yet
          </p>
        </div>
      ) : expanded && hasMore ? (
        expandedContent
      ) : (
        compactContent
      )}

      {pendingBet && pendingMarket && (
        <div
          className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPendingBet(null)}
          role="dialog"
          aria-labelledby="bet-confirm-title"
          aria-modal="true"
        >
          <div
            className="w-full max-w-[280px] rounded-xl bg-card border border-border p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-foreground mb-1 line-clamp-2">
              {pendingMarket.canonical_text}
            </p>
            <p id="bet-confirm-title" className="text-sm font-medium text-muted-foreground mb-4">
              Bet {formatCurrency(lastStakeAmount)} on {pendingBet.side.toUpperCase()}?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPendingBet(null)}
                className="flex-1 rounded-lg border border-border bg-secondary py-2.5 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 touch-manipulation"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmAndPlaceBet(pendingBet.marketId, pendingBet.side)}
                disabled={!canBet || !!bettingId}
                className="flex-1 rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 touch-manipulation"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
