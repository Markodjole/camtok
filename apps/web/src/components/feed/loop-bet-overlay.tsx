"use client";

import { useState, useEffect, useRef } from "react";
import { placeBet } from "@/actions/bets";
import { useFeedStore } from "@/stores/feed-store";
import { useUserStore } from "@/stores/user-store";
import { useClipMarketsStore } from "@/stores/clip-markets-store";
import { useToast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { PredictionThread } from "@/components/feed/prediction-thread";

const MAX_VISIBLE = 1;
const PER_ITEM_MS = 5000;
const INTERACTION_PAUSE_MS = 5000;

function cap(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

interface LoopBetOverlayProps {
  clipId: string;
  onExpandedChange?: (expanded: boolean) => void;
  openAllSignal?: number;
}

export function LoopBetOverlay({ clipId, onExpandedChange, openAllSignal = 0 }: LoopBetOverlayProps) {
  const markets = useClipMarketsStore((s) => s.getMarkets(clipId));
  const refetchMarkets = useClipMarketsStore((s) => s.refetchMarkets);
  const [bettingId, setBettingId] = useState<string | null>(null);
  const lastStakeAmount = useFeedStore((s) => s.lastStakeAmount);
  const wallet = useUserStore((s) => s.wallet);
  const setWallet = useUserStore((s) => s.setWallet);
  const { toast } = useToast();
  const [pendingBet, setPendingBet] = useState<{ marketId: string; side: "yes" | "no" } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [detailMarketId, setDetailMarketId] = useState<string | null>(null);

  useEffect(() => {
    onExpandedChange?.(expanded || !!detailMarketId);
  }, [expanded, detailMarketId, onExpandedChange]);

  useEffect(() => {
    if (!openAllSignal) return;
    setDetailMarketId(null);
    setExpanded(true);
  }, [openAllSignal]);

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
  const hasMore = false;

  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pausedUntilRef = useRef<number>(0);
  const [pauseByCompose, setPauseByCompose] = useState(false);
  const pullStartYRef = useRef<number | null>(null);

  const handleThreadInteract = () => {
    pausedUntilRef.current = Date.now() + INTERACTION_PAUSE_MS;
  };

  const handlePullStart = (y: number) => {
    if (!hasMore || expanded || detailMarketId) return;
    pullStartYRef.current = y;
  };

  const handlePullMove = (y: number) => {
    if (!hasMore || expanded || detailMarketId) return;
    const startY = pullStartYRef.current;
    if (startY == null) return;
    if (y - startY >= 40) {
      setExpanded(true);
      pullStartYRef.current = null;
    }
  };

  const handlePullEnd = () => {
    pullStartYRef.current = null;
  };

  useEffect(() => {
    if (!hasMore || expanded || detailMarketId) {
      if (scrollTimerRef.current) clearInterval(scrollTimerRef.current);
      return;
    }
    scrollTimerRef.current = setInterval(() => {
      if (pauseByCompose) return;
      if (Date.now() < pausedUntilRef.current) return;
      setScrollOffset((prev) => {
        const max = markets.length - 1;
        return prev >= max ? 0 : prev + 1;
      });
    }, PER_ITEM_MS);
    return () => {
      if (scrollTimerRef.current) clearInterval(scrollTimerRef.current);
    };
  }, [hasMore, expanded, detailMarketId, markets.length, pauseByCompose]);

  const displayMarkets = markets;

  const detailMarket = detailMarketId ? markets.find((m) => m.id === detailMarketId) : null;

  function openDetail(marketId: string) {
    setDetailMarketId(marketId);
  }

  function closeDetail() {
    setDetailMarketId(null);
  }

  function closeAll() {
    setExpanded(false);
    setDetailMarketId(null);
  }

  const pendingMarket = pendingBet ? markets.find((m) => m.id === pendingBet.marketId) : null;

  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      {markets.length === 0 ? (
        <div className="pointer-events-auto absolute left-3 right-3 top-3">
          <p className="text-center text-xs text-white/60 rounded-md bg-black/40 px-2 py-1.5">
            No predictions yet
          </p>
        </div>

      ) : detailMarket ? (
        /* ── Detail view: same card style, just all comments shown ── */
        <div
          className="pointer-events-auto absolute inset-0 z-30"
          onClick={closeDetail}
        >
          <div className="absolute left-2 right-2 top-1.5" onClick={closeDetail}>
            {(() => {
              const yes = detailMarket.market_sides.find((s) => s.side_key === "yes");
              const no = detailMarket.market_sides.find((s) => s.side_key === "no");
              return (
                <div className="rounded-lg bg-black/55 px-2.5 py-2 shadow-md border border-primary/40">
                  <p className="text-sm font-medium text-white/95 leading-snug line-clamp-2 mb-1.5">
                    {cap(detailMarket.canonical_text)}
                  </p>
                  <div className="flex items-start gap-2 mb-2">
                    <button
                      type="button"
                      disabled={!canBet || !!bettingId}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingBet({ marketId: detailMarket.id, side: "yes" });
                      }}
                      className="shrink-0 rounded-md bg-emerald-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-emerald-500/80 disabled:opacity-50 touch-manipulation"
                    >
                      Yes {yes ? yes.current_odds_decimal.toFixed(2) : ""}
                    </button>
                    <div className="flex-1 min-w-0" />
                    <button
                      type="button"
                      disabled={!canBet || !!bettingId}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingBet({ marketId: detailMarket.id, side: "no" });
                      }}
                      className="shrink-0 rounded-md bg-rose-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-rose-500/80 disabled:opacity-50 touch-manipulation"
                    >
                      No {no ? no.current_odds_decimal.toFixed(2) : ""}
                    </button>
                  </div>
                  <div className="max-h-[50vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                    <PredictionThread
                      predictionMarketId={detailMarket.id}
                      visible
                      mode="expanded"
                      onInteract={handleThreadInteract}
                      onComposeChange={setPauseByCompose}
                    />
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

      ) : expanded ? (
        /* ── Expanded list: all predictions with yes/no + comments, static ── */
        <div
          className="pointer-events-auto absolute inset-0 z-30 bg-black/60"
          onClick={closeAll}
        >
          <div className="h-full overflow-y-auto px-3 py-4 pb-16 space-y-3">
            {markets.map((market) => {
              const yes = market.market_sides.find((s) => s.side_key === "yes");
              const no = market.market_sides.find((s) => s.side_key === "no");
              return (
                <div
                  key={market.id}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-lg bg-black/65 px-2.5 py-2.5 shadow-md border border-primary/40"
                >
                  <p className="text-sm font-medium text-white/95 leading-snug mb-2">
                    {cap(market.canonical_text)}
                  </p>
                  <div className="flex items-start gap-2 mb-2">
                    <button
                      type="button"
                      disabled={!canBet || !!bettingId}
                      onClick={() => setPendingBet({ marketId: market.id, side: "yes" })}
                      className="shrink-0 rounded-md bg-emerald-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-emerald-500/80 disabled:opacity-50 touch-manipulation"
                    >
                      Yes {yes ? yes.current_odds_decimal.toFixed(2) : ""}
                    </button>
                    <div className="flex-1 min-w-0" />
                    <button
                      type="button"
                      disabled={!canBet || !!bettingId}
                      onClick={() => setPendingBet({ marketId: market.id, side: "no" })}
                      className="shrink-0 rounded-md bg-rose-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-rose-500/80 disabled:opacity-50 touch-manipulation"
                    >
                      No {no ? no.current_odds_decimal.toFixed(2) : ""}
                    </button>
                  </div>
                  <PredictionThread
                    predictionMarketId={market.id}
                    visible
                    mode="expanded"
                    onInteract={handleThreadInteract}
                    onComposeChange={setPauseByCompose}
                  />
                </div>
              );
            })}
          </div>
        </div>

      ) : (
        /* ── Compact view: rotating single prediction ── */
        <div
          className="pointer-events-auto absolute left-2 right-2 top-1.5 flex flex-col gap-1"
          onTouchStart={(e) => handlePullStart(e.touches[0]?.clientY ?? 0)}
          onTouchMove={(e) => handlePullMove(e.touches[0]?.clientY ?? 0)}
          onTouchEnd={handlePullEnd}
          onMouseDown={(e) => handlePullStart(e.clientY)}
          onMouseMove={(e) => {
            if (e.buttons === 1) handlePullMove(e.clientY);
          }}
          onMouseUp={handlePullEnd}
          onMouseLeave={handlePullEnd}
        >
          <div className="space-y-2 overflow-hidden">
              {displayMarkets.map((market) => {
              const yes = market.market_sides.find((s) => s.side_key === "yes");
              const no = market.market_sides.find((s) => s.side_key === "no");
              return (
                <div
                  key={`${market.id}-${scrollOffset}`}
                  className="animate-[slideUp_0.35s_ease-out]"
                  onClick={() => openDetail(market.id)}
                >
                  <div className="rounded-lg bg-black/45 shadow-md border border-primary/40 cursor-pointer touch-manipulation overflow-hidden">
                    <div className="px-2.5 py-2">
                      <p className="text-sm font-medium text-white/99 leading-snug line-clamp-2 mb-1.5">
                        {cap(market.canonical_text)}
                      </p>
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          disabled={!canBet || !!bettingId}
                          onClick={(e) => { e.stopPropagation(); setPendingBet({ marketId: market.id, side: "yes" }); }}
                          className="shrink-0 rounded-md bg-emerald-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-emerald-500/80 disabled:opacity-50 touch-manipulation"
                        >
                          Yes {yes ? yes.current_odds_decimal.toFixed(2) : ""}
                        </button>
                        <div className="flex-1 min-w-0">
                          <PredictionThread
                            predictionMarketId={market.id}
                            visible
                            mode="compact"
                            onInteract={handleThreadInteract}
                            onComposeChange={setPauseByCompose}
                          />
                        </div>
                        <button
                          type="button"
                          disabled={!canBet || !!bettingId}
                          onClick={(e) => { e.stopPropagation(); setPendingBet({ marketId: market.id, side: "no" }); }}
                          className="shrink-0 rounded-md bg-rose-500/60 px-3 py-1.5 text-[10px] font-semibold text-white transition hover:bg-rose-500/80 disabled:opacity-50 touch-manipulation"
                        >
                          No {no ? no.current_odds_decimal.toFixed(2) : ""}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
              })}
          </div>
        </div>
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
