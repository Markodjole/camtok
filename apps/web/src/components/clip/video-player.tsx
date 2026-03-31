"use client";

import { useRef, useEffect, useState, useCallback, type MouseEvent } from "react";
import { useFeedStore } from "@/stores/feed-store";
import { cn } from "@/lib/utils";
import { Play, Pause } from "lucide-react";

interface VideoPlayerProps {
  src: string | null;
  poster?: string | null;
  pauseStartMs?: number | null;
  durationMs?: number | null;
  isActive?: boolean;
  className?: string;
  onLoopEnd?: () => void;
  pausedByParent?: boolean;
  forceMuted?: boolean;
}

export function VideoPlayer({
  src,
  poster,
  pauseStartMs,
  isActive = true,
  className,
  onLoopEnd,
  pausedByParent = false,
  forceMuted = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPausedTapAtRef = useRef(0);
  const loopEndCalledRef = useRef(false);
  const prevTimeRef = useRef(0);
  const browserForcedMuteRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [isExtremeLandscape, setIsExtremeLandscape] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState("50% 50%");
  const isMuted = useFeedStore((s) => s.isMuted);
  const toggleMute = useFeedStore((s) => s.toggleMute);

  const tryPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = isMuted;
    video.play()
      .then(() => {
        setIsPlaying(true);
        browserForcedMuteRef.current = false;
      })
      .catch(() => {
        video.muted = true;
        browserForcedMuteRef.current = true;
        video.play()
          .then(() => setIsPlaying(true))
          .catch(() => {});
      });
  }, [isMuted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (pausedByParent) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    if (isActive) {
      tryPlay();
    } else {
      video.pause();
      video.currentTime = 0;
      setIsPlaying(false);
    }
  }, [isActive, pausedByParent, tryPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onCanPlay = () => {
      if (isActive && !pausedByParent && video.paused) {
        tryPlay();
      }
    };
    video.addEventListener("canplay", onCanPlay);
    return () => video.removeEventListener("canplay", onCanPlay);
  }, [isActive, pausedByParent, tryPlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    browserForcedMuteRef.current = false;
    video.muted = forceMuted || isMuted;
  }, [isMuted, forceMuted]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const video = videoRef.current;
      if (!video || !isActive || pausedByParent) return;
      if (video.readyState < 2) video.load();
      tryPlay();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const handleFocus = () => {
      const video = videoRef.current;
      if (!video || !isActive || pausedByParent) return;
      if (video.paused) tryPlay();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isActive, pausedByParent, tryPlay]);

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

  const handleTap = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // If currently playing, always pause immediately (never intercept with unmute logic).
    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
      return;
    }

    // If browser forced muted autoplay, first resume tap should unmute + play.
    if (browserForcedMuteRef.current) {
      browserForcedMuteRef.current = false;
      video.muted = false;
    }
    video.play();
    setIsPlaying(true);
  }, []);

  const showControlsBriefly = useCallback(() => {
    setShowControls(true);
    if (controlsHideTimeoutRef.current) clearTimeout(controlsHideTimeoutRef.current);
    controlsHideTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
      controlsHideTimeoutRef.current = null;
    }, 1000);
  }, []);

  const handleContainerTap = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;

    // While paused, delay single-tap action briefly so a second quick tap can toggle zoom.
    if (video.paused) {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
      const now = Date.now();
      const withinDoubleTapWindow = now - lastPausedTapAtRef.current < 280;
      lastPausedTapAtRef.current = now;

      if (withinDoubleTapWindow) {
        if (pausedTapTimeoutRef.current) {
          clearTimeout(pausedTapTimeoutRef.current);
          pausedTapTimeoutRef.current = null;
        }
        setZoomOrigin(`${x}% ${y}%`);
        setIsZoomed((z) => !z);
        showControlsBriefly();
        return;
      }

      if (pausedTapTimeoutRef.current) clearTimeout(pausedTapTimeoutRef.current);
      pausedTapTimeoutRef.current = setTimeout(() => {
        handleTap();
        showControlsBriefly();
        pausedTapTimeoutRef.current = null;
      }, 280);
      return;
    }

    handleTap();
    showControlsBriefly();
  }, [handleTap, showControlsBriefly]);

  useEffect(() => {
    return () => {
      if (controlsHideTimeoutRef.current) clearTimeout(controlsHideTimeoutRef.current);
      if (pausedTapTimeoutRef.current) clearTimeout(pausedTapTimeoutRef.current);
    };
  }, []);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const toStorageUrl = (path: string | null | undefined) => {
    if (!path) return undefined;
    if (path.startsWith("http")) return path;
    return `${supabaseUrl}/storage/v1/object/public/media/${path.replace(/^\//, "")}`;
  };
  const fullSrc = toStorageUrl(src);
  const posterUrl = toStorageUrl(poster) ?? undefined;

  if (!fullSrc) {
    return <div className={cn("relative h-full w-full bg-black", className)} />;
  }

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1;
    setIsExtremeLandscape(ratio > 1.3);
  }, []);

  return (
    <div
      className={cn("relative h-full w-full bg-black overflow-hidden", className)}
      onClick={handleContainerTap}
    >
      <video
        ref={videoRef}
        src={fullSrc}
        poster={posterUrl}
        loop
        playsInline
        muted={forceMuted || isMuted}
        preload={isActive ? "auto" : "metadata"}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        className={cn(
          "h-full w-full object-contain transition-transform duration-200 ease-out",
          isZoomed
            ? (isExtremeLandscape ? "scale-[2.1]" : "scale-[1.8]")
            : (isExtremeLandscape ? "scale-[1.25]" : null)
        )}
        style={{ transformOrigin: isZoomed ? zoomOrigin : "50% 50%" }}
      />

      <div className="absolute bottom-0 left-0 right-0 z-20 h-[4px] bg-white/15">
        <div
          className="h-full bg-white/80 rounded-r-full will-change-[width]"
          style={{ width: `${progress}%`, transition: "width 0.25s linear" }}
        />
        {pauseStartMs && (
          <div
            className="absolute top-1/2 -translate-y-1/2 h-[6px] w-[6px] rounded-full bg-warning"
            style={{ left: `${(pauseStartMs / ((videoRef.current?.duration || 10) * 1000)) * 100}%` }}
          />
        )}
      </div>

      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity",
          showControls ? "opacity-100" : "opacity-0"
        )}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleTap();
            showControlsBriefly();
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
