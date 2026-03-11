"use client";

import { useState, useEffect } from "react";
import { placeBet } from "@/actions/bets";
import { useFeedStore } from "@/stores/feed-store";
import { useUserStore } from "@/stores/user-store";
import { useClipMarketsStore } from "@/stores/clip-markets-store";
import { useToast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";

interface LoopBetOverlayProps {
  clipId: string;
}

export function LoopBetOverlay({ clipId }: LoopBetOverlayProps) {
  const markets = useClipMarketsStore((s) => s.getMarkets(clipId));
  const refetchMarkets = useClipMarketsStore((s) => s.refetchMarkets);
  const [bettingId, setBettingId] = useState<string | null>(null);
  const lastStakeAmount = useFeedStore((s) => s.lastStakeAmount);
  const wallet = useUserStore((s) => s.wallet);
  const setWallet = useUserStore((s) => s.setWallet);
  const { toast } = useToast();

  useEffect(() => {
    refetchMarkets(clipId);
  }, [clipId, refetchMarkets]);

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

  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      <div className="pointer-events-auto absolute left-4 right-4 top-3 max-h-[30vh] overflow-y-auto">
        <p className="mb-2 text-center text-xs font-medium text-white/90 drop-shadow-md rounded-md bg-black/40 px-2 py-1 inline-block">
          One-tap · {formatCurrency(lastStakeAmount)}
        </p>
        <div className="space-y-3">
          {markets.map((market) => {
            const yes = market.market_sides.find((s) => s.side_key === "yes");
            const no = market.market_sides.find((s) => s.side_key === "no");
            return (
              <div key={market.id} className="space-y-2">
                <p className="text-sm text-white/95 drop-shadow-md rounded-md bg-black/40 px-2.5 py-1.5">
                  {market.canonical_text}
                </p>
                <div className="flex justify-between gap-3">
                  <button
                    type="button"
                    disabled={!canBet || !!bettingId}
                    onClick={() => handleOneClickBet(market.id, "yes")}
                    className="rounded-xl bg-emerald-500/60 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500/80 disabled:opacity-50 touch-manipulation min-w-[88px]"
                  >
                    Yes {yes ? `· ${yes.current_odds_decimal.toFixed(1)}x` : ""}
                  </button>
                  <button
                    type="button"
                    disabled={!canBet || !!bettingId}
                    onClick={() => handleOneClickBet(market.id, "no")}
                    className="rounded-xl bg-rose-500/60 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-500/80 disabled:opacity-50 touch-manipulation min-w-[88px]"
                  >
                    No {no ? `· ${no.current_odds_decimal.toFixed(1)}x` : ""}
                  </button>
                </div>
              </div>
            );
          })}
          {markets.length === 0 && (
            <p className="py-3 text-center text-xs text-white/60 drop-shadow-md rounded-md bg-black/40 px-2 py-1">No predictions yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
