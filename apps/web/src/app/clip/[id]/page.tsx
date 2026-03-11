"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { VideoPlayer } from "@/components/clip/video-player";
import { PredictionChip } from "@/components/betting/prediction-chip";
import { AddPrediction } from "@/components/betting/add-prediction";
import { BetForm } from "@/components/betting/bet-form";
import { ResultCard } from "@/components/betting/result-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatRelativeTime } from "@/lib/utils";
import { archiveClip, getClipById, getClipMarkets } from "@/actions/clips";
import { getUserBetsForClip } from "@/actions/bets";
import { GitBranch, Clock, TrendingUp, ChevronLeft, Users } from "lucide-react";
import Link from "next/link";
import { useUserStore } from "@/stores/user-store";
import { useToast } from "@/components/ui/toast";

interface MarketData {
  id: string;
  canonical_text: string;
  market_key: string;
  status: string;
  market_sides: Array<{
    id: string;
    side_key: "yes" | "no";
    current_odds_decimal: number;
    probability: number;
    pool_amount: number;
    bet_count: number;
  }>;
}

export default function ClipDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [clip, setClip] = useState<Record<string, unknown> | null>(null);
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [userBets, setUserBets] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<MarketData | null>(null);
  const [selectedSide, setSelectedSide] = useState<"yes" | "no" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { profile } = useUserStore();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    async function load() {
      const [clipData, marketsData, betsData] = await Promise.all([
        getClipById(id),
        getClipMarkets(id),
        getUserBetsForClip(id),
      ]);
      setClip(clipData);
      setMarkets(marketsData as unknown as MarketData[]);
      setUserBets(betsData);
      setLoading(false);
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <AppShell>
        <div className="h-full p-4">
          <Skeleton className="mb-4 h-64 w-full rounded-xl" />
          <Skeleton className="mb-2 h-6 w-3/4" />
          <Skeleton className="mb-4 h-4 w-1/2" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="mb-3 h-28 w-full rounded-xl" />
          ))}
        </div>
      </AppShell>
    );
  }

  if (!clip) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center">
          <p className="text-muted-foreground">Clip not found</p>
        </div>
      </AppShell>
    );
  }

  const story = (clip.stories || {}) as Record<string, string>;
  const profile = (clip.profiles || {}) as Record<string, string>;
  const status = String(clip.status || "");
  const isBettingOpen = status === "betting_open";
  const isSettled = status === "settled";
  const depth = Number(clip.depth || 0);
  const sceneSummary = String(clip.scene_summary || "");
  const parentClipId = clip.parent_clip_node_id ? String(clip.parent_clip_node_id) : null;
  const isOwner = profile && clip.creator_user_id === profile.id;

  async function refreshMarkets() {
    const data = await getClipMarkets(id);
    setMarkets(data as unknown as MarketData[]);
    const bets = await getUserBetsForClip(id);
    setUserBets(bets);
  }

  async function handleDelete() {
    if (deleting) return;
    if (!window.confirm("Delete this post? It will be removed from the feed.")) return;
    setDeleting(true);
    const result = await archiveClip(String(id));
    setDeleting(false);
    if ((result as { error?: string }).error) {
      toast({
        title: "Delete failed",
        description: (result as { error?: string }).error || "Something went wrong",
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Post deleted", description: "Your clip is no longer visible in the feed." });
    router.push("/feed");
  }

  return (
    <AppShell>
      <ScrollArea className="h-full">
        <div className="pb-8">
          {/* Video */}
          <div className="relative aspect-[9/12] max-h-[50dvh] w-full">
            <VideoPlayer
              src={clip.video_storage_path as string}
              poster={clip.poster_storage_path as string}
              pauseStartMs={clip.pause_start_ms as number}
              isActive
            />
            <Link
              href="/feed"
              className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm"
            >
              <ChevronLeft className="h-4 w-4 text-white" />
            </Link>
          </div>

          {/* Clip info */}
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-lg font-bold">{story.title || "Untitled"}</h1>
              <div className="flex items-center gap-2">
                {isOwner && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="border-destructive text-destructive hover:bg-destructive/10"
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </Button>
                )}
                <Badge
                  variant={
                    isBettingOpen
                      ? "default"
                      : isSettled
                        ? "success"
                        : "secondary"
                  }
                >
                  {(status as string).replace(/_/g, " ")}
                </Badge>
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />@{profile.username}
              </span>
              {depth > 0 && (
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  Depth {depth}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatRelativeTime(clip.published_at as string)}
              </span>
            </div>

            {sceneSummary && (
              <p className="text-sm text-muted-foreground">
                {sceneSummary}
              </p>
            )}

            <Separator />

            {/* User's bets on this clip */}
            {userBets.length > 0 && (
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Your Bets
                </h3>
                <div className="space-y-2">
                  {userBets.map((bet) => (
                    <div
                      key={bet.id as string}
                      className="flex items-center justify-between rounded-lg border border-border bg-card/50 p-3"
                    >
                      <div>
                        <Badge
                          variant={bet.side_key === "yes" ? "success" : "destructive"}
                          className="text-[10px]"
                        >
                          {(bet.side_key as string).toUpperCase()}
                        </Badge>
                        <span className="ml-2 text-sm">
                          ${Number(bet.stake_amount).toFixed(2)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {Number(bet.odds_at_bet).toFixed(2)}x
                      </span>
                    </div>
                  ))}
                </div>
                <Separator className="my-3" />
              </div>
            )}

            {/* Settlement results */}
            {isSettled && markets.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Results</h3>
                <div className="space-y-2">
                  {markets.map((market) => (
                    <ResultCard
                      key={market.id}
                      market={market}
                      userBets={userBets.filter(
                        (b) => b.prediction_market_id === market.id
                      )}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {/* Active markets */}
            {!isSettled ? (
              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  Predictions
                  <Badge variant="secondary" className="text-[10px]">
                    {markets.length}
                  </Badge>
                </h3>

                {selectedMarket && selectedSide ? (
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedMarket(null);
                        setSelectedSide(null);
                      }}
                      className="mb-2"
                    >
                      <ChevronLeft className="mr-1 h-3 w-3" />
                      Back to markets
                    </Button>
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
                        setSelectedMarket(null);
                        setSelectedSide(null);
                        refreshMarkets();
                      }}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    {markets.map((market) => {
                      const yes = market.market_sides.find(
                        (s) => s.side_key === "yes"
                      );
                      const no = market.market_sides.find(
                        (s) => s.side_key === "no"
                      );

                      return (
                        <PredictionChip
                          key={market.id}
                          canonicalText={market.canonical_text}
                          yesProbability={yes?.probability || 0.5}
                          noProbability={no?.probability || 0.5}
                          yesOdds={yes?.current_odds_decimal || 2}
                          noOdds={no?.current_odds_decimal || 2}
                          yesPool={yes?.pool_amount || 0}
                          noPool={no?.pool_amount || 0}
                          onSelectSide={(side) => {
                            setSelectedMarket(market);
                            setSelectedSide(side);
                          }}
                        />
                      );
                    })}

                    {markets.length === 0 && (
                      <p className="py-4 text-center text-sm text-muted-foreground">
                        No predictions yet
                      </p>
                    )}
                  </div>
                )}

                {isBettingOpen && !selectedMarket && (
                  <>
                    <Separator className="my-3" />
                    <AddPrediction
                      clipNodeId={id}
                      onPredictionAdded={refreshMarkets}
                    />
                  </>
                )}
              </div>
            ) : null}

            {/* Story navigation */}
            {parentClipId ? (
              <div className="mt-4">
                <Link href={`/clip/${parentClipId}`}>
                  <Button variant="outline" size="sm" className="w-full gap-2">
                    <GitBranch className="h-3 w-3" />
                    View parent clip
                  </Button>
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </ScrollArea>
    </AppShell>
  );
}
