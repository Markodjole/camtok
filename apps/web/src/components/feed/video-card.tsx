"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FeedClip } from "@/actions/clips";
import { archiveClip } from "@/actions/clips";
import { VideoPlayer } from "@/components/clip/video-player";
import { BettingBottomSheet } from "@/components/betting/betting-bottom-sheet";
import { LoopBetOverlay } from "@/components/feed/loop-bet-overlay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useUserStore } from "@/stores/user-store";
import { getUserQueued } from "@/lib/supabase/client";
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
} from "lucide-react";

interface VideoCardProps {
  clip: FeedClip;
  isActive: boolean;
}

export function VideoCard({ clip, isActive }: VideoCardProps) {
  const [showBetting, setShowBetting] = useState(false);
  const [showLoopOverlay, setShowLoopOverlay] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const { profile } = useUserStore();
  const router = useRouter();
  const { toast } = useToast();
  const isBettingOpen = clip.status === "betting_open";
  const deadline = clip.betting_deadline
    ? new Date(clip.betting_deadline)
    : null;
  const isExpired = deadline ? deadline < new Date() : false;
  const userId = currentUserId ?? profile?.id ?? null;
  const isOwner = Boolean(userId && String(clip.creator_user_id) === String(userId));

  useEffect(() => {
    getUserQueued().then(({ data: { user } }) => {
      setCurrentUserId(user?.id ?? null);
    });
  }, []);

  const handleLoopEnd = useCallback(() => {
    if (isBettingOpen && !isExpired) setShowLoopOverlay(true);
  }, [isBettingOpen, isExpired]);

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

  return (
    <div className="relative h-full w-full snap-start">
      <VideoPlayer
        src={clip.video_storage_path}
        poster={clip.poster_storage_path}
        pauseStartMs={clip.pause_start_ms}
        durationMs={clip.duration_ms}
        isActive={isActive}
        onLoopEnd={handleLoopEnd}
      />

      {/* Delete (own posts only) — top right */}
      {isOwner && (
        <div className="absolute right-3 top-3 z-30">
          {showDeleteMenu ? (
            <div className="rounded-lg bg-black/80 backdrop-blur-sm border border-border overflow-hidden shadow-lg">
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
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-muted touch-manipulation"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDeleteMenu(true)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm text-white/90 hover:bg-black/70 hover:text-white touch-manipulation"
              aria-label="Options"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
          )}
        </div>
      )}

      {/* After first loop: semi-transparent overlay with predictions + one-tap bet; video keeps playing */}
      {showLoopOverlay && isBettingOpen && !isExpired && (
        <LoopBetOverlay clipId={clip.id} />
      )}

      {/* Gradient overlay at bottom */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-black/80 to-transparent" />

      {/* Left side info */}
      <div className="absolute bottom-20 left-4 right-20 space-y-2">
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

        <h3 className="text-sm font-medium text-white/90 line-clamp-2">
          {clip.story_title}
        </h3>

        {clip.scene_summary && (
          <p className="text-xs text-white/60 line-clamp-1">
            {clip.scene_summary}
          </p>
        )}

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

      {/* Right side actions — tap to open predictions / bet */}
      <div className="absolute bottom-24 right-3 flex flex-col items-center gap-5 z-10">
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
          onClick={() => setShowBetting(true)}
          className="flex flex-col items-center gap-1 touch-manipulation"
          aria-label="Predictions"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 backdrop-blur-sm">
            <MessageSquare className="h-5 w-5 text-white" />
          </div>
        </button>
      </div>

      {/* Betting CTA */}
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

      {clip.status === "settled" && (
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
