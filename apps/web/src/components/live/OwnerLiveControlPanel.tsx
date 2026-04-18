"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { startLiveSession, endLiveSession } from "@/actions/live-sessions";
import type { TransportMode } from "@bettok/live";
import type { RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { startBroadcasterP2p } from "./liveP2pBroadcast";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), { ssr: false });

export function OwnerLiveControlPanel({
  characterId,
}: {
  characterId: string;
}) {
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
      statusText: statusText.trim() ? statusText.trim() : undefined,
      intentLabel: intentLabel.trim() ? intentLabel.trim() : undefined,
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
            heading: pos.coords.heading ?? undefined,
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
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
    setSessionId(null);
    setRoomId(null);
  }

  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId || !stream) return;
    let active = true;
    void startBroadcasterP2p(sessionId, stream).then((fn) => {
      if (active) {
        p2pCleanupRef.current = fn;
      } else {
        fn();
      }
    });
    return () => {
      active = false;
      p2pCleanupRef.current?.();
      p2pCleanupRef.current = undefined;
    };
  }, [sessionId, stream]);

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-semibold">Go live</h1>

      {sessionId ? (
        <div className="space-y-3">
          <LiveVideoPlayer localStream={stream} />

          {/* Map showing broadcaster's own route */}
          <div className="overflow-hidden rounded-xl border border-white/10">
            <div className="bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/40">
              Your route
            </div>
            <LiveMap
              routePoints={routePoints}
              className="h-40 w-full"
              interactive
            />
            {routePoints.length === 0 && (
              <div className="flex h-10 items-center justify-center text-[11px] text-white/30">
                Waiting for GPS signal…
              </div>
            )}
          </div>

          <div className="rounded-md border border-border p-3 text-sm">
            <div className="font-medium">You are live.</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Room ID: {roomId}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void stopLive()}
            className="w-full rounded-md bg-red-500 px-3 py-2 text-sm font-semibold text-white"
          >
            End live session
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void goLive();
          }}
          className="space-y-3"
        >
          <div>
            <label className="text-xs text-muted-foreground">Transport mode</label>
            <select
              value={transportMode}
              onChange={(e) => setTransportMode(e.target.value as TransportMode)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="walking">Walking</option>
              <option value="bike">Bike</option>
              <option value="scooter">Scooter</option>
              <option value="car" disabled>
                Car (coming later)
              </option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Status</label>
            <input
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              placeholder="e.g. going out to get drinks"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Intent (optional)</label>
            <input
              value={intentLabel}
              onChange={(e) => setIntentLabel(e.target.value)}
              placeholder="e.g. looking for food"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          {error ? <div className="text-xs text-red-400">{error}</div> : null}
          <button
            type="submit"
            disabled={starting}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {starting ? "Starting…" : "Go live"}
          </button>
        </form>
      )}
    </div>
  );
}
