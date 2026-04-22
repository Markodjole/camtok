"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { startLiveSession, endLiveSession } from "@/actions/live-sessions";
import type { TransportMode } from "@bettok/live";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { startBroadcasterP2p } from "./liveP2pBroadcast";
import { transportEmoji } from "./transportEmoji";
import { StreamGuidanceOverlay } from "./StreamGuidanceOverlay";
import { TurnBlinkOverlay, type TurnDirection } from "./TurnBlinkOverlay";
import { computeStreamGuidance } from "@/lib/live/streamGuidance";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), { ssr: false });
type MapZone = {
  id: string;
  slug: string;
  name: string;
  kind: "district" | "corridor" | "mission-zone" | "restricted-zone";
  color: string;
  isActive: boolean;
  polygon: Array<{ lat: number; lng: number }>;
};

type MapCheckpoint = {
  id: string;
  name: string;
  kind: "bridge" | "square" | "landmark" | "crossing" | "poi";
  lat: number;
  lng: number;
  isActive: boolean;
};

/** Force rear camera first; fallback to selfie only if rear is unavailable. */
async function openLiveCameraStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { exact: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    }
  }
}

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
  const [aiTurnHint, setAiTurnHint] = useState<string | null>(null);
  const [aiTurnEtaSec, setAiTurnEtaSec] = useState<number | null>(null);
  const [aiTurnDistanceM, setAiTurnDistanceM] = useState<number | null>(null);
  const [realTurnPoint, setRealTurnPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [showZones, setShowZones] = useState(true);
  const [showCheckpoints, setShowCheckpoints] = useState(true);
  const [osmZones, setOsmZones] = useState<MapZone[]>([]);
  const [osmCheckpoints, setOsmCheckpoints] = useState<MapCheckpoint[]>([]);
  const [geoLoadedOnce, setGeoLoadedOnce] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [pipPos, setPipPos] = useState({ top: 96, left: 12 });
  const [pipDragReady, setPipDragReady] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const tickRef = useRef<NodeJS.Timeout | null>(null);
  const pipLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGeoKeyRef = useRef<string | null>(null);
  const pipDragRef = useRef<{ pointerId: number | null; dx: number; dy: number }>({
    pointerId: null,
    dx: 0,
    dy: 0,
  });
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
    let media: MediaStream;
    try {
      media = await openLiveCameraStream();
    } catch {
      setError("Camera/microphone permission denied");
      setStarting(false);
      return;
    }
    setStream(media);

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
      const hb = await fetch(`/api/live/sessions/${sid}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => null);
      if (hb && !hb.ok && heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    }, 2500);
  }

  function startTick(rid: string) {
    tickRef.current = setInterval(async () => {
      await fetch(`/api/live/rooms/${rid}/tick`, { method: "POST" }).catch(() => undefined);
    }, 4000);
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
    return () => {
      if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !stream) return;
    let active = true;
    const startDelay = setTimeout(() => {
      if (!active) return;
      void startBroadcasterP2p(sessionId, stream).then((fn) => {
        if (active) {
          p2pCleanupRef.current = fn;
        } else {
          fn();
        }
      });
    }, 50);
    return () => {
      active = false;
      clearTimeout(startDelay);
      p2pCleanupRef.current?.();
      p2pCleanupRef.current = undefined;
    };
  }, [sessionId, stream]);

  useEffect(() => {
    if (!roomId || !sessionId) return;
    let cancelled = false;
    const EARLY_TURN_LEAD_SEC = 20;
    const toHint = (room: LiveFeedRow | null): { label: string | null; locksAt: string | null } => {
      if (!room?.currentMarket?.options?.length) return { label: null, locksAt: null };
      const opts = room.currentMarket.options;
      const pick = opts
        .map((o) => (o.shortLabel ?? o.label).toLowerCase())
        .map((s) =>
          s.includes("left")
            ? "LEFT"
            : s.includes("right")
              ? "RIGHT"
              : s.includes("straight") || s.includes("forward") || s.includes("continue")
                ? "STRAIGHT"
                : s.includes("back") || s.includes("reverse")
                  ? "BACK"
                  : null,
        )
        .filter((x): x is "LEFT" | "RIGHT" | "STRAIGHT" | "BACK" => x !== null);
      if (!pick.length) return { label: null, locksAt: null };
      const unique = Array.from(new Set(pick));
      return { label: unique.join(" / "), locksAt: room.currentMarket.locksAt };
    };
    const fetchState = async () => {
      try {
        const r = await fetch(`/api/live/rooms/${roomId}/state`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { room: LiveFeedRow | null };
        if (cancelled) return;
        const hint = toHint(j.room);
        setAiTurnHint(hint.label);
        // Pull the server-stored real turn point (computed at market creation from GPS + heading + distance)
        const mkt = j.room?.currentMarket;
        if (mkt?.turnPointLat != null && mkt?.turnPointLng != null) {
          setRealTurnPoint({ lat: mkt.turnPointLat, lng: mkt.turnPointLng });
        } else {
          setRealTurnPoint(null);
        }
        if (!hint.label || !hint.locksAt) {
          setAiTurnEtaSec(null);
          setAiTurnDistanceM(null);
          return;
        }
        // Bias guidance earlier so drivers get enough time before the actual lock/reveal window.
        const etaSec = Math.max(
          0,
          (new Date(hint.locksAt).getTime() - Date.now()) / 1000 + EARLY_TURN_LEAD_SEC,
        );
        setAiTurnEtaSec(etaSec);
        const speed = routePoints[routePoints.length - 1]?.speedMps ?? 0;
        setAiTurnDistanceM(speed > 0 ? speed * etaSec : null);
      } catch {
        // transient
      }
    };
    void fetchState();
    const id = setInterval(fetchState, 1200);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, sessionId, routePoints]);

  useEffect(() => {
    const anchor = routePoints[routePoints.length - 1] ?? null;
    if (!anchor) return;
    const lat = Number(anchor.lat.toFixed(3));
    const lng = Number(anchor.lng.toFixed(3));
    const geoKey = `${lat},${lng}`;
    if (lastGeoKeyRef.current === geoKey) return;
    lastGeoKeyRef.current = geoKey;
    let cancelled = false;

    const fetchGeoContext = async () => {
      try {
        setGeoLoading(true);
        const res = await fetch(`/api/live/geo-context?lat=${lat}&lng=${lng}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setGeoLoadedOnce(true);
          return;
        }
        const json = (await res.json()) as {
          zones?: MapZone[];
          checkpoints?: MapCheckpoint[];
        };
        if (cancelled) return;
        setOsmZones(Array.isArray(json.zones) ? json.zones : []);
        setOsmCheckpoints(Array.isArray(json.checkpoints) ? json.checkpoints : []);
        setGeoLoadedOnce(true);
      } catch {
        if (!cancelled) setGeoLoadedOnce(true);
      } finally {
        if (!cancelled) setGeoLoading(false);
      }
    };

    void fetchGeoContext();
    return () => {
      cancelled = true;
    };
  }, [routePoints]);

  const onPipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pipDragRef.current = {
      pointerId: e.pointerId,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
    };
    if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    pipLongPressTimerRef.current = setTimeout(() => {
      setPipDragReady(true);
    }, 180);
  };

  const onPipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pipDragReady || pipDragRef.current.pointerId !== e.pointerId) return;
    const boxW = Math.min(window.innerWidth * 0.42, 220);
    const boxH = boxW;
    const nextLeft = Math.max(8, Math.min(window.innerWidth - boxW - 8, e.clientX - pipDragRef.current.dx));
    const nextTop = Math.max(56, Math.min(window.innerHeight - boxH - 92, e.clientY - pipDragRef.current.dy));
    setPipPos({ top: nextTop, left: nextLeft });
  };

  const onPipPointerUp = () => {
    if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    pipDragRef.current.pointerId = null;
    setPipDragReady(false);
  };

  if (sessionId && stream) {
    const guidance = routePoints.length > 0 ? computeStreamGuidance(routePoints) : null;
    const hintUpper = (aiTurnHint ?? "").toUpperCase();
    const hintIsLeft = hintUpper.includes("LEFT");
    const hintIsRight = hintUpper.includes("RIGHT");
    const rawTurnDirection: TurnDirection =
      hintIsLeft
        ? "left"
        : hintIsRight
          ? "right"
          : guidance?.kind === "left"
            ? "left"
            : guidance?.kind === "right"
              ? "right"
              : null;
    // Blink the "turn signal" only while approaching the turn. Hide it once
    // the driver has effectively entered the turn (<=12 m or <=1.5 s remaining)
    // or when the turn is still too far out to warrant visual commitment.
    const etaInWindow =
      aiTurnEtaSec == null ? true : aiTurnEtaSec > 1.5 && aiTurnEtaSec <= 22;
    const distInWindow =
      aiTurnDistanceM == null
        ? true
        : aiTurnDistanceM > 12 && aiTurnDistanceM <= 260;
    const blinkArmed = etaInWindow && distInWindow;
    const turnDirection: TurnDirection = blinkArmed ? rawTurnDirection : null;
    const urgent =
      (aiTurnEtaSec != null && aiTurnEtaSec <= 7) ||
      (aiTurnDistanceM != null && aiTurnDistanceM <= 40);
    const blinkLabel = turnDirection === "left"
      ? "Turn left"
      : turnDirection === "right"
        ? "Turn right"
        : guidance?.kind === "brake"
          ? "Slow down"
          : null;
    // Build turnTarget from server-stored real coords + direction from hint
    const turnTarget = realTurnPoint && aiTurnHint
      ? {
          lat: realTurnPoint.lat,
          lng: realTurnPoint.lng,
          kind: (hintIsLeft ? "left" : hintIsRight ? "right" : "straight") as "left" | "right" | "straight",
          label: "",
        }
      : null;

    return (
      <div className="relative h-full min-h-0 w-full flex-1 overflow-hidden bg-black">
        <div className="absolute inset-0 z-0">
          {mapExpanded ? (
            <LiveMap
              routePoints={routePoints}
              className="h-full w-full"
              interactive={true}
              audienceRole="streamer"
              transportMode={transportMode}
              rotateWithHeading={true}
              followMode={true}
              tileOpacity={1}
              mapCaption={"You \u00b7 follow green arrow"}
              zones={geoLoadedOnce ? osmZones : []}
              checkpoints={geoLoadedOnce ? osmCheckpoints : []}
              showZones={showZones}
              showCheckpoints={showCheckpoints}
              turnHint={aiTurnHint}
              turnHintEtaSec={aiTurnEtaSec}
              turnHintDistanceM={aiTurnDistanceM}
              turnTarget={turnTarget}
            />
          ) : (
            <LiveVideoPlayer localStream={stream} className="h-full w-full" />
          )}
        </div>

        {!mapExpanded && routePoints.length > 0 ? (
          <StreamGuidanceOverlay points={routePoints} />
        ) : null}

        <TurnBlinkOverlay
          direction={turnDirection}
          etaSec={aiTurnEtaSec}
          distanceM={aiTurnDistanceM}
          label={blinkLabel}
          urgent={urgent}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-gradient-to-b from-black/75 to-transparent" />

        <div className="absolute right-3 top-20 z-40 flex flex-col items-end gap-2">
          <span className="animate-pulse rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide shadow-md">
            LIVE
          </span>
          <span className="rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white/85 shadow-md backdrop-blur">
            {transportEmoji(transportMode)} {transportMode}
          </span>
          <button
            type="button"
            onClick={() => setShowZones((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] shadow-md ${
              showZones ? "bg-cyan-500/30 text-cyan-100" : "bg-white/10 text-white/60"
            }`}
          >
            Zones
          </button>
          <button
            type="button"
            onClick={() => setShowCheckpoints((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] shadow-md ${
              showCheckpoints ? "bg-fuchsia-500/30 text-fuchsia-100" : "bg-white/10 text-white/60"
            }`}
          >
            Places
          </button>
          {geoLoading && !geoLoadedOnce ? (
            <span className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] text-white/70">
              Loading…
            </span>
          ) : null}
        </div>


        <div
          className="absolute z-30 overflow-hidden rounded-2xl border border-white/25 shadow-2xl backdrop-blur-sm"
          style={{
            top: pipPos.top,
            left: pipPos.left,
            width: "42vw",
            height: "42vw",
            maxWidth: 220,
            maxHeight: 220,
            opacity: 0.9,
          }}
          onPointerDown={onPipPointerDown}
          onPointerMove={onPipPointerMove}
          onPointerUp={onPipPointerUp}
          onPointerCancel={onPipPointerUp}
        >
          {mapExpanded ? (
            <LiveVideoPlayer localStream={stream} className="h-full w-full" />
          ) : (
            <>
              <LiveMap
                routePoints={routePoints}
                className="h-full w-full"
                interactive={false}
                audienceRole="streamer"
                transportMode={transportMode}
                rotateWithHeading={true}
                followMode={true}
                tileOpacity={0.65}
                mapCaption={"You \u00b7 follow green arrow"}
                zones={geoLoadedOnce ? osmZones : []}
                checkpoints={geoLoadedOnce ? osmCheckpoints : []}
                showZones={showZones}
                showCheckpoints={showCheckpoints}
                turnHint={aiTurnHint}
                turnHintEtaSec={aiTurnEtaSec}
                turnHintDistanceM={aiTurnDistanceM}
                turnTarget={turnTarget}
              />
              {routePoints.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[9px] text-white/40">
                  {"Waiting for GPS\u2026"}
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setMapExpanded((v) => !v)}
            className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur active:bg-black/80"
            title={mapExpanded ? "Show camera fullscreen" : "Show map fullscreen"}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path d="M3 7V3h4a1 1 0 110 2H5v2a1 1 0 11-2 0zm10-4h4v4a1 1 0 11-2 0V5h-2a1 1 0 110-2zM3 13a1 1 0 011 1v2h2a1 1 0 110 2H2v-4a1 1 0 011-1zm14 0a1 1 0 011 1v4h-4a1 1 0 110-2h2v-2a1 1 0 011-1z" />
            </svg>
          </button>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-48 bg-gradient-to-t from-black/80 to-transparent" />

        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pb-4">
          {roomId && (
            <p className="mb-3 text-center text-[10px] text-white/30">{`room ${roomId.slice(0, 8)}\u2026`}</p>
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

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto bg-black px-6 py-10">
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
            <option value="car">Car</option>
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

        <p className="text-[11px] text-white/35">
          Uses your rear (world-facing) camera when the device supports it.
        </p>

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
