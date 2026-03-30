"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PredictionChip } from "./prediction-chip";
import { AddPrediction } from "./add-prediction";
import { BetForm } from "./bet-form";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useClipMarketsStore, type ClipMarket } from "@/stores/clip-markets-store";
import { TrendingUp, ChevronLeft } from "lucide-react";

const DRAG_CLOSE_THRESHOLD_PX = 80;

interface BettingBottomSheetProps {
  clipId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BettingBottomSheet({
  clipId,
  open,
  onOpenChange,
}: BettingBottomSheetProps) {
  const markets = useClipMarketsStore((s) => s.getMarkets(clipId));
  const refetchMarkets = useClipMarketsStore((s) => s.refetchMarkets);
  const [loading, setLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<ClipMarket | null>(null);
  const [selectedSide, setSelectedSide] = useState<"yes" | "no" | null>(null);
  const dragStartY = useRef<number>(0);

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    await refetchMarkets(clipId);
    setLoading(false);
  }, [clipId, refetchMarkets]);

  useEffect(() => {
    if (open) {
      loadMarkets();
    }
  }, [open, loadMarkets]);

  function handleSelectSide(market: ClipMarket, side: "yes" | "no") {
    setSelectedMarket(market);
    setSelectedSide(side);
  }

  function handleBack() {
    setSelectedMarket(null);
    setSelectedSide(null);
  }

  function handleDragStart(e: React.PointerEvent) {
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function handleDragMove(e: React.PointerEvent) {
    const dy = e.clientY - dragStartY.current;
    if (dy > DRAG_CLOSE_THRESHOLD_PX) {
      onOpenChange(false);
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[80dvh] rounded-t-2xl px-4 pb-6" showClose={false}>
        <div
          className="flex justify-center pt-2 pb-1 -mt-1 cursor-grab active:cursor-grabbing touch-none"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerCancel={(e) => (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)}
          onPointerUp={(e) => {
            const dy = e.clientY - dragStartY.current;
            if (dy > 40) onOpenChange(false);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && onOpenChange(false)}
          aria-label="Drag down to close"
        >
          <span className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
        </div>
        <SheetHeader className="px-0">
          {selectedMarket ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleBack}
                className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-secondary"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <SheetTitle className="text-base">Place Your Bet</SheetTitle>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <SheetTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" />
                Predictions
              </SheetTitle>
              <Badge variant="secondary" className="text-xs">
                {markets.length} market{markets.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="mt-4 h-[calc(100%-9rem)] px-1">
          {selectedMarket && selectedSide ? (
            <BetForm
              marketId={selectedMarket.id}
              side={selectedSide}
              odds={
                selectedMarket.market_sides.find(
                  (s) => s.side_key === selectedSide
                )?.current_odds_decimal || 2
              }
              canonicalText={selectedMarket.canonical_text}
              onBetPlaced={() => {
                handleBack();
                refetchMarkets(clipId);
              }}
            />
          ) : (
            <div className="space-y-3 pb-6">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-28 w-full rounded-xl" />
                ))
              ) : (
                <>
                  {markets.map((market) => {
                    const yesSide = market.market_sides.find(
                      (s) => s.side_key === "yes"
                    );
                    const noSide = market.market_sides.find(
                      (s) => s.side_key === "no"
                    );

                    return (
                      <PredictionChip
                        key={market.id}
                        canonicalText={market.canonical_text}
                        yesProbability={yesSide?.probability || 0.5}
                        noProbability={noSide?.probability || 0.5}
                        yesOdds={yesSide?.current_odds_decimal || 2}
                        noOdds={noSide?.current_odds_decimal || 2}
                        yesPool={yesSide?.pool_amount || 0}
                        noPool={noSide?.pool_amount || 0}
                        onSelectSide={(side) =>
                          handleSelectSide(market, side)
                        }
                      />
                    );
                  })}

                  {markets.length === 0 && (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      No predictions yet. Be the first!
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </ScrollArea>

        {!selectedMarket && (
          <>
            <Separator className="my-4" />
            <div className="px-1">
              <AddPrediction
                clipNodeId={clipId}
                onPredictionAdded={loadMarkets}
                existingPredictions={markets.map((m) => m.canonical_text)}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
