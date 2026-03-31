"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useUserStore } from "@/stores/user-store";
import { useFeedStore } from "@/stores/feed-store";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { formatCompactNumber } from "@/lib/utils";
import {
  ChevronUp,
  MessageSquare,
  Eye,
  TrendingUp,
  GitBranch,
  Timer,
  MoreVertical,
  Trash2,
  Volume2,
  VolumeX,
  CheckCircle2,
  Wand2,
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
          {isActive && showFeedBets && loopCount >= 1 && isBettingOpen && !isExpired && (
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
        <button
          type="button"
          className="flex flex-col items-center gap-1 touch-manipulation"
          aria-label="View count"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
            <Eye className="h-5 w-5 text-white" />
          </div>
          <span className="text-[10px] text-white/80">
            {formatCompactNumber(clip.view_count)}
          </span>
        </button>

        {!isSettled && (
          <>
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

      {/* Betting CTA (only when not settled) */}
      {isBettingOpen && !isExpired && (
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
