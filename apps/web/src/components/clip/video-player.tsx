"use client";

import { useRef, useEffect, useState, useCallback, type MouseEvent } from "react";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";
import { cn } from "@/lib/utils";
import { Play, Pause, Loader2 } from "lucide-react";
import type { NormalizedBox } from "@/lib/frame-options/types";

export interface VideoFrameOption {
  id: string;
  label: string;
  shortLabel: string | null;
  normalizedBox: NormalizedBox;
}

interface VideoPlayerProps {
  src: string | null;
  poster?: string | null;
  subtitleText?: string | null;
  pauseStartMs?: number | null;
  durationMs?: number | null;
  isActive?: boolean;
  className?: string;
  onLoopEnd?: () => void;
  pausedByParent?: boolean;
  forceMuted?: boolean;
  /** Enable pause-to-detect: when user pauses, analyze current frame for tappable objects */
  enableFrameDetection?: boolean;
  /** Called when a user taps a detected frame option (label text for new prediction) */
  onFrameOptionTap?: (option: VideoFrameOption) => void;
}

export function VideoPlayer({
  src,
  poster,
  subtitleText,
  pauseStartMs,
  isActive = true,
  className,
  onLoopEnd,
  pausedByParent = false,
  forceMuted = false,
  enableFrameDetection = false,
  onFrameOptionTap,
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
  const [activeSubtitle, setActiveSubtitle] = useState("");
  const isMuted = useViewerChromeStore((s) => s.isMuted);
  const subtitleCuesRef = useRef<Array<{ start: number; end: number; text: string }>>([]);
  const activeSubtitleRef = useRef("");

  // Pause-to-detect state
  const [detecting, setDetecting] = useState(false);
  const [detectedOptions, setDetectedOptions] = useState<VideoFrameOption[]>([]);
  const detectAbortRef = useRef(0);

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

    if (subtitleCuesRef.current.length > 0) {
      const cue = subtitleCuesRef.current.find((c) => t >= c.start && t < c.end);
      const nextSubtitle = cue?.text ?? "";
      if (nextSubtitle !== activeSubtitleRef.current) {
        activeSubtitleRef.current = nextSubtitle;
        setActiveSubtitle(nextSubtitle);
      }
    } else if (activeSubtitleRef.current) {
      activeSubtitleRef.current = "";
      setActiveSubtitle("");
    }

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

  // Capture current video frame to base64 JPEG
  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.split(",")[1] ?? null;
  }, []);

  // Run detection on the paused frame
  const runPauseDetection = useCallback(async () => {
    if (!enableFrameDetection) return;
    const base64 = captureFrame();
    if (!base64) return;

    const thisRun = ++detectAbortRef.current;
    setDetecting(true);
    setDetectedOptions([]);

    try {
      const { detectFrameOptions } = await import("@/actions/frame-options");
      const result = await detectFrameOptions({ frameBase64: base64 });

      if (detectAbortRef.current !== thisRun) return;

      if (result.candidates.length > 0) {
        const mapped: VideoFrameOption[] = result.candidates.map((c) => ({
          id: c.tempId,
          label: c.label,
          shortLabel: c.shortLabel ?? null,
          normalizedBox: c.normalizedBox,
        }));
        setDetectedOptions(numberDuplicateLabels(mapped));
      }
    } catch {
      // Detection failed silently
    } finally {
      if (detectAbortRef.current === thisRun) {
        setDetecting(false);
      }
    }
  }, [enableFrameDetection, captureFrame]);

  // Cancel detection when unpaused
  const cancelDetection = useCallback(() => {
    detectAbortRef.current++;
    setDetecting(false);
    setDetectedOptions([]);
  }, []);

  const handleTap = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
      runPauseDetection();
      return;
    }

    // Unpausing — cancel any detection
    cancelDetection();
    if (browserForcedMuteRef.current) {
      browserForcedMuteRef.current = false;
      video.muted = false;
    }
    video.play();
    setIsPlaying(true);
  }, [runPauseDetection, cancelDetection]);

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

    // When hotspots are showing, ignore background taps so users can
    // interact with hotspot buttons without accidentally unpausing.
    if (video.paused && detectedOptions.length > 0) {
      return;
    }

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
  }, [handleTap, showControlsBriefly, detectedOptions.length]);

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

    if (subtitleText?.trim() && video.duration > 0) {
      subtitleCuesRef.current = buildSubtitleCues(subtitleText, video.duration);
    } else {
      subtitleCuesRef.current = [];
      activeSubtitleRef.current = "";
      setActiveSubtitle("");
    }
  }, [subtitleText]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !subtitleText?.trim() || !(video.duration > 0)) {
      subtitleCuesRef.current = [];
      activeSubtitleRef.current = "";
      setActiveSubtitle("");
      return;
    }
    subtitleCuesRef.current = buildSubtitleCues(subtitleText, video.duration);
    activeSubtitleRef.current = "";
    setActiveSubtitle("");
  }, [subtitleText]);

  const showDetectedOverlay = !isPlaying && (detecting || detectedOptions.length > 0);

  return (
    <div
      className={cn("relative h-full w-full bg-black overflow-hidden", className)}
      onClick={handleContainerTap}
    >
      <video
        ref={videoRef}
        src={fullSrc}
        poster={posterUrl}
        crossOrigin="anonymous"
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

      {activeSubtitle ? (
        <div className="pointer-events-none absolute bottom-8 left-3 right-3 z-20 flex justify-center">
          <p
            className="max-w-[92%] rounded-md bg-black/65 px-3 py-1.5 text-center text-sm font-medium leading-snug text-white shadow-md [text-shadow:0_1px_2px_rgba(0,0,0,0.95)]"
            role="status"
            aria-live="polite"
          >
            {activeSubtitle}
          </p>
        </div>
      ) : null}

      {/* Pause-to-detect: loading spinner */}
      {detecting && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 backdrop-blur-sm">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
            <span className="text-xs font-medium text-white/90">Detecting objects…</span>
          </div>
        </div>
      )}

      {/* Pause-to-detect: detected hotspots */}
      {!detecting && detectedOptions.length > 0 && !isPlaying && (
        <div className="absolute inset-0 z-[25] pointer-events-none">
          {detectedOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="pointer-events-auto absolute overflow-visible touch-manipulation group transition-all duration-300 animate-[fadeIn_0.3s_ease-out]"
              style={{
                left: `${opt.normalizedBox.x * 100}%`,
                top: `${opt.normalizedBox.y * 100}%`,
                width: `${opt.normalizedBox.width * 100}%`,
                height: `${opt.normalizedBox.height * 100}%`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onFrameOptionTap?.(opt);
              }}
              aria-label={`Predict on ${opt.label}`}
            >
              <div className="absolute inset-0 rounded-lg border-2 border-white/50 bg-white/5 transition-all group-hover:border-white/80 group-hover:bg-white/15 group-active:bg-white/25 group-active:border-primary" />

              <div className="absolute -right-1 -top-1 h-2.5 w-2.5">
                <div className="absolute inset-0 rounded-full bg-white/80" />
                <div className="absolute inset-0 animate-ping rounded-full bg-white/40" />
              </div>

              <div
                className={cn(
                  "absolute left-1/2 -translate-x-1/2 whitespace-nowrap",
                  "rounded-full bg-black/60 px-2.5 py-0.5 text-[10px] font-semibold text-white/90 leading-tight",
                  "shadow-md backdrop-blur-sm transition-all",
                  "group-hover:bg-black/80 group-active:bg-primary",
                  opt.normalizedBox.y > 0.12 ? "-top-5" : "top-full mt-1",
                )}
              >
                {opt.label}
              </div>
            </button>
          ))}

          {/* Resume play button */}
          <button
            type="button"
            className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-14 w-14 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm touch-manipulation transition hover:bg-black/60"
            onClick={(e) => {
              e.stopPropagation();
              cancelDetection();
              const video = videoRef.current;
              if (video) {
                video.play();
                setIsPlaying(true);
              }
            }}
            aria-label="Resume playback"
          >
            <Play className="ml-0.5 h-7 w-7 text-white/80" />
          </button>

          <div className="pointer-events-none absolute bottom-16 left-3 right-3 flex justify-center">
            <p className="rounded-full bg-black/50 px-3 py-1 text-[10px] font-medium text-white/70 backdrop-blur-sm">
              Tap an object to add prediction
            </p>
          </div>
        </div>
      )}

      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity",
          showControls && !showDetectedOverlay ? "opacity-100" : "opacity-0"
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

function numberDuplicateLabels(candidates: VideoFrameOption[]): VideoFrameOption[] {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    const key = (c.shortLabel || c.label).toLowerCase().trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const indices = new Map<string, number>();
  return candidates.map((c) => {
    const key = (c.shortLabel || c.label).toLowerCase().trim();
    const total = counts.get(key) ?? 1;
    if (total <= 1) return c;

    const idx = (indices.get(key) ?? 0) + 1;
    indices.set(key, idx);

    return {
      ...c,
      label: `${c.label} ${idx}`,
      shortLabel: c.shortLabel ? `${c.shortLabel} ${idx}` : null,
    };
  });
}

function buildSubtitleCues(
  text: string,
  durationSec: number,
): Array<{ start: number; end: number; text: string }> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || durationSec <= 0) return [];

  const words = clean.split(" ");
  const chunkSize = words.length <= 6 ? words.length : words.length <= 18 ? 4 : 6;
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }

  const cues: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const estimated = Math.max(1.2, Math.min(3.2, chunk.length / 13));
    const start = cursor;
    const end = Math.min(durationSec, start + estimated);
    cues.push({ start, end, text: chunk });
    cursor = end;
    if (cursor >= durationSec) break;
  }

  if (cues.length > 0) {
    cues[cues.length - 1].end = durationSec;
  }
  return cues;
}
