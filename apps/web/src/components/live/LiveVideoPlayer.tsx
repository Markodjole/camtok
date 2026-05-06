"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, RefreshCw } from "lucide-react";
import { startViewerP2p } from "./liveP2pBroadcast";

const CONNECT_TIMEOUT_MS = 20_000;
const IS_DEV = process.env.NODE_ENV === "development";

/**
 * Broadcaster: pass `localStream` from getUserMedia.
 * Viewer: pass `liveSessionId` (no localStream) — connects via WebRTC + Supabase Realtime signaling.
 */
export function LiveVideoPlayer({
  localStream,
  liveSessionId,
  className,
}: {
  localStream?: MediaStream | null;
  liveSessionId?: string | null;
  className?: string;
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
    if (!el) return;
    if (localStream) {
      el.srcObject = localStream;
      el.muted = true;
      void el.play().catch(() => undefined);
      return;
    }
    el.srcObject = null;
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

    // Show "timed out" if we haven't got a stream after CONNECT_TIMEOUT_MS.
    const timeoutHandle = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, CONNECT_TIMEOUT_MS);

    // Defer the actual subscription by a tick to avoid Strict Mode zombie channels.
    const startDelay = setTimeout(() => {
      if (cancelled) return;
      startViewerP2p(
        liveSessionId,
        (stream) => {
          if (!cancelled) {
            clearTimeout(timeoutHandle);
            setRemoteStream(stream);
            setSignalError(null);
            setTimedOut(false);
          }
        },
        (msg) => { if (!cancelled) setSignalError(msg); },
        IS_DEV ? (line) => console.log("[WebRTC viewer]", line) : undefined,
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
    el.srcObject = remoteStream;
    // Safari autoplay: start muted so video can render; user can enable sound.
    el.muted = !soundOn;
    void el.play().catch(() => undefined);
  }, [remoteStream, localStream, soundOn]);

  const viewerConnecting = !localStream && liveSessionId && !remoteStream && !signalError && !timedOut;
  const showError = (signalError || timedOut) && !remoteStream;

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? "aspect-[9/16] w-full"}`}>
      <video ref={ref} playsInline autoPlay className="h-full w-full object-cover" />
      {viewerConnecting ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-muted-foreground">
          Connecting to live stream…
        </div>
      ) : null}
      {showError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center">
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
      {!localStream && liveSessionId && remoteStream ? (
        <button
          type="button"
          onClick={() => setSoundOn((prev) => !prev)}
          className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/90 shadow-md backdrop-blur-sm active:bg-black/70"
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
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          No stream
        </div>
      ) : null}
    </div>
  );
}
