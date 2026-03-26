"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useFeedStore } from "@/stores/feed-store";
import { cn } from "@/lib/utils";
import { Volume2, VolumeX, Play, Pause } from "lucide-react";

interface VideoPlayerProps {
  src: string | null;
  poster?: string | null;
  pauseStartMs?: number | null;
  durationMs?: number | null;
  isActive?: boolean;
  className?: string;
  /** Called at end of each loop (at pause point or video end) */
  onLoopEnd?: () => void;
  /** When true, video stays paused (e.g. while loop overlay is shown) */
  pausedByParent?: boolean;
}

export function VideoPlayer({
  src,
  poster,
  pauseStartMs,
  isActive = true,
  className,
  onLoopEnd,
  pausedByParent = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loopEndCalledRef = useRef(false);
  const prevTimeRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [isExtremeLandscape, setIsExtremeLandscape] = useState(false);
  const isMuted = useFeedStore((s) => s.isMuted);
  const toggleMute = useFeedStore((s) => s.toggleMute);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (pausedByParent) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    if (isActive) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      video.currentTime = 0;
      setIsPlaying(false);
    }
  }, [isActive, pausedByParent]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isMuted;
  }, [isMuted]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const t = video.currentTime;
    const prev = prevTimeRef.current;
    prevTimeRef.current = t;

    const pct = (t / video.duration) * 100;
    setProgress(isNaN(pct) ? 0 : pct);

    const atPausePoint = pauseStartMs && t * 1000 >= pauseStartMs;
    const atVideoEnd = !pauseStartMs && video.duration > 0 && t >= video.duration - 0.25;
    const justLooped = !pauseStartMs && prev > 1 && t < 0.5;

    if (atPausePoint) {
      if (!loopEndCalledRef.current) {
        loopEndCalledRef.current = true;
        onLoopEnd?.();
      }
      video.currentTime = 0;
    } else if (atVideoEnd || justLooped) {
      if (!loopEndCalledRef.current) {
        loopEndCalledRef.current = true;
        onLoopEnd?.();
      }
    } else if (t < 0.5) {
      loopEndCalledRef.current = false;
    }
  }, [pauseStartMs, onLoopEnd]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, []);

  // Supabase storage path → full public URL (avoids 404 from relative /clips/... on same origin)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const toStorageUrl = (path: string | null | undefined) => {
    if (!path) return undefined;
    if (path.startsWith("http")) return path;
    return `${supabaseUrl}/storage/v1/object/public/media/${path.replace(/^\//, "")}`;
  };
  const fullSrc = toStorageUrl(src);
  const demoSrc =
    fullSrc ||
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  const posterUrl = toStorageUrl(poster) ?? undefined;

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1;
    // Treat wide clips (e.g. laptop aspect on phone) as extreme landscape
    setIsExtremeLandscape(ratio > 1.3);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "touch") return;
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      setIsPlaying(false);
    },
    []
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "touch") return;
      // Do nothing on release; video stays paused until user explicitly presses play.
    },
    []
  );

  return (
    <div
      className={cn("relative h-full w-full bg-black overflow-hidden", className)}
      onClick={() => setShowControls((s) => !s)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <video
        ref={videoRef}
        src={demoSrc}
        poster={posterUrl}
        loop
        playsInline
        muted={isMuted}
        preload={isActive ? "auto" : "metadata"}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        className={cn(
          "h-full w-full object-contain",
          // Slight zoom for wide landscape videos on tall screens:
          // reduce huge black bars but still keep most of the scene visible.
          isExtremeLandscape && "scale-[1.25] origin-center"
        )}
      />

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10">
        <div
          className="h-full bg-primary transition-all duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Pause point marker */}
      {pauseStartMs && (
        <div
          className="absolute bottom-0 h-1 w-1 rounded-full bg-warning"
          style={{ left: `${(pauseStartMs / ((videoRef.current?.duration || 10) * 1000)) * 100}%` }}
        />
      )}

      {/* Controls overlay */}
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity",
          showControls ? "opacity-100" : "opacity-0"
        )}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm"
        >
          {isPlaying ? (
            <Pause className="h-8 w-8 text-white" />
          ) : (
            <Play className="ml-1 h-8 w-8 text-white" />
          )}
        </button>
      </div>
    </div>
  );
}
