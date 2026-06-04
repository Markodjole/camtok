"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, RefreshCw } from "lucide-react";
import { startViewerP2p } from "./liveP2pBroadcast";

const CONNECT_TIMEOUT_MS = 20_000;
const IS_DEV = process.env.NODE_ENV === "development";

function webrtcDebugEnabled(): boolean {
  if (IS_DEV) return true;
  try {
    return localStorage.getItem("camtok_webrtc_debug") === "1";
  } catch {
    return false;
  }
}

function hasLiveVideoTrack(stream: MediaStream | null): boolean {
  return (
    stream?.getVideoTracks().some((t) => t.readyState !== "ended") ?? false
  );
}

async function attachAndPlay(
  el: HTMLVideoElement,
  stream: MediaStream | null,
  muted: boolean,
): Promise<void> {
  if (stream && el.srcObject !== stream) {
    el.srcObject = stream;
  }
  if (!stream) {
    el.srcObject = null;
    return;
  }
  el.muted = muted;
  try {
    await el.play();
  } catch {
    /* autoplay policy — retry on loadedmetadata */
  }
}

/**
 * Broadcaster: pass `localStream` from getUserMedia.
 * Viewer: pass `liveSessionId` (no localStream) — connects via WebRTC + Supabase Realtime signaling.
 */
export function LiveVideoPlayer({
  localStream,
  liveSessionId,
  className,
  objectFit = "cover",
  objectPosition = "center",
}: {
  localStream?: MediaStream | null;
  liveSessionId?: string | null;
  className?: string;
  objectFit?: "cover" | "contain";
  /** e.g. "top" — anchor cover crop from the bottom (mobile dashcam strip). */
  objectPosition?: "center" | "top";
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const retry = useCallback(() => {
    setRemoteStream(null);
    setSignalError(null);
    setTimedOut(false);
    setRetryKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !localStream) return;
    void attachAndPlay(el, localStream, true);
  }, [localStream]);

  useEffect(() => {
    if (localStream || !liveSessionId) {
      setRemoteStream(null);
      setSignalError(null);
      setTimedOut(false);
      setSoundOn(false);
      return;
    }

    let cancelled = false;
    const cleanupRef = { fn: undefined as (() => void) | undefined };

    const timeoutHandle = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, CONNECT_TIMEOUT_MS);

    const startDelay = setTimeout(() => {
      if (cancelled) return;
      startViewerP2p(
        liveSessionId,
        (stream) => {
          if (!cancelled) {
            setRemoteStream(stream);
            setSignalError(null);
            if (hasLiveVideoTrack(stream)) {
              clearTimeout(timeoutHandle);
              setTimedOut(false);
            }
          }
        },
        (msg) => { if (!cancelled) setSignalError(msg); },
        webrtcDebugEnabled()
          ? (line) => console.log("[WebRTC viewer]", line)
          : undefined,
      ).then((cleanup) => {
        if (cancelled) cleanup();
        else cleanupRef.fn = cleanup;
      }).catch((e) => {
        clearTimeout(timeoutHandle);
        if (!cancelled) setSignalError(e instanceof Error ? e.message : "Could not connect");
      });
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(startDelay);
      clearTimeout(timeoutHandle);
      cleanupRef.fn?.();
      cleanupRef.fn = undefined;
      setRemoteStream(null);
    };
  // retryKey forces a full reconnect when the user taps retry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, localStream, retryKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || localStream) return;

    const sync = () => void attachAndPlay(el, remoteStream, !soundOn);
    void sync();

    if (!remoteStream) return;

    el.addEventListener("loadedmetadata", sync);
    remoteStream.addEventListener("addtrack", sync);
    for (const track of remoteStream.getVideoTracks()) {
      track.addEventListener("unmute", sync);
    }
    return () => {
      el.removeEventListener("loadedmetadata", sync);
      remoteStream.removeEventListener("addtrack", sync);
      for (const track of remoteStream.getVideoTracks()) {
        track.removeEventListener("unmute", sync);
      }
    };
  }, [remoteStream, localStream, soundOn]);

  const hasVideo = localStream
    ? hasLiveVideoTrack(localStream)
    : hasLiveVideoTrack(remoteStream);
  const viewerConnecting =
    !localStream && !!liveSessionId && !hasVideo && !signalError && !timedOut;
  const showError = (signalError || timedOut) && !hasVideo;

  const videoClass =
    objectFit === "contain"
      ? "relative z-0 max-h-full max-w-full object-contain"
      : `relative z-0 h-full w-full object-cover${objectPosition === "top" ? " object-top" : ""}`;

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden bg-black ${className ?? "aspect-[9/16] w-full"}`}
    >
      <video
        ref={ref}
        playsInline
        autoPlay
        muted
        className={videoClass}
      />
      {viewerConnecting ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 text-xs text-muted-foreground">
          Connecting to live stream…
        </div>
      ) : null}
      {showError ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center">
          <p className="text-xs text-red-300">
            {timedOut && !signalError ? "Could not connect to stream." : signalError}
          </p>
          <button
            type="button"
            onClick={retry}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/80 active:bg-white/20"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      ) : null}
      {!localStream && liveSessionId && hasVideo ? (
        <button
          type="button"
          onClick={() => setSoundOn((prev) => !prev)}
          className="absolute bottom-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/90 shadow-md backdrop-blur-sm active:bg-black/70"
          title={soundOn ? "Mute" : "Sound on"}
          aria-label={soundOn ? "Mute stream" : "Unmute stream"}
        >
          {soundOn ? (
            <Volume2 className="h-4 w-4" />
          ) : (
            <VolumeX className="h-4 w-4" />
          )}
        </button>
      ) : null}
      {!localStream && !liveSessionId ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted-foreground">
          No stream
        </div>
      ) : null}
    </div>
  );
}
