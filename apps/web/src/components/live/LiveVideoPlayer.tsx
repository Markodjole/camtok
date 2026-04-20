"use client";

import { useEffect, useRef, useState } from "react";
import { startViewerP2p } from "./liveP2pBroadcast";

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
  const [soundOn, setSoundOn] = useState(false);
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const pushDebug = (line: string) =>
    setDebugLines((prev) => [...prev.slice(-7), `${new Date().toLocaleTimeString()} ${line}`]);

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
      setSoundOn(false);
      return;
    }

    let cancelled = false;
    const cleanupRef = { fn: undefined as (() => void) | undefined };

    // Defer the actual subscription by a tick. If React torn down the effect
    // within this tick (Strict Mode double-mount or rapid re-render), we never
    // create the Supabase channel at all — avoiding zombie-subscription issues
    // where the server-side topic membership breaks after the first unsubscribe.
    const startDelay = setTimeout(() => {
      if (cancelled) return;
      startViewerP2p(
        liveSessionId,
        (stream) => { if (!cancelled) { setRemoteStream(stream); setSignalError(null); } },
        (msg) => { if (!cancelled) setSignalError(msg); },
        (line) => { if (!cancelled) pushDebug(line); },
      ).then((cleanup) => {
        if (cancelled) {
          cleanup();
        } else {
          cleanupRef.fn = cleanup;
        }
      }).catch((e) => {
        if (!cancelled) setSignalError(e instanceof Error ? e.message : "Could not connect");
      });
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(startDelay);
      cleanupRef.fn?.();
      cleanupRef.fn = undefined;
      setRemoteStream(null);
    };
  }, [liveSessionId, localStream]);

  useEffect(() => {
    const el = ref.current;
    if (!el || localStream) return;
    el.srcObject = remoteStream;
    // Safari autoplay: start muted so video can render; user can enable sound.
    el.muted = !soundOn;
    void el.play().catch(() => undefined);
  }, [remoteStream, localStream, soundOn]);

  const viewerConnecting = !localStream && liveSessionId && !remoteStream && !signalError;

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? "aspect-[9/16] w-full"}`}>
      <video ref={ref} playsInline autoPlay className="h-full w-full object-cover" />
      {viewerConnecting ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-muted-foreground">
          Connecting to live stream…
        </div>
      ) : null}
      {!localStream && liveSessionId && remoteStream && !soundOn ? (
        <button
          type="button"
          onClick={() => setSoundOn(true)}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1.5 text-[11px] text-white backdrop-blur"
        >
          Tap for sound
        </button>
      ) : null}
      {signalError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-red-300">
          {signalError}
        </div>
      ) : null}
      {!localStream && !liveSessionId ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          No stream
        </div>
      ) : null}
      {!localStream && liveSessionId ? (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 max-h-24 overflow-hidden bg-black/50 p-1 text-[10px] leading-snug text-white/70">
          {debugLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
