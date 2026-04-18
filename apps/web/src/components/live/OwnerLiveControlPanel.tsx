"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { startLiveSession, endLiveSession } from "@/actions/live-sessions";
import type { TransportMode } from "@bettok/live";
import type { RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { startBroadcasterP2p } from "./liveP2pBroadcast";
import { transportEmoji } from "./transportEmoji";
import { StreamGuidanceOverlay } from "./StreamGuidanceOverlay";
import { LiveEventToasts } from "./LiveEventToasts";
import { TopBar } from "@/components/layout/top-bar";
import { BottomNav } from "@/components/layout/bottom-nav";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), { ssr: false });

export function OwnerLiveControlPanel({ characterId }: { characterId: string }) {
  const [transportMode, setTransportMode] = useState<TransportMode>("walking");
  const [statusText, setStatusText] = useState("");
  const [intentLabel, setIntentLabel] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);

  const watchIdRef = useRef<number | null>(null);
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const tickRef = useRef<NodeJS.Timeout | null>(null);
  const pendingLocationsRef = useRef<
    Array<{
      recordedAt: string;
      lat: number;
      lng: number;
      speedMps?: number;
      headingDeg?: number;
      accuracyMeters?: number;
    }>
  >([]);
  const router = useRouter();
  const p2pCleanupRef = useRef<(() => void) | undefined>(undefined);

  async function goLive() {
    setStarting(true);
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: true,
      });
      setStream(media);
    } catch {
      setError("Camera/microphone permission denied");
      setStarting(false);
      return;
    }

    const res = await startLiveSession({
      characterId,
      transportMode,
      statusText: statusText.trim() || undefined,
      intentLabel: intentLabel.trim() || undefined,
    });
    if ("error" in res) {
      setError(res.error ?? "Failed to start session");
      setStarting(false);
      return;
    }

    setSessionId(res.sessionId);
    setRoomId(res.roomId);
    setStarting(false);
    startTelemetry(res.sessionId);
    startTick(res.roomId);
  }

  function startTelemetry(sid: string) {
    if ("geolocation" in navigator) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const point: RoutePoint = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            heading: pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : undefined,
            speedMps: pos.coords.speed != null && !Number.isNaN(pos.coords.speed) ? pos.coords.speed : undefined,
          };
          setRoutePoints((prev) => [...prev.slice(-199), point]);
          pendingLocationsRef.current.push({
            recordedAt: new Date(pos.timestamp).toISOString(),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speedMps: pos.coords.speed ?? undefined,
            headingDeg: pos.coords.heading ?? undefined,
            accuracyMeters: pos.coords.accuracy ?? undefined,
          });
        },
        (e) => setError(`location error: ${e.message}`),
        { enableHighAccuracy: true, maximumAge: 1000 },
      );
    }

    heartbeatRef.current = setInterval(async () => {
      const batch = pendingLocationsRef.current.splice(0, 10);
      if (batch.length > 0) {
        await fetch(`/api/live/sessions/${sid}/location`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transportMode, points: batch }),
        }).catch(() => undefined);
      }
      await fetch(`/api/live/sessions/${sid}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => undefined);
    }, 2500);
  }

  function startTick(rid: string) {
    tickRef.current = setInterval(async () => {
      await fetch(`/api/live/rooms/${rid}/tick`, { method: "POST" }).catch(() => undefined);
    }, 3000);
  }

  async function stopLive() {
    if (sessionId) await endLiveSession(sessionId);
    cleanup();
    router.refresh();
  }

  function cleanup() {
    p2pCleanupRef.current?.();
    p2pCleanupRef.current = undefined;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); setStream(null); }
    setSessionId(null);
    setRoomId(null);
  }

  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId || !stream) return;
    let active = true;
    void startBroadcasterP2p(sessionId, stream).then((fn) => {
      if (active) { p2pCleanupRef.current = fn; } else { fn(); }
    });
    return () => {
      active = false;
      p2pCleanupRef.current?.();
      p2pCleanupRef.current = undefined;
    };
  }, [sessionId, stream]);

  /* ── LIVE screen ─────────────────────────────────────── */
  if (sessionId && stream) {
    return (
      <div className="relative h-[100dvh] w-full overflow-hidden bg-black">
        <TopBar />
        <BottomNav />
        {roomId ? <LiveEventToasts roomId={roomId} role="streamer" /> : null}
        {/* Video — fill background */}
        <div className="absolute inset-0 z-0">
          <LiveVideoPlayer localStream={stream} className="h-full w-full" />
        </div>
        {routePoints.length > 0 ? <StreamGuidanceOverlay points={routePoints} /> : null}

        {/* Top gradient scrim */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-36 bg-gradient-to-b from-black/75 to-transparent" />

        {/* Top bar — sits below app TopBar */}
        <div className="absolute inset-x-0 top-12 z-20 flex items-center gap-2 px-4 py-3 text-sm">
          <span className="animate-pulse rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide">
            LIVE
          </span>
          <span className="text-white/70 text-xs drop-shadow">
            {transportEmoji(transportMode)} {transportMode}
          </span>
          {statusText && (
            <span className="ml-1 text-[11px] text-white/40 truncate max-w-[40%]">{statusText}</span>
          )}
          {routePoints.length > 0 && (
            <span className="ml-auto text-[10px] text-white/30">{routePoints.length} pts</span>
          )}
        </div>

        {/* Map overlay — upper-right, below both bars */}
        <div
          className="absolute z-10 overflow-hidden rounded-2xl border border-white/20 shadow-2xl backdrop-blur-sm"
          style={{ top: 108, right: 12, width: "42vw", height: "42vw", maxWidth: 200, maxHeight: 200, opacity: 0.5 }}
        >
          <LiveMap
            routePoints={routePoints}
            className="h-full w-full"
            interactive={false}
            audienceRole="streamer"
            tileOpacity={0.3}
            mapCaption="You · follow green arrow"
          />
          {routePoints.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[9px] text-white/40">
              Waiting for GPS…
            </div>
          )}
        </div>

        {/* Bottom gradient scrim */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-48 bg-gradient-to-t from-black/80 to-transparent" />

        {/* Bottom controls overlay — above BottomNav */}
        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pb-20">
          {roomId && (
            <p className="mb-3 text-center text-[10px] text-white/30">room {roomId.slice(0, 8)}…</p>
          )}
          <button
            type="button"
            onClick={() => void stopLive()}
            className="w-full rounded-2xl border border-red-500/40 bg-red-500/20 px-4 py-3 text-sm font-semibold text-red-300 backdrop-blur-sm active:bg-red-500/35"
          >
            End live session
          </button>
        </div>
      </div>
    );
  }

  /* ── Pre-live setup form ──────────────────────────────── */
  return (
    <div className="flex h-[100dvh] flex-col justify-center bg-black px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold text-white">Go live</h1>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-white/40">Transport mode</label>
          <select
            value={transportMode}
            onChange={(e) => setTransportMode(e.target.value as TransportMode)}
            className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white"
          >
            <option value="walking">Walking</option>
            <option value="bike">Bike</option>
            <option value="scooter">Scooter</option>
            <option value="car" disabled>Car (coming later)</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-white/40">Status</label>
          <input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            placeholder="e.g. going out to get drinks"
            className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/20"
          />
        </div>

        <div>
          <label className="text-xs text-white/40">Intent (optional)</label>
          <input
            value={intentLabel}
            onChange={(e) => setIntentLabel(e.target.value)}
            placeholder="e.g. looking for food"
            className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/20"
          />
        </div>

        {error && <div className="text-xs text-red-400">{error}</div>}

        <button
          type="button"
          disabled={starting}
          onClick={() => void goLive()}
          className="w-full rounded-2xl bg-red-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {starting ? "Starting…" : "Go live"}
        </button>
      </div>
    </div>
  );
}
