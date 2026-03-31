"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useFeedStore } from "@/stores/feed-store";
import { getMediaUrl } from "@/lib/utils";
import { ResultOverlay } from "./result-overlay";
import { getUserBetsForClip } from "@/actions/bets";
import type { FeedClip } from "@/actions/clips";
import { RotateCcw } from "lucide-react";

type Phase = "part1" | "part2" | "result";

interface ResolvedClipPlayerProps {
  clip: FeedClip;
  isActive: boolean;
}

export function ResolvedClipPlayer({ clip, isActive }: ResolvedClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const part2PreloadRef = useRef<HTMLVideoElement>(null);
  const browserForcedMuteRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("part1");
  const [userBets, setUserBets] = useState<Array<Record<string, unknown>>>([]);
  const [progress, setProgress] = useState(0);
  const isMuted = useFeedStore((s) => s.isMuted);

  const part1Url = getMediaUrl(clip.video_storage_path) ?? "";
  const part2Url = getMediaUrl(clip.part2_video_storage_path ?? undefined) ?? "";
  const winningOutcome = clip.winning_outcome_text ?? "Settled";
  const resolutionReason = clip.resolution_reason_text ?? "Resolution complete.";

  const tryPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isMuted;
    video.play()
      .then(() => {
        browserForcedMuteRef.current = false;
      })
      .catch(() => {
        // Browser blocked autoplay with audio: fallback to muted autoplay.
        video.muted = true;
        browserForcedMuteRef.current = true;
        video.play().catch(() => {});
      });
  }, [isMuted]);

  useEffect(() => {
    if (clip.status !== "settled") return;
    getUserBetsForClip(clip.id).then(setUserBets);
  }, [clip.id, clip.status]);

  // Playback control
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isActive) {
      video.pause();
      setPhase("part1");
      setProgress(0);
      return;
    }
    if (phase === "part1") {
      video.src = part1Url;
      video.currentTime = 0;
      const onCanPlay = () => {
        tryPlay();
      };
      video.addEventListener("canplay", onCanPlay, { once: true });
      video.load();
      return () => video.removeEventListener("canplay", onCanPlay);
    } else if (phase === "part2" && part2Url) {
      video.src = part2Url;
      video.currentTime = 0;
      const onCanPlay = () => {
        tryPlay();
      };
      video.addEventListener("canplay", onCanPlay, { once: true });
      video.load();
      return () => video.removeEventListener("canplay", onCanPlay);
    }
  }, [isActive, phase, part1Url, part2Url, tryPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!isActive) return;
    // Keep muted state synced, unless browser forced mute for autoplay policy.
    video.muted = browserForcedMuteRef.current ? true : isMuted;
  }, [isMuted, isActive]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const video = videoRef.current;
      if (!video || !isActive || phase === "result") return;
      if (video.readyState < 2) video.load();
      if (video.paused) tryPlay();
    };
    const handleFocus = () => {
      const video = videoRef.current;
      if (!video || !isActive || phase === "result") return;
      if (video.paused) tryPlay();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isActive, phase, tryPlay]);

  // Preload part2 while part1 plays
  useEffect(() => {
    const preloadVideo = part2PreloadRef.current;
    if (!preloadVideo || !part2Url || !isActive) return;
    preloadVideo.load();
  }, [part2Url, isActive]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    setProgress((video.currentTime / video.duration) * 100);
  }, []);

  const handleEnded = useCallback(() => {
    setPhase((p) => {
      if (p === "part1") return "part2";
      if (p === "part2") return "result";
      return p;
    });
  }, []);

  const handleReplay = useCallback(() => {
    setPhase("part1");
    setProgress(0);
  }, []);

  if (!part2Url) return null;

  return (
    <div className="relative h-full w-full bg-black">
      {/* Hidden preload element for part2 */}
      <video
        ref={part2PreloadRef}
        src={part2Url}
        playsInline
        muted
        preload="auto"
        className="hidden"
        aria-hidden
      />

      {/* Main video player */}
      <video
        ref={videoRef}
        src={phase === "part2" ? part2Url : part1Url}
        autoPlay
        playsInline
        muted={isMuted}
        preload="auto"
        onEnded={handleEnded}
        onTimeUpdate={handleTimeUpdate}
        className="h-full w-full object-contain"
      />

      {/* RESOLUTION label while Part 2 plays */}
      {phase === "part2" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex justify-center pt-8 pointer-events-none" aria-hidden>
          <span className="text-lg font-bold tracking-widest text-white/95 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            RESOLUTION
          </span>
        </div>
      )}

      {/* Dual-color progress bar */}
      {phase !== "result" && (
        <div className="absolute bottom-0 left-0 right-0 z-20 h-[4px] bg-white/15">
          <div
            className={`h-full rounded-r-full will-change-[width] ${
              phase === "part2" ? "bg-primary" : "bg-white/80"
            }`}
            style={{ width: `${progress}%`, transition: "width 0.25s linear" }}
          />
        </div>
      )}

      {/* Result screen */}
      {phase === "result" && (
        <ResultOverlay
          winningOutcomeText={winningOutcome}
          resolutionReasonText={resolutionReason}
          userBets={
            userBets as Array<{
              id: string;
              side_key: string;
              stake_amount: number;
              payout_amount: number | null;
              status: string;
            }>
          }
        />
      )}

      {/* Replay button — shown on result screen */}
      {phase === "result" && (
        <button
          type="button"
          onClick={handleReplay}
          className="absolute left-1/2 top-[38%] z-30 -translate-x-1/2 flex items-center gap-2 rounded-full bg-white/15 backdrop-blur-sm px-5 py-2.5 text-white/90 hover:bg-white/25 transition-colors touch-manipulation"
        >
          <RotateCcw className="h-5 w-5" />
          <span className="text-sm font-medium">Replay</span>
        </button>
      )}
    </div>
  );
}
