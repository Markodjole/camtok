"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FeedClip } from "@/actions/clips";
import { archiveClip, setResolveVideoPath } from "@/actions/clips";
import { startContinuation } from "@/actions/continuation";
import { VideoPlayer } from "@/components/clip/video-player";
import { BettingBottomSheet } from "@/components/betting/betting-bottom-sheet";
import { LoopBetOverlay } from "@/components/feed/loop-bet-overlay";
import { CommentsFirstLoop } from "@/components/feed/comments-first-loop";
import { ResolvedClipPlayer } from "@/components/feed/resolved-clip-player";
import { FeedClipAiChat } from "@/components/feed/feed-clip-ai-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useUserStore } from "@/stores/user-store";
import { useFeedStore } from "@/stores/feed-store";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { formatCompactNumber, getMediaUrl } from "@/lib/utils";
import {
  ChevronUp,
  MessageSquare,
  TrendingUp,
  GitBranch,
  Timer,
  MoreVertical,
  Trash2,
  Volume2,
  VolumeX,
  CheckCircle2,
  Wand2,
  Loader2,
  X,
} from "lucide-react";

interface VideoCardProps {
  clip: FeedClip;
  isActive: boolean;
}

export function VideoCard({ clip, isActive }: VideoCardProps) {
  const [showBetting, setShowBetting] = useState(false);
  const [loopCount, setLoopCount] = useState(0);
  const [overlayExpanded, setOverlayExpanded] = useState(false);
  const [openAllOverlaySignal, setOpenAllOverlaySignal] = useState(0);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [aiResolving, setAiResolving] = useState(false);
  const resolveInputRef = useRef<HTMLInputElement>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const { profile } = useUserStore();
  const router = useRouter();
  const { toast } = useToast();
  const isSettled = clip.status === "settled";
  const isResolvedWithPart2 = isSettled && !!clip.part2_video_storage_path;
  const isBettingOpen = clip.status === "betting_open";
  const isContinuationInProgress =
    aiResolving || clip.status === "continuation_generating" || clip.status === "betting_locked";
  const deadline = clip.betting_deadline
    ? new Date(clip.betting_deadline)
    : null;
  const isExpired = deadline ? deadline < new Date() : false;
  const userId = currentUserId ?? profile?.id ?? null;
  const isOwner = Boolean(userId && String(clip.creator_user_id) === String(userId));
  const isMuted = useFeedStore((s) => s.isMuted);
  const toggleMute = useFeedStore((s) => s.toggleMute);
  const showFeedBets = useFeedStore((s) => s.showFeedBets);
  const setShowFeedBets = useFeedStore((s) => s.setShowFeedBets);

  useEffect(() => {
    getUserQueued().then(({ data: { user } }) => {
      setCurrentUserId(user?.id ?? null);
    });
  }, []);

  const handleLoopEnd = useCallback(() => {
    setLoopCount((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!showFeedBets) {
      setOverlayExpanded(false);
    }
  }, [showFeedBets]);

  useEffect(() => {
    if (isContinuationInProgress) {
      setShowBetting(false);
      setShowFeedBets(false);
    }
  }, [isContinuationInProgress, setShowFeedBets]);

  const openAllPredictionsOverlay = useCallback(() => {
    // Show in-video prediction overlay (all cards + comments) instead of bottom drawer.
    setShowFeedBets(true);
    setLoopCount((prev) => (prev >= 1 ? prev : 1));
    setOpenAllOverlaySignal((n) => n + 1);
  }, [setShowFeedBets]);

  async function handleResolveFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowDeleteMenu(false);
    setResolving(true);
    e.target.value = "";

    const { data: { user } } = await getUserQueued();
    if (!user) {
      setResolving(false);
      toast({ title: "Please sign in", variant: "destructive" });
      return;
    }

    const ext = file.name.split(".").pop() || "mp4";
    const storagePath = `clips/${user.id}/${clip.id}_part2.${ext}`;
    const supabase = createBrowserClient();

    const { error: uploadError } = await supabase.storage
      .from("media")
      .upload(storagePath, file, { upsert: true });

    if (uploadError) {
      setResolving(false);
      toast({
        title: "Upload failed",
        description: uploadError.message,
        variant: "destructive",
      });
      return;
    }

    const result = await setResolveVideoPath(clip.id, storagePath);
    setResolving(false);
    if ((result as { error?: string }).error) {
      toast({
        title: "Resolve failed",
        description: (result as { error?: string }).error,
        variant: "destructive",
      });
    } else {
      toast({ title: "Resolve video uploaded", variant: "success" });
      router.refresh();
    }
  }

  async function handleDelete() {
    setShowDeleteMenu(false);
    if (!window.confirm("Delete this post? It will be removed from the feed.")) return;
    setDeleting(true);
    const result = await archiveClip(clip.id);
    setDeleting(false);
    if ((result as { error?: string }).error) {
      toast({
        title: "Delete failed",
        description: (result as { error?: string }).error || "Something went wrong",
        variant: "destructive",
      });
    } else {
      toast({ title: "Post deleted", variant: "success" });
      router.refresh();
    }
  }

  async function handleAiResolve() {
    setShowDeleteMenu(false);
    setAiResolving(true);
    setShowBetting(false);
    setShowFeedBets(false);
    try {
      const result = await startContinuation(clip.id);
      if ("error" in result) {
        toast({
          title: "AI Resolve failed",
          description: String(result.error),
          variant: "destructive",
        });
      } else {
        toast({ title: "AI Resolve started — check terminal logs", variant: "success" });
        router.refresh();
      }
    } catch (err) {
      toast({
        title: "AI Resolve error",
        description: (err as Error)?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setAiResolving(false);
    }
  }

  return (
    <div className="relative h-full w-full snap-start">
      {isResolvedWithPart2 ? (
        <ResolvedClipPlayer clip={clip} isActive={isActive} />
      ) : (
        <>
          <VideoPlayer
            src={clip.video_storage_path}
            poster={clip.poster_storage_path}
            pauseStartMs={clip.pause_start_ms}
            durationMs={clip.duration_ms}
            isActive={isActive}
            onLoopEnd={handleLoopEnd}
            forceMuted={overlayExpanded}
          />
          {isActive && loopCount === 0 && (
            <CommentsFirstLoop clipId={clip.id} />
          )}
          {isActive && showFeedBets && loopCount >= 1 && isBettingOpen && !isExpired && !isContinuationInProgress && (
            <LoopBetOverlay
              clipId={clip.id}
              onExpandedChange={setOverlayExpanded}
              openAllSignal={openAllOverlaySignal}
            />
          )}
        </>
      )}

      {/* Gradient overlay at bottom */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/80 to-transparent" />

      {/* Left side info */}
      <div className="absolute bottom-14 left-4 right-20 space-y-2">
        <div className="flex items-center gap-2">
          <Link
            href={`/profile/${clip.creator_username}`}
            className="flex items-center gap-2"
          >
            <div className="h-8 w-8 rounded-full bg-primary/20 ring-2 ring-primary/50 flex items-center justify-center text-xs font-bold text-primary">
              {clip.creator_display_name[0]?.toUpperCase()}
            </div>
            <span className="text-sm font-semibold text-white">
              @{clip.creator_username}
            </span>
          </Link>
        </div>

        {clip.character_name && (
          <div className="flex flex-col gap-1.5">
            <Link
              href={`/character/${clip.character_slug || clip.character_id}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary/20 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm self-start"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {clip.character_name}
            </Link>
            {clip.character_betting_signals && (
              <CharacterQuickRead
                name={clip.character_name}
                signals={clip.character_betting_signals as Record<string, unknown>}
                imagePath={clip.poster_storage_path ?? null}
                tagline={clip.character_tagline ?? null}
                betCount={clip.bet_count}
              />
            )}
          </div>
        )}

        {clip.transcript?.trim() ? (
          <p
            className="rounded-md bg-black/60 px-2.5 py-1.5 text-left text-sm font-medium leading-snug text-white shadow-md [text-shadow:0_1px_2px_rgba(0,0,0,0.95)] line-clamp-4"
            role="status"
            aria-live="polite"
          >
            {clip.transcript.trim()}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          {clip.genre && (
            <Badge variant="secondary" className="text-[10px]">
              {clip.genre}
            </Badge>
          )}
          {clip.depth > 0 && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <GitBranch className="h-2.5 w-2.5" />
              Depth {clip.depth}
            </Badge>
          )}
        </div>
      </div>

      {/* Right side actions — mute, view count, predictions / bet; options (own posts) */}
      <div className="absolute bottom-24 right-3 flex flex-col items-center gap-5 z-10">
        <button
          type="button"
          onClick={toggleMute}
          className="flex flex-col items-center gap-1 touch-manipulation"
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
            {isMuted ? (
              <VolumeX className="h-5 w-5 text-white" />
            ) : (
              <Volume2 className="h-5 w-5 text-white" />
            )}
          </div>
        </button>
        <FeedClipAiChat clip={clip} isActive={isActive} />

        {!isSettled && !isContinuationInProgress && (
          <>
            <button
              type="button"
              onClick={openAllPredictionsOverlay}
              className="flex flex-col items-center gap-1 touch-manipulation"
              aria-label="Predictions"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
                <MessageSquare className="h-5 w-5 text-white" />
              </div>
            </button>
            <button
              type="button"
              onClick={() => setShowBetting(true)}
              className="flex flex-col items-center gap-1 touch-manipulation"
              aria-label="See predictions and bet"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
                <TrendingUp className="h-5 w-5 text-white" />
              </div>
              <span className="text-[10px] text-white/80">
                {formatCompactNumber(clip.bet_count)}
              </span>
            </button>
          </>
        )}

        {isOwner && (
          <div className="relative flex flex-col items-center gap-1">
            <input
              ref={resolveInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={handleResolveFile}
            />
            <button
              type="button"
              onClick={() => setShowDeleteMenu((v) => !v)}
              className="flex flex-col items-center gap-1 touch-manipulation"
              aria-label="Options"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
                <MoreVertical className="h-5 w-5 text-white" />
              </div>
            </button>
            {showDeleteMenu && (
              <div className="absolute right-0 bottom-full mb-1 min-w-[140px] rounded-lg border border-border bg-black/90 backdrop-blur-sm shadow-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    resolveInputRef.current?.click();
                    // close after opening picker (avoid unmounting input before click)
                    setTimeout(() => setShowDeleteMenu(false), 0);
                  }}
                  disabled={resolving}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white hover:bg-white/10 touch-manipulation disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {resolving ? "Uploading..." : "Resolve"}
                </button>
                <button
                  type="button"
                  onClick={handleAiResolve}
                  disabled={aiResolving || resolving}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-400/10 touch-manipulation disabled:opacity-50"
                >
                  <Wand2 className="h-4 w-4" />
                  {aiResolving ? "Resolving..." : "AI Resolve"}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 touch-manipulation disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {deleting ? "Deleting..." : "Delete post"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteMenu(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/80 hover:bg-white/10 touch-manipulation"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {isContinuationInProgress && (
        <div className="absolute inset-x-0 bottom-24 z-20 flex justify-center pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/55 px-3 py-1.5 text-xs text-white/90 backdrop-blur-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Continuation in progress...
          </div>
        </div>
      )}

      {/* Betting CTA (only when not settled) */}
      {isBettingOpen && !isExpired && !isContinuationInProgress && (
        <div className="absolute bottom-2 left-4 right-4 z-10">
          <Button
            onClick={() => setShowBetting(true)}
            className="w-full gap-2 rounded-xl bg-primary/90 backdrop-blur-sm"
            size="lg"
          >
            <ChevronUp className="h-4 w-4" />
            Predict what happens next
            {deadline && (
              <CountdownBadge deadline={deadline} />
            )}
          </Button>
        </div>
      )}

      {/* Settled: optional link to full clip (when not using resolved player) */}
      {isSettled && !isResolvedWithPart2 && (
        <div className="absolute bottom-2 left-4 right-4">
          <Link href={`/clip/${clip.id}`}>
            <Button
              variant="secondary"
              className="w-full gap-2 rounded-xl backdrop-blur-sm"
              size="lg"
            >
              View Results
            </Button>
          </Link>
        </div>
      )}

      <BettingBottomSheet
        clipId={clip.id}
        open={showBetting}
        onOpenChange={setShowBetting}
      />
    </div>
  );
}

function CountdownBadge({ deadline }: { deadline: Date }) {
  // Stable initial value so server and client match (avoids hydration mismatch)
  const [timeLeft, setTimeLeft] = useState("0:00");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const update = () => {
      const diff = deadline.getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft("0:00");
        return;
      }
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${minutes}:${seconds.toString().padStart(2, "0")}`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline, mounted]);

  return (
    <span className="ml-1 flex items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 text-xs">
      <Timer className="h-3 w-3" />
      {timeLeft}
    </span>
  );
}

function CharacterQuickRead({
  name,
  signals,
  imagePath,
  tagline,
  betCount,
}: {
  name: string;
  signals: Record<string, unknown>;
  imagePath?: string | null;
  tagline?: string | null;
  betCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const quickRead = Array.isArray(signals.quick_read) ? (signals.quick_read as string[]) : [];
  const exploitable = Array.isArray(signals.exploitable_tendencies)
    ? (signals.exploitable_tendencies as string[])
    : [];
  const pressure = Array.isArray(signals.pressure_response) ? (signals.pressure_response as string[]) : [];
  const tells = Array.isArray(signals.tells) ? (signals.tells as string[]) : [];
  const leverage = Array.isArray(signals.leverage_points) ? (signals.leverage_points as string[]) : [];
  const imageUrl = imagePath ? getMediaUrl(imagePath) : null;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  if (quickRead.length === 0) return null;

  const overlay =
    expanded && mounted
      ? createPortal(
          <div className="fixed inset-x-0 top-14 bottom-20 z-[100] bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="betting-edge-title">
            <button
              type="button"
              className="absolute inset-0"
              onClick={() => setExpanded(false)}
              aria-label="Close betting edge"
            />
            <div className="absolute inset-x-3 top-3 bottom-3 z-[101] mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-white/15 bg-black/90 shadow-2xl">
              <button
                type="button"
                className="fixed bottom-6 left-4 z-[103] flex items-center gap-2 rounded-full border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg touch-manipulation"
                onClick={() => setExpanded(false)}
                aria-label="Close betting edge"
              >
                <TrendingUp className="h-4 w-4 text-primary" />
                <span>Close</span>
              </button>
              <button
                type="button"
                className="absolute right-3 top-3 z-[102] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 touch-manipulation"
                onClick={() => setExpanded(false)}
                aria-label="Close betting edge"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex h-full flex-col overflow-hidden">
                {imageUrl ? (
                  <div className="shrink-0 border-b border-white/10">
                    <img
                      src={imageUrl}
                      alt={name}
                      className="h-36 w-full object-cover"
                    />
                  </div>
                ) : null}
                <div className="shrink-0 border-b border-white/10 px-5 pb-4 pt-4">
                <p
                  id="betting-edge-title"
                  className="text-lg font-semibold tracking-tight text-white"
                >
                  Betting edge · {name}
                </p>
                  <p className="mt-1 text-xs text-white/55">Patterns and tendencies from profile data</p>
                  {tagline ? (
                    <p className="mt-1 text-xs text-white/70">{tagline}</p>
                  ) : null}
                  {typeof betCount === "number" ? (
                    <p className="mt-1 text-[11px] text-white/50">{formatCompactNumber(betCount)} bets on this clip</p>
                  ) : null}
              </div>
                <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5 pb-10">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">
                  {name}&apos;s patterns
                </p>
                <ul className="space-y-3">
                  {quickRead.map((line) => (
                    <li key={line} className="text-[13px] leading-relaxed text-white/90">
                      • {line}
                    </li>
                  ))}
                </ul>
                {exploitable.length > 0 && (
                  <>
                    <p className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-yellow-400/95">
                      Exploitable
                    </p>
                    <ul className="space-y-3">
                      {exploitable.map((line) => (
                        <li key={line} className="text-[13px] leading-relaxed text-white/75">
                          → {line}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {pressure.length > 0 && (
                  <>
                    <p className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-cyan-300/95">
                      Under pressure
                    </p>
                    <ul className="space-y-3">
                      {pressure.map((line) => (
                        <li key={line} className="text-[13px] leading-relaxed text-white/75">
                          • {line}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {tells.length > 0 && (
                  <>
                    <p className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-fuchsia-300/95">
                      Tells
                    </p>
                    <ul className="space-y-3">
                      {tells.map((line) => (
                        <li key={line} className="text-[13px] leading-relaxed text-white/75">
                          • {line}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {leverage.length > 0 && (
                  <>
                    <p className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-emerald-300/95">
                      Leverage points
                    </p>
                    <ul className="space-y-3">
                      {leverage.map((line) => (
                        <li key={line} className="text-[13px] leading-relaxed text-white/75">
                          • {line}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {overlay}
      <div className="max-w-[240px]">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[10px] text-white/80 backdrop-blur-sm transition hover:bg-black/60"
        >
          <TrendingUp className="h-3 w-3 text-primary" />
          <span className="font-medium">Betting edge</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-80"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
    </>
  );
}
