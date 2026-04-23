"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { DirectionalBetPad } from "./DirectionalBetPad";
import { LiveDecisionStatusRibbon } from "./LiveDecisionStatusRibbon";
import { useCountdown } from "./useCountdown";
import { TransportModeIcon } from "./TransportModeIcon";
import { BetPlacedPill, LiveEventToasts, useBetPill } from "./LiveEventToasts";
import { SkillFeedbackCard, type SkillFeedbackData } from "./SkillFeedbackCard";
import { ReplaySheet } from "./ReplaySheet";
import { TopBar } from "@/components/layout/top-bar";
import { BottomNav } from "@/components/layout/bottom-nav";
import {
  IconRailButton,
  IconLayers,
  IconSparkle,
  IconCoin,
  IconCrosshair,
} from "./OwnerLiveControlPanel";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), {
  ssr: false,
});

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

const CITY_ZONE_PRESETS: Array<{
  id: string;
  slug: string;
  name: string;
  kind: MapZone["kind"];
  color: string;
  points: Array<{ x: number; y: number }>;
}> = [
  {
    id: "zone-city-center",
    slug: "city-center",
    name: "City Center",
    kind: "district",
    color: "#60a5fa",
    points: [
      { x: -1.1, y: 0.7 },
      { x: -0.15, y: 1.2 },
      { x: 0.75, y: 0.35 },
      { x: -0.25, y: -0.35 },
    ],
  },
  {
    id: "zone-old-quarter",
    slug: "old-quarter",
    name: "Old Quarter",
    kind: "district",
    color: "#a78bfa",
    points: [
      { x: -1.6, y: 0.25 },
      { x: -1.1, y: 0.95 },
      { x: -0.55, y: 0.1 },
      { x: -1.05, y: -0.45 },
    ],
  },
  {
    id: "zone-riverside",
    slug: "riverside",
    name: "Riverside",
    kind: "corridor",
    color: "#22c55e",
    points: [
      { x: 0.05, y: -1.4 },
      { x: 0.9, y: -1.1 },
      { x: 1.15, y: -0.25 },
      { x: 0.2, y: -0.45 },
    ],
  },
];

const TOURIST_CHECKPOINT_PRESETS: Array<{
  id: string;
  name: string;
  kind: MapCheckpoint["kind"];
  offset: { x: number; y: number };
}> = [
  { id: "cp-main-square", name: "Main Square", kind: "square", offset: { x: -0.65, y: -0.6 } },
  { id: "cp-city-bridge", name: "City Bridge", kind: "bridge", offset: { x: 0.95, y: 0.2 } },
  { id: "cp-cathedral", name: "Cathedral", kind: "landmark", offset: { x: -0.95, y: 0.75 } },
  { id: "cp-museum", name: "Museum", kind: "poi", offset: { x: 0.35, y: 1.05 } },
  { id: "cp-viewpoint", name: "Viewpoint", kind: "landmark", offset: { x: 1.25, y: -0.45 } },
];

function buildMapObjects(anchor: RoutePoint | null): {
  zones: MapZone[];
  checkpoints: MapCheckpoint[];
} {
  const lat = anchor?.lat ?? 44.8125;
  const lng = anchor?.lng ?? 20.4612;
  const dLat = 0.0032;
  const dLng = 0.0045;
  return {
    zones: CITY_ZONE_PRESETS.map((zone) => ({
      id: zone.id,
      slug: zone.slug,
      name: zone.name,
      kind: zone.kind,
      color: zone.color,
      isActive: true,
      polygon: zone.points.map((point) => ({
        lat: lat + dLat * point.y,
        lng: lng + dLng * point.x,
      })),
    })),
    checkpoints: TOURIST_CHECKPOINT_PRESETS.map((checkpoint) => ({
      id: checkpoint.id,
      name: checkpoint.name,
      kind: checkpoint.kind,
      lat: lat + dLat * checkpoint.offset.y,
      lng: lng + dLng * checkpoint.offset.x,
      isActive: true,
    })),
  };
}

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(
    initialRoom.routePoints ?? [],
  );
  const [betAmount, setBetAmount] = useState(10);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapSheetError, setMapSheetError] = useState<string | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [skillFeedback, setSkillFeedback] = useState<SkillFeedbackData | null>(null);
  /** When true: map is full-screen, camera feed is in the corner pip */
  const [mapExpanded, setMapExpanded] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedMapOptionId, setSelectedMapOptionId] = useState<string | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [showCheckpoints, setShowCheckpoints] = useState(true);
  const [mapFollow, setMapFollow] = useState(true);
  const [osmZones, setOsmZones] = useState<MapZone[]>([]);
  const [osmCheckpoints, setOsmCheckpoints] = useState<MapCheckpoint[]>([]);
  const [geoLoadedOnce, setGeoLoadedOnce] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [pipPos, setPipPos] = useState({ top: 48, left: 12 });
  const [pipDragReady, setPipDragReady] = useState(false);
  const [driverRoute, setDriverRoute] = useState<Array<{ lat: number; lng: number }> | null>(null);
  const [driverCheckpoint, setDriverCheckpoint] = useState<{ lat: number; lng: number } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [lastBetMarketId, setLastBetMarketId] = useState<string | null>(null);
  const [lastBetOptionLabel, setLastBetOptionLabel] = useState<string | null>(null);
  const lastGeoKeyRef = useRef<string | null>(null);
  const pipLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pipDragRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    baseTop: number;
    baseLeft: number;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    baseTop: 0,
    baseLeft: 0,
  });
  const showLiveBets = true;
  const skillFeedbackTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const { betPill, flash } = useBetPill();

  const handleSettlement = useCallback((data: SkillFeedbackData) => {
    setSkillFeedback(data);
    if (skillFeedbackTimerRef.current) clearTimeout(skillFeedbackTimerRef.current);
    skillFeedbackTimerRef.current = setTimeout(() => setSkillFeedback(null), 7000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        // Room state only — tick is driven by the streamer panel so we do not
        // POST /tick from every viewer (dev terminal spam + redundant load).
        const stateRes = await fetch(`/api/live/rooms/${initialRoom.roomId}/state`, {
          cache: "no-store",
        });
        if (stateRes.ok) {
          const json = (await stateRes.json()) as { room: LiveFeedRow | null };
          if (json.room) setRoom(json.room);
        }
      } catch {
        /* transient */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [initialRoom.roomId]);

  useEffect(() => {
    const fetchPoints = async () => {
      try {
        const res = await fetch(
          `/api/live/sessions/${room.liveSessionId}/route-points`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const json = (await res.json()) as { points: RoutePoint[] };
          setRoutePoints(json.points);
        }
      } catch {
        /* transient */
      }
    };
    fetchPoints();
    const id = setInterval(fetchPoints, 1200);
    return () => clearInterval(id);
  }, [room.liveSessionId]);

  async function placeBet(optionId: string) {
    if (!room.currentMarket) return;
    setError(null);
    setMapSheetError(null);
    setPlacingOptionId(optionId);
    try {
      const res = await fetch(`/api/live/rooms/${room.roomId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: room.currentMarket.id,
          optionId,
          stakeAmount: betAmount,
        }),
      });
      if (res.ok) {
        flash(betAmount);
        const pickedLabel =
          room.currentMarket.options.find((o) => o.id === optionId)?.shortLabel ??
          room.currentMarket.options.find((o) => o.id === optionId)?.label ??
          null;
        setLastBetMarketId(room.currentMarket.id);
        setLastBetOptionLabel(pickedLabel);
        return { ok: true as const };
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const message = j.error ?? "Bet failed";
        setError(message);
        setMapSheetError(message);
        return { ok: false as const, error: message };
      }
      return { ok: false as const, error: "Bet failed" };
    } finally {
      setPlacingOptionId(null);
    }
  }

  const currentMarket = room.currentMarket;
  const viewerTurnTarget = currentMarket?.turnPointLat != null && currentMarket?.turnPointLng != null
    ? { lat: currentMarket.turnPointLat, lng: currentMarket.turnPointLng, kind: "straight" as const, label: "" }
    : null;
  const isLocked = currentMarket
    ? new Date(currentMarket.locksAt) <= new Date()
    : true;
  const viewerRailPhase: "none" | "pending" | "active" = (() => {
    // Viewer should always see the next decision marker (blue dot) when we
    // have either a market turn-point or a checkpoint from driver-route.
    if (!viewerTurnTarget && !driverCheckpoint) return "none";
    if (!currentMarket || !viewerTurnTarget) return "pending";
    const locksAtMs = Date.parse(currentMarket.locksAt);
    if (currentMarket.revealAt) {
      const revealMs = Date.parse(currentMarket.revealAt);
      if (Number.isFinite(revealMs) && nowTick > revealMs + 1500) return "none";
    }
    return Number.isFinite(locksAtMs) && nowTick >= locksAtMs ? "active" : "pending";
  })();
  const viewerDriverPos =
    routePoints.length > 0
      ? { lat: routePoints[routePoints.length - 1]!.lat, lng: routePoints[routePoints.length - 1]!.lng }
      : null;
  // Keep the "your pick" tag only while the market you bet on is still live.
  useEffect(() => {
    if (!currentMarket || currentMarket.id !== lastBetMarketId) {
      if (lastBetMarketId && currentMarket?.id !== lastBetMarketId) {
        setLastBetMarketId(null);
        setLastBetOptionLabel(null);
      }
    }
  }, [currentMarket?.id, lastBetMarketId]);
  const fallbackMapObjects = useMemo(
    () => buildMapObjects(routePoints[routePoints.length - 1] ?? initialRoom.routePoints?.[0] ?? null),
    [routePoints, initialRoom.routePoints],
  );
  const zones = geoLoadedOnce ? osmZones : fallbackMapObjects.zones;
  const checkpoints = geoLoadedOnce ? osmCheckpoints : fallbackMapObjects.checkpoints;
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const selectedCheckpoint = checkpoints.find((c) => c.id === selectedCheckpointId) ?? null;
  const selectedTargetLabel = selectedZone?.name ?? selectedCheckpoint?.name ?? null;

  useEffect(() => {
    // Keep map-sheet bet option in sync with the currently active market
    const first = currentMarket?.options?.[0]?.id ?? null;
    setSelectedMapOptionId(first);
  }, [currentMarket?.id, selectedZoneId, selectedCheckpointId]);

  useEffect(() => {
    const anchor = routePoints[routePoints.length - 1] ?? initialRoom.routePoints?.[0] ?? null;
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
        const nextZones = Array.isArray(json.zones) ? json.zones : [];
        const nextCheckpoints = Array.isArray(json.checkpoints) ? json.checkpoints : [];
        setOsmZones(nextZones);
        setOsmCheckpoints(nextCheckpoints);
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
  }, [routePoints, initialRoom.routePoints]);

  useEffect(() => {
    return () => {
      if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchRoute = async () => {
      try {
        const r = await fetch(`/api/live/rooms/${room.roomId}/driver-route`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          instruction: {
            routePolyline: Array<{ lat: number; lng: number }>;
            checkpoint: { lat: number; lng: number };
          } | null;
        };
        if (cancelled) return;
        if (j.instruction && j.instruction.routePolyline.length >= 2) {
          setDriverRoute(j.instruction.routePolyline);
          setDriverCheckpoint(j.instruction.checkpoint);
        } else {
          setDriverRoute(null);
          setDriverCheckpoint(null);
        }
      } catch {
        /* transient */
      }
    };
    void fetchRoute();
    const id = setInterval(fetchRoute, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [room.roomId]);

  const onPipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-pip-no-drag]")) return;
    pipDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseTop: pipPos.top,
      baseLeft: pipPos.left,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    pipLongPressTimerRef.current = setTimeout(() => {
      setPipDragReady(true);
    }, 140);
  };

  const onPipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pipDragRef.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - pipDragRef.current.startX;
    const dy = e.clientY - pipDragRef.current.startY;
    if (!pipDragReady) {
      if (Math.hypot(dx, dy) > 10) setPipDragReady(true);
      else return;
    }
    e.preventDefault();
    const boxW = Math.min(window.innerWidth * 0.56, 260);
    const boxH = boxW;
    const nextLeft = Math.max(
      8,
      Math.min(window.innerWidth - boxW - 8, pipDragRef.current.baseLeft + dx),
    );
    const nextTop = Math.max(
      48,
      Math.min(window.innerHeight - boxH - 92, pipDragRef.current.baseTop + dy),
    );
    setPipPos({ top: nextTop, left: nextLeft });
  };

  const onPipPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    pipDragRef.current.pointerId = null;
    setPipDragReady(false);
  };

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <TopBar />
      <LiveDecisionStatusRibbon
        phase={viewerRailPhase}
        locksAt={currentMarket?.locksAt ?? null}
        revealAt={currentMarket?.revealAt ?? null}
        turnPoint={viewerTurnTarget ?? driverCheckpoint}
        driverPos={viewerDriverPos}
        betOptionLabel={
          currentMarket && lastBetMarketId === currentMarket.id
            ? lastBetOptionLabel
            : null
        }
        nowTick={nowTick}
      />
      <BottomNav />
      <LiveEventToasts
        roomId={room.roomId}
        role="viewer"
        onSettlement={handleSettlement}
      />
      <BetPlacedPill text={betPill} />

      {/* Skill feedback card — shown after each settled bet */}
      {skillFeedback && (
        <SkillFeedbackCard
          data={skillFeedback}
          onDismiss={() => setSkillFeedback(null)}
        />
      )}

      {/* Replay sheet — shown when user taps history button */}
      {showReplay && (
        <ReplaySheet
          roomId={room.roomId}
          onClose={() => setShowReplay(false)}
        />
      )}

      {/* ── Full-screen layer: video (default) or map (when mapExpanded) ── */}
      <div className="absolute inset-0 z-0">
        {mapExpanded ? (
          <LiveMap
            routePoints={routePoints}
            className="h-full w-full"
            interactive={true}
            audienceRole="viewer"
            transportMode={room.transportMode}
            rotateWithHeading={true}
            followMode={mapFollow}
            onUserInteract={() => setMapFollow(false)}
            tileOpacity={1}
            mapCaption={currentMarket?.title}
            zones={zones}
            checkpoints={checkpoints}
            selectedZoneId={selectedZoneId}
            selectedCheckpointId={selectedCheckpointId}
            showZones={showZones}
            showCheckpoints={showCheckpoints}
            turnTarget={viewerTurnTarget}
            driverRoute={driverRoute}
            driverCheckpoint={driverCheckpoint}
            railPhase={viewerRailPhase}
            onZoneSelect={(id) => {
              setSelectedZoneId(id);
              if (id) setSelectedCheckpointId(null);
            }}
            onCheckpointSelect={(id) => {
              setSelectedCheckpointId(id);
              if (id) setSelectedZoneId(null);
            }}
          />
        ) : (
          <LiveVideoPlayer
            liveSessionId={room.liveSessionId}
            className="h-full w-full"
          />
        )}
      </div>

      {/* ── Top gradient scrim ───────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-36 bg-gradient-to-b from-black/75 to-transparent" />

      {/* ── Top bar — LIVE · name · mode · $amount stepper ── */}
      <div className="absolute inset-x-0 top-12 z-40 flex items-center gap-2 px-4 py-3 text-sm">
        <span className="rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide">
          LIVE
        </span>
        <span className="font-semibold text-white drop-shadow">
          {room.characterName}
        </span>
        <span className="flex items-center gap-1.5 text-white/55 drop-shadow text-xs">
          <TransportModeIcon mode={room.transportMode} className="h-4 w-4" />
          {room.transportMode.replace("_", " ")}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {/* History / replay button */}
          <button
            type="button"
            onClick={() => setShowReplay(true)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/12 text-xs text-white/60 backdrop-blur active:bg-white/25"
            title="Decision history"
          >
            📋
          </button>

          {/* Bet amount stepper */}
          <button
            type="button"
            onClick={() => setBetAmount((n) => Math.max(1, n - 5))}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-sm font-bold text-white backdrop-blur active:bg-white/30"
          >
            −
          </button>
          <span className="min-w-[2.8rem] text-center text-sm font-semibold text-white drop-shadow">
            ${betAmount}
          </span>
          <button
            type="button"
            onClick={() => setBetAmount((n) => n + 5)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-sm font-bold text-white backdrop-blur active:bg-white/30"
          >
            +
          </button>
        </div>
      </div>

      {mapExpanded ? (
        <div className="absolute right-4 top-24 z-40 flex flex-col items-center gap-6">
          <IconRailButton
            active={showZones}
            onClick={() => setShowZones((v) => !v)}
            title="Zones"
          >
            <IconLayers />
          </IconRailButton>
          <IconRailButton
            active={showCheckpoints}
            onClick={() => setShowCheckpoints((v) => !v)}
            title="Attractions"
          >
            <IconSparkle />
          </IconRailButton>
          <IconRailButton active onClick={() => undefined} title="Live bets">
            <IconCoin />
          </IconRailButton>
          <IconRailButton
            active={mapFollow}
            onClick={() => setMapFollow(true)}
            title={mapFollow ? "Following streamer" : "Tap to follow streamer"}
          >
            <IconCrosshair />
          </IconRailButton>
        </div>
      ) : null}
      {mapExpanded && geoLoading && !geoLoadedOnce ? (
        <div className="pointer-events-none absolute left-4 right-4 top-40 z-40 rounded-xl border border-white/20 bg-black/45 px-3 py-2 text-[11px] text-white/80 backdrop-blur">
          Loading zones…
        </div>
      ) : null}
      {mapExpanded && !mapFollow ? (
        <button
          type="button"
          onClick={() => setMapFollow(true)}
          className="absolute bottom-48 right-4 z-50 flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-500/30 px-3 py-1.5 text-[11px] font-semibold text-amber-50 shadow-lg backdrop-blur active:bg-amber-500/50"
          title="Recenter on streamer"
        >
          <span className="text-base leading-none">◎</span>
          Center on streamer
        </button>
      ) : null}
      {mapExpanded ? (
        <div className="absolute left-4 right-4 top-40 z-40 flex flex-wrap gap-1.5">
          {showZones
            ? zones.map((zone) => {
                const selected = selectedZoneId === zone.id;
                return (
                  <button
                    key={zone.id}
                    type="button"
                    onClick={() => {
                      setSelectedZoneId(selected ? null : zone.id);
                      setSelectedCheckpointId(null);
                    }}
                    className={`rounded-full border px-2 py-1 text-[10px] ${
                      selected
                        ? "border-cyan-300/70 bg-cyan-500/35 text-cyan-50"
                        : "border-white/20 bg-black/40 text-white/80"
                    }`}
                  >
                    {zone.name}
                  </button>
                );
              })
            : null}
          {showCheckpoints
            ? checkpoints.map((checkpoint) => {
                const selected = selectedCheckpointId === checkpoint.id;
                return (
                  <button
                    key={checkpoint.id}
                    type="button"
                    onClick={() => {
                      setSelectedCheckpointId(selected ? null : checkpoint.id);
                      setSelectedZoneId(null);
                    }}
                    className={`rounded-full border px-2 py-1 text-[10px] ${
                      selected
                        ? "border-fuchsia-300/70 bg-fuchsia-500/35 text-fuchsia-50"
                        : "border-white/20 bg-black/40 text-white/80"
                    }`}
                  >
                    {checkpoint.name}
                  </button>
                );
              })
            : null}
        </div>
      ) : null}

      {/* ── PiP corner: swapped view + expand toggle ── */}
      <div
        className="absolute z-30 overflow-hidden rounded-2xl border border-white/25 shadow-2xl"
        style={{
          top: pipPos.top,
          left: pipPos.left,
          width: "56vw",
          height: "56vw",
          maxWidth: 260,
          maxHeight: 260,
          opacity: 0.9,
          touchAction: "none",
          cursor: pipDragReady ? "grabbing" : "grab",
        }}
        onPointerDown={onPipPointerDown}
        onPointerMove={onPipPointerMove}
        onPointerUp={onPipPointerUp}
        onPointerCancel={onPipPointerUp}
      >
        {mapExpanded ? (
          /* PiP shows the camera stream when map is fullscreen */
          <LiveVideoPlayer
            liveSessionId={room.liveSessionId}
            className="h-full w-full"
          />
        ) : (
          /* PiP shows the map when video is fullscreen */
          <>
            <LiveMap
              routePoints={routePoints}
              className="h-full w-full"
              interactive={false}
              audienceRole="viewer"
              transportMode={room.transportMode}
              rotateWithHeading={true}
              tileOpacity={0.65}
              mapCaption={currentMarket?.title}
              zones={zones}
              checkpoints={checkpoints}
              selectedZoneId={selectedZoneId}
              selectedCheckpointId={selectedCheckpointId}
              showZones={showZones}
              showCheckpoints={showCheckpoints}
              turnTarget={viewerTurnTarget}
              driverRoute={driverRoute}
              driverCheckpoint={driverCheckpoint}
              railPhase={viewerRailPhase}
            />
            {routePoints.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-[9px] text-white/70">
                Waiting for GPS…
              </div>
            )}
          </>
        )}

        {/* Swap / expand button */}
        <button
          data-pip-no-drag
          type="button"
          onClick={() => setMapExpanded((v) => !v)}
          className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur active:bg-black/75"
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

      {/* ── Bottom gradient scrim ────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-black/70 to-transparent" />

      {mapExpanded && showLiveBets && selectedTargetLabel ? (
        <MapSelectionBottomSheet
          selectedLabel={selectedTargetLabel}
          marketTitle={currentMarket?.title ?? "Live market"}
          marketOptions={currentMarket?.options ?? []}
          selectedOptionId={selectedMapOptionId}
          onSelectOption={setSelectedMapOptionId}
          bettingClosed={isLocked || !currentMarket}
          isPlacing={!!placingOptionId}
          error={mapSheetError}
          countdown={currentMarket ? <MarketTimer locksAt={currentMarket.locksAt} /> : null}
          onClose={() => {
            setSelectedZoneId(null);
            setSelectedCheckpointId(null);
            setMapSheetError(null);
          }}
          onPlaceBet={async () => {
            if (!selectedMapOptionId) return;
            const result = await placeBet(selectedMapOptionId);
            if (result?.ok) {
              setSelectedZoneId(null);
              setSelectedCheckpointId(null);
              setMapSheetError(null);
            }
          }}
        />
      ) : null}

      {/* ── Joystick — always at exact same position ── */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center px-4 pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))]">
        <div className="pointer-events-auto flex flex-col items-center">
          <DirectionalBetPad
            options={currentMarket?.options ?? []}
            betAmount={betAmount}
            onBet={async (optionId) => {
              await placeBet(optionId);
            }}
            locked={isLocked || !currentMarket || !!placingOptionId}
            routePoints={routePoints}
          />
          {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function MarketTimer({ locksAt }: { locksAt: string }) {
  const { secondsLeft, label } = useCountdown(locksAt);
  const locked = secondsLeft <= 0;
  return (
    <span
      className={`shrink-0 text-xs font-semibold ${
        locked
          ? "text-red-400"
          : secondsLeft < 10
            ? "text-amber-400"
            : "text-white/45"
      }`}
    >
      {locked ? "locked" : label}
    </span>
  );
}

function MapSelectionBottomSheet({
  selectedLabel,
  marketTitle,
  marketOptions,
  selectedOptionId,
  onSelectOption,
  bettingClosed,
  isPlacing,
  error,
  countdown,
  onClose,
  onPlaceBet,
}: {
  selectedLabel: string;
  marketTitle: string;
  marketOptions: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  bettingClosed: boolean;
  isPlacing: boolean;
  error: string | null;
  countdown: ReactNode;
  onClose: () => void;
  onPlaceBet: () => Promise<void>;
}) {
  const sorted = [...marketOptions].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <div className="absolute inset-x-0 bottom-0 z-[65] px-3 pb-[calc(5.2rem+env(safe-area-inset-bottom,0px))]">
      <div className="rounded-2xl border border-white/15 bg-black/75 p-3 text-white shadow-2xl backdrop-blur">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-xs font-semibold">{selectedLabel}</div>
          <div className="ml-auto text-[10px] text-white/60">{countdown}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70"
          >
            Close
          </button>
        </div>
        <div className="mb-2 text-[10px] text-white/65">{marketTitle}</div>
        <div className="space-y-1">
          {sorted.map((opt) => {
            const active = selectedOptionId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onSelectOption(opt.id)}
                className={`block w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${
                  active
                    ? "border border-red-400/60 bg-red-500/20 text-white"
                    : "border border-transparent bg-white/5 text-white/85"
                }`}
              >
                {opt.shortLabel ?? opt.label}
              </button>
            );
          })}
        </div>
        {error ? <div className="mt-2 text-[10px] text-red-300">{error}</div> : null}
        <button
          type="button"
          disabled={bettingClosed || !selectedOptionId || isPlacing}
          onClick={() => void onPlaceBet()}
          className="mt-3 w-full rounded-xl bg-red-500 px-3 py-2 text-xs font-semibold text-white disabled:bg-white/20 disabled:text-white/50"
        >
          {bettingClosed
            ? "Betting closed"
            : isPlacing
              ? "Placing..."
              : !selectedOptionId
                ? "Select option"
                : "Place bet"}
        </button>
      </div>
    </div>
  );
}
