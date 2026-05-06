"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  type CityGridSpecCompact,
  cellIdForPosition,
  cellLabel,
  enumerateGridCells,
  gridCellCenter,
  parseGridOptionId,
  type Wgs84LatLngBoundsTuple,
} from "@/lib/live/grid/cityGrid500";
import { drivingRouteStyleBadges } from "@/lib/live/routing/drivingRouteStyle";
import dynamic from "next/dynamic";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LIVE_BET_LOCK_DISTANCE_M } from "@/lib/live/liveBetLockDistance";
import { liveBetRelaxClient } from "@/lib/live/liveBetRelax";
import { metersBetween, squareWgs84BoundsFromCenter } from "@/lib/live/routing/geometry";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { DirectionalBetPad } from "./DirectionalBetPad";
import { LiveDecisionStatusRibbon } from "./LiveDecisionStatusRibbon";
import { useCountdown } from "./useCountdown";
import { BetPlacedPill, LiveEventToasts, useBetPill } from "./LiveEventToasts";
import { SkillFeedbackCard, type SkillFeedbackData } from "./SkillFeedbackCard";
import { ReplaySheet } from "./ReplaySheet";
import { LiveViewerStakePicker } from "./LiveViewerStakePicker";
import { TopBar } from "@/components/layout/top-bar";
import { BottomNav } from "@/components/layout/bottom-nav";
import { useActiveBetRound } from "@/hooks/useActiveBetRound";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";
import {
  IconRailButton,
  IconLayers,
  IconSparkle,
  IconCoin,
  IconCrosshair,
} from "./OwnerLiveControlPanel";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";
import type { BetTypeV2 } from "@bettok/live";
import {
  isEngineMarketType,
  provisionalOptionsForBetType,
} from "@/lib/live/betting/engineMarketOptions";

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

function isViewerZoneEngineType(t: BetTypeV2 | null | undefined): boolean {
  if (!t) return false;
  return (
    t === "next_zone" ||
    t === "zone_exit_time" ||
    t === "zone_duration" ||
    t === "turns_before_zone_exit" ||
    t === "stop_count"
  );
}

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const pathname = usePathname();
  const immersiveLiveRoom = (pathname ?? "").startsWith("/live/rooms/");

  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(
    initialRoom.routePoints ?? [],
  );
  const lastStakeAmount = useViewerChromeStore((s) => s.lastStakeAmount);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapSheetError, setMapSheetError] = useState<string | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [skillFeedback, setSkillFeedback] = useState<SkillFeedbackData | null>(null);
  /** When true: map is full-screen, camera feed is in the corner pip */
  const [mapExpanded, setMapExpanded] = useState(true);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedMapOptionId, setSelectedMapOptionId] = useState<string | null>(null);
  const [showZones, setShowZones] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(true);
  const [mapFollow, setMapFollow] = useState(true);
  const [osmCheckpoints, setOsmCheckpoints] = useState<MapCheckpoint[]>([]);
  const [pipPos, setPipPos] = useState({ top: 48, left: 12 });
  const [pipDragReady, setPipDragReady] = useState(false);
  const [driverPins, setDriverPins] = useState<
    Array<{ lat: number; lng: number; id?: number | string; distanceMeters?: number }> | null
  >(null);
  const [approachLine, setApproachLine] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  const [destinationRoute, setDestinationRoute] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  const destinationRouteRef = useRef(destinationRoute);
  destinationRouteRef.current = destinationRoute;
  const [destinationEtaSec, setDestinationEtaSec] = useState<number | null>(null);
  const [destinationDistanceM, setDestinationDistanceM] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [myOpenBetMarketIds, setMyOpenBetMarketIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setMyOpenBetMarketIds(new Set());
  }, [room.roomId]);
  const [lastBetMarketId, setLastBetMarketId] = useState<string | null>(null);
  const [lastBetOptionLabel, setLastBetOptionLabel] = useState<string | null>(null);
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
  const [joyPortalReady, setJoyPortalReady] = useState(false);
  /** Latched blue-pin position so viewer UI does not jump when /driver-route refreshes. */
  const [stickyViewerPin, setStickyViewerPin] = useState<{
    id: number | string;
    lat: number;
    lng: number;
  } | null>(null);
  const skillFeedbackTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const { betPill, flash } = useBetPill();
  const { data: activeBettingRound } = useActiveBetRound(room.roomId, 2500);
  const [viewerEnginePillType, setViewerEnginePillType] = useState<BetTypeV2 | null>(
    null,
  );

  useEffect(() => {
    const eligible = activeBettingRound?.eligibleRoundPlans ?? [];
    const types = new Set(eligible.map((p) => p.type));
    setViewerEnginePillType((prev) =>
      prev != null && !types.has(prev) ? null : prev,
    );
  }, [activeBettingRound]);

  useEffect(() => {
    setViewerEnginePillType(null);
  }, [room.currentMarket?.id]);

  // ── Bet rotation ────────────────────────────────────────────────────────────
  // next_turn always preempts (it's time-sensitive). For everything else, cycle
  // through the eligible plans every 20 s so viewers see all bet types over time.
  const nextTurnEligible =
    activeBettingRound?.eligibleRoundPlans?.some((p) => p.type === "next_turn") ?? false;

  const nonTurnPlans = useMemo(
    () => (activeBettingRound?.eligibleRoundPlans ?? []).filter((p) => p.type !== "next_turn"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeBettingRound?.eligibleRoundPlans?.map((p) => p.type).join(",")],
  );

  const [rotationIdx, setRotationIdx] = useState(0);
  const prevNonTurnKeyRef = useRef("");

  // Reset index when the eligible set changes so we start fresh.
  useEffect(() => {
    const key = nonTurnPlans.map((p) => p.type).join(",");
    if (key !== prevNonTurnKeyRef.current) {
      prevNonTurnKeyRef.current = key;
      setRotationIdx(0);
    }
  }, [nonTurnPlans]);

  // Advance rotation every 20 s (only when next_turn is not active).
  useEffect(() => {
    if (nonTurnPlans.length <= 1 || nextTurnEligible) return;
    const id = setInterval(() => {
      setRotationIdx((prev) => (prev + 1) % nonTurnPlans.length);
    }, 20_000);
    return () => clearInterval(id);
  }, [nonTurnPlans.length, nextTurnEligible]);

  const rotatedPlanType =
    nonTurnPlans[Math.min(rotationIdx, Math.max(0, nonTurnPlans.length - 1))]?.type ?? null;

  const effectiveEngineType: BetTypeV2 | null =
    viewerEnginePillType ??
    (nextTurnEligible ? ("next_turn" as BetTypeV2) : null) ??
    rotatedPlanType ??
    null;

  /**
   * Stable display bet — only switches to a new type when:
   *  1. The user explicitly tapped a pill (`viewerEnginePillType` changed), OR
   *  2. The effective engine type changed AND the current type has been shown for ≥5 s
   *     AND the new type is expected to last ≥5 s (we can't perfectly predict this,
   *     so we just enforce the 5 s minimum hold on the outgoing type).
   */
  const [stableDisplayBetType, setStableDisplayBetType] = useState<BetTypeV2 | null>(
    effectiveEngineType,
  );
  const stableDisplayLastChangedAtRef = useRef<number>(0);
  const BET_MIN_DISPLAY_MS = 5_000;

  useEffect(() => {
    if (viewerEnginePillType != null) {
      // User explicitly selected a pill — switch immediately.
      setStableDisplayBetType(viewerEnginePillType);
      stableDisplayLastChangedAtRef.current = Date.now();
      return;
    }
    if (effectiveEngineType === stableDisplayBetType) return;
    const elapsed = Date.now() - stableDisplayLastChangedAtRef.current;
    if (elapsed >= BET_MIN_DISPLAY_MS) {
      setStableDisplayBetType(effectiveEngineType);
      stableDisplayLastChangedAtRef.current = Date.now();
    } else {
      // Schedule a re-check when the hold period expires.
      const remaining = BET_MIN_DISPLAY_MS - elapsed;
      const t = setTimeout(() => {
        setStableDisplayBetType((prev) => {
          if (prev !== effectiveEngineType) {
            stableDisplayLastChangedAtRef.current = Date.now();
            return effectiveEngineType;
          }
          return prev;
        });
      }, remaining);
      return () => clearTimeout(t);
    }
  }, [effectiveEngineType, viewerEnginePillType]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setJoyPortalReady(true);
  }, []);

  const handleSettlement = useCallback((data: SkillFeedbackData) => {
    setSkillFeedback(data);
    if (skillFeedbackTimerRef.current) clearTimeout(skillFeedbackTimerRef.current);
    skillFeedbackTimerRef.current = setTimeout(() => setSkillFeedback(null), 7000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onViewerRoomActivity = useCallback(
    (summary: { myOpenBetMarketIds: string[] }) => {
      setMyOpenBetMarketIds(new Set(summary.myOpenBetMarketIds));
    },
    [],
  );

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
          setRoutePoints((prev) => {
            const next = json.points;
            if (prev.length === next.length) {
              const prevLast = prev[prev.length - 1];
              const nextLast = next[next.length - 1];
              if (
                (!prevLast && !nextLast) ||
                (prevLast &&
                  nextLast &&
                  prevLast.lat === nextLast.lat &&
                  prevLast.lng === nextLast.lng &&
                  (prevLast.heading ?? null) === (nextLast.heading ?? null) &&
                  (prevLast.speedMps ?? null) === (nextLast.speedMps ?? null))
              ) {
                return prev;
              }
            }
            return next;
          });
        }
      } catch {
        /* transient */
      }
    };
    fetchPoints();
    const id = setInterval(fetchPoints, 330);
    return () => clearInterval(id);
  }, [room.liveSessionId]);

  async function placeBet(optionId: string) {
    if (!room.currentMarket) return;
    const market = room.currentMarket;
    setError(null);
    setMapSheetError(null);
    setPlacingOptionId(optionId);
    try {
      const res = await fetch(`/api/live/rooms/${room.roomId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: market.id,
          optionId,
          stakeAmount: lastStakeAmount,
        }),
      });
      if (res.ok) {
        flash(lastStakeAmount);
        let pickedLabel: string | null = null;
        if (market.marketType === "city_grid") {
          const spec = market.cityGridSpec;
          const p = parseGridOptionId(optionId);
          pickedLabel = p && spec ? cellLabel(p.row, p.col) : optionId;
        } else {
          pickedLabel =
            market.options.find((o) => o.id === optionId)?.shortLabel ??
            market.options.find((o) => o.id === optionId)?.label ??
            null;
        }
        setLastBetMarketId(market.id);
        setLastBetOptionLabel(pickedLabel);
        setMyOpenBetMarketIds((prev) => new Set(prev).add(market.id));
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

  useEffect(() => {
    setStickyViewerPin(null);
  }, [room.roomId]);

  useEffect(() => {
    const last = routePoints[routePoints.length - 1];
    const apiHead = driverPins?.[0];
    const PASSED_CLEAR_LINE_M = 12;
    const marketTurn =
      currentMarket?.turnPointLat != null &&
      currentMarket?.turnPointLng != null &&
      currentMarket.id
        ? {
            id: `market:${currentMarket.id}`,
            lat: currentMarket.turnPointLat,
            lng: currentMarket.turnPointLng,
          }
        : null;

    setStickyViewerPin((sticky) => {
      let next = sticky;

      if (next && last && metersBetween(last, next) < PASSED_CLEAR_LINE_M) {
        next = null;
      }

      const candidate =
        apiHead?.id != null
          ? { id: apiHead.id, lat: apiHead.lat, lng: apiHead.lng }
          : marketTurn;

      if (!next && candidate) return candidate;

      if (next && apiHead?.id === next.id) {
        return { ...next, lat: apiHead.lat, lng: apiHead.lng };
      }

      return next;
    });
  }, [
    driverPins,
    routePoints,
    currentMarket?.id,
    currentMarket?.turnPointLat,
    currentMarket?.turnPointLng,
  ]);

  const cityGridSpec =
    currentMarket?.marketType === "city_grid"
      ? (currentMarket.cityGridSpec as CityGridSpecCompact | null | undefined)
      : null;

  const zones: MapZone[] = useMemo(() => {
    if (!cityGridSpec) return [];
    const cells = enumerateGridCells(cityGridSpec);
    return cells.map((c) => ({
      id: c.id,
      slug: c.id,
      name: c.label,
      kind: "district" as const,
      color: `hsl(${(c.col * 37 + c.row * 17) % 360} 38% 52%)`,
      isActive: true,
      polygon: c.polygon,
    }));
  }, [cityGridSpec]);

  const zoneMarketActive =
    currentMarket?.marketType === "city_grid" && zones.length > 0;

  const zoneEngineBetActive = (() => {
    const t = effectiveEngineType;
    if (!t || !zoneMarketActive) {
      return false;
    }
    return (
      t === "next_zone" ||
      t === "zone_exit_time" ||
      t === "zone_duration" ||
      t === "turns_before_zone_exit" ||
      t === "stop_count"
    );
  })();

  /** Same as toggling the layers button on whenever the live bet uses the grid. */
  const effectiveShowZones = zoneMarketActive || showZones;

  const PASSED_HIDE_PIN_LINE_M = 12;
  const routeLast =
    routePoints.length > 0 ? routePoints[routePoints.length - 1]! : null;

  /**
   * Single source of truth for "what bet is the viewer looking at right now".
   * Uses the stable (≥5 s hold) version so the UI doesn't flicker.
   * Pill click bypasses the hold and switches immediately.
   */
  const displayBetType: BetTypeV2 | null = stableDisplayBetType;

  const zonesVisualStyleForBet =
    displayBetType === "next_zone" ? "pick_zone" : zoneEngineBetActive ? "muted" : "default";

  const zoneWholeViewBet =
    displayBetType === "turns_before_zone_exit" || displayBetType === "stop_count";

  /**
   * Main zoom guideline (driven by bottom popup active bet):
   * - next_zone: widest view (zoomed out)
   * - turns/stops in zone: zoom out enough to see whole current zone
   * - all other bets: keep default app zoom
   */
  const viewerTargetWidthMeters =
    displayBetType === "next_zone"
      ? 700
      : zoneWholeViewBet
        ? Math.max(600, cityGridSpec?.cellMeters ?? 600)
        : 250;

  /**
   * Viewer follow framing rules:
   *  - `next_turn`  → no fixed bounds; LiveMap uses normal profile zoom (navigation feel).
   *  - `next_zone`  → 1000 m visible width square around current/selected cell center.
   *  - all other bets on city_grid → 500 m visible width square.
   *  - non–city_grid markets → no fixed bounds.
   */
  const viewerGridMapFraming = useMemo((): {
    bounds: Wgs84LatLngBoundsTuple | null;
    minZoom: number | null;
  } => {
    // next_turn: standard nav zoom, no bounds override.
    if (displayBetType === "next_turn" || !routeLast) {
      return { bounds: null, minZoom: null };
    }

    if (currentMarket?.marketType === "city_grid" && cityGridSpec) {
      let centerLat = routeLast.lat;
      let centerLng = routeLast.lng;

      // Prefer the selected cell's center; fall back to driver's cell.
      const sel = selectedZoneId ? parseGridOptionId(selectedZoneId) : null;
      if (
        sel != null &&
        sel.row >= 0 &&
        sel.row < cityGridSpec.nRows &&
        sel.col >= 0 &&
        sel.col < cityGridSpec.nCols
      ) {
        const c = gridCellCenter(cityGridSpec, sel.row, sel.col);
        centerLat = c.lat;
        centerLng = c.lng;
      } else {
        const cell = cellIdForPosition(
          cityGridSpec,
          routeLast.lat,
          routeLast.lng,
        );
        if (cell) {
          const p = parseGridOptionId(cell);
          if (p) {
            const c = gridCellCenter(cityGridSpec, p.row, p.col);
            centerLat = c.lat;
            centerLng = c.lng;
          }
        }
      }

      const pickZone = displayBetType === "next_zone";
      const zoneWhole = displayBetType === "turns_before_zone_exit" || displayBetType === "stop_count";
      // Keep framing consistent with viewerTargetWidthMeters.
      const framingM = pickZone
        ? 700
        : zoneWhole
          ? Math.max(600, cityGridSpec.cellMeters)
          : 500;

      return {
        bounds: squareWgs84BoundsFromCenter(centerLat, centerLng, framingM),
        minZoom: pickZone ? 15.5 : zoneWhole ? 16.0 : 16.5,
      };
    }

    // Non–city_grid markets: apply a fixed frame based on the active bet type.
    // next_turn is excluded above (returns early); everything else gets 500 m.
    if (displayBetType != null) {
      return {
        bounds: squareWgs84BoundsFromCenter(routeLast.lat, routeLast.lng, 500),
        minZoom: 15.5,
      };
    }

    return { bounds: null, minZoom: null };
  }, [
    currentMarket?.marketType,
    cityGridSpec,
    displayBetType,
    routeLast?.lat,
    routeLast?.lng,
    selectedZoneId,
  ]);

  const passedMarketTurn =
    !!viewerTurnTarget &&
    !!routeLast &&
    currentMarket != null &&
    currentMarket.marketType !== "city_grid" &&
    metersBetween(routeLast, viewerTurnTarget) < PASSED_HIDE_PIN_LINE_M;

  /** Hide blue pin once we're essentially at the maneuver (matches server pass semantics). */
  const viewerTurnTargetForMap =
    currentMarket?.marketType !== "city_grid" &&
    viewerTurnTarget &&
    currentMarket &&
    !passedMarketTurn
      ? viewerTurnTarget
      : null;

  const viewerDecisionLatLng =
    viewerTurnTargetForMap != null
      ? { lat: viewerTurnTargetForMap.lat, lng: viewerTurnTargetForMap.lng }
      : stickyViewerPin ??
        (driverPins?.[0]
          ? { lat: driverPins[0].lat, lng: driverPins[0].lng }
          : null);

  // Distance gate: only when market defines a turn point (matches server placeLiveBet).
  const isDistanceLocked =
    !liveBetRelaxClient() &&
    currentMarket?.marketType !== "city_grid" &&
    (() => {
      if (
        currentMarket?.turnPointLat == null ||
        currentMarket?.turnPointLng == null
      ) {
        return false;
      }
      const last = routePoints[routePoints.length - 1];
      if (!last) return false;
      return (
        metersBetween(
          { lat: last.lat, lng: last.lng },
          {
            lat: currentMarket.turnPointLat,
            lng: currentMarket.turnPointLng,
          },
        ) <= LIVE_BET_LOCK_DISTANCE_M
      );
    })();
  const isTimeLocked =
    !liveBetRelaxClient() &&
    !!currentMarket &&
    (() => {
      const t = Date.parse(currentMarket.locksAt);
      if (!Number.isFinite(t)) return false;
      return t <= Date.now();
    })();
  const isLocked = isTimeLocked || isDistanceLocked;

  /** Ribbon: open vs closed from lock distance (+ time safety net), not revealAt flicker. */
  const viewerRailPhase: "none" | "pending" | "active" = (() => {
    if (currentMarket?.marketType === "city_grid") return "none";
    const pinUi = viewerDecisionLatLng;
    if (!pinUi) return "none";
    const last = routePoints[routePoints.length - 1];
    if (!last) return "pending";
    const distBet =
      currentMarket?.turnPointLat != null &&
      currentMarket?.turnPointLng != null
        ? metersBetween(last, {
            lat: currentMarket.turnPointLat,
            lng: currentMarket.turnPointLng,
          })
        : Number.POSITIVE_INFINITY;
    const timeClosed =
      !liveBetRelaxClient() &&
      !!currentMarket &&
      Number.isFinite(Date.parse(currentMarket.locksAt)) &&
      nowTick >= Date.parse(currentMarket.locksAt);
    const distClosed =
      !liveBetRelaxClient() && distBet <= LIVE_BET_LOCK_DISTANCE_M;
    if (distClosed || timeClosed) return "active";
    return "pending";
  })();

  const viewerOsrmPreviewPins = useMemo(() => {
    if (currentMarket?.marketType === "city_grid") return driverPins;
    if (
      viewerTurnTarget &&
      currentMarket &&
      currentMarket.marketType !== "city_grid"
    ) {
      return [];
    }
    if (!stickyViewerPin) return driverPins;
    const dm =
      typeof stickyViewerPin.id === "number"
        ? driverPins?.find((p) => p.id === stickyViewerPin.id)?.distanceMeters
        : undefined;
    const pin: {
      lat: number;
      lng: number;
      id?: number | string;
      distanceMeters?: number;
    } = {
      lat: stickyViewerPin.lat,
      lng: stickyViewerPin.lng,
      id: stickyViewerPin.id,
    };
    if (dm != null) pin.distanceMeters = dm;
    return [pin];
  }, [
    currentMarket?.id,
    currentMarket?.marketType,
    viewerTurnTarget?.lat,
    viewerTurnTarget?.lng,
    stickyViewerPin,
    driverPins,
  ]);
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
  const checkpoints = osmCheckpoints;
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const selectedCheckpoint = checkpoints.find((c) => c.id === selectedCheckpointId) ?? null;
  const selectedTargetLabel = selectedZone?.name ?? selectedCheckpoint?.name ?? null;

  /** Subtitle for directional sheet — zone/checkpoint name, else selected market option. */
  const directionalPickLabel =
    selectedTargetLabel ??
    (currentMarket && currentMarket.marketType !== "city_grid"
      ? (currentMarket.options?.find((o) => o.id === selectedMapOptionId)?.shortLabel ??
          currentMarket.options?.find((o) => o.id === selectedMapOptionId)?.label ??
          null)
      : null);

  const viewerHasBetOnCurrentMarket = Boolean(
    currentMarket && myOpenBetMarketIds.has(currentMarket.id),
  );

  const [betPanelDismissed, setBetPanelDismissed] = useState(false);
  useEffect(() => {
    setBetPanelDismissed(false);
  }, [currentMarket?.id, mapExpanded, displayBetType]);

  const showBetBottomSheet =
    mapExpanded &&
    showLiveBets &&
    currentMarket != null &&
    !betPanelDismissed &&
    !viewerHasBetOnCurrentMarket &&
    !isLocked;

  // Grid cell-picker sheet: only for next_zone on city_grid markets.
  const showViewerGridBetSheet =
    showBetBottomSheet &&
    currentMarket?.marketType === "city_grid" &&
    displayBetType === "next_zone";

  // Directional/option sheet: show whenever a non-turn, non-zone pill is active,
  // even if there is no matching market open yet (button will be disabled).
  const showViewerDirectionalBetSheet =
    mapExpanded &&
    showLiveBets &&
    !betPanelDismissed &&
    !viewerHasBetOnCurrentMarket &&
    displayBetType != null &&
    displayBetType !== "next_turn" &&
    displayBetType !== "next_zone";

  // For engine bet types use the provisional option list (always meaningful labels).
  // For other types fall back to what the open market provides.
  const sheetMarketOptions: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }> =
    displayBetType && isEngineMarketType(displayBetType)
      ? (currentMarket?.marketType === displayBetType && currentMarket.options.length
          ? currentMarket.options
          : provisionalOptionsForBetType(displayBetType as BetTypeV2))
      : (currentMarket?.options ?? []);
  const sheetMarketOptionsLimited = sheetMarketOptions
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .slice(0, 2);

  // Betting is closed when: no market open, time/distance locked, OR the open
  // market is a different type than the engine bet being shown.
  const sheetBettingClosed =
    !currentMarket ||
    isLocked ||
    (isEngineMarketType(displayBetType ?? "") &&
      currentMarket.marketType !== (displayBetType ?? ""));

  const mapBetSheetOpen =
    showViewerGridBetSheet || showViewerDirectionalBetSheet;

  const viewerCurrentBetHeadline =
    displayBetType != null ? engineBetHeadline(displayBetType) : null;

  const sheetBetHeadline = viewerCurrentBetHeadline ?? "Live bet";

  /** Subtitle copy for the grid sheet — driven by the active engine pill. */
  function gridSheetSubtitle(): string {
    if (!displayBetType) return "Tap the map to pick a cell.";
    switch (displayBetType) {
      case "next_zone":
        return selectedZone
          ? `Selected · ${selectedZone.name}`
          : "Tap the map to pick a square, then Place bet.";
      case "turns_before_zone_exit":
        return "How many turns before the driver leaves this zone?";
      case "stop_count":
        return "How many stops in this zone?";
      case "zone_exit_time":
        return "How long until the driver leaves this zone?";
      case "zone_duration":
        return "How long will the driver stay in this zone?";
      default:
        return selectedZone
          ? `Selected · ${selectedZone.name}`
          : "Tap the map once to pick a cell, then tap Place bet.";
    }
  }

  const driverRouteBadges = useMemo(
    () => drivingRouteStyleBadges(room.drivingRouteStyle, room.transportMode),
    [
      room.transportMode,
      room.drivingRouteStyle.comfortVsSpeed,
      room.drivingRouteStyle.pathStyle,
      room.drivingRouteStyle.ecoConscious,
    ],
  );

  useEffect(() => {
    if (currentMarket?.marketType === "city_grid") {
      setSelectedMapOptionId(selectedZoneId);
      return;
    }
    if (displayBetType && isEngineMarketType(displayBetType)) {
      // Prefer the actual market options when they match this bet type; fall
      // back to provisional options so there is always a default selection.
      const source =
        currentMarket?.marketType === displayBetType && currentMarket.options.length
          ? currentMarket.options
          : provisionalOptionsForBetType(displayBetType as BetTypeV2);
      const limited = source
        .slice()
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .slice(0, 2);
      setSelectedMapOptionId(limited[0]?.id ?? null);
      return;
    }
    const first = (currentMarket?.options ?? [])
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .slice(0, 2)[0]?.id ?? null;
    setSelectedMapOptionId(first);
  }, [
    currentMarket?.id,
    currentMarket?.marketType,
    selectedZoneId,
    selectedCheckpointId,
    displayBetType,
  ]);

  useEffect(() => {
    setOsmCheckpoints([]);
  }, []);

  useEffect(() => {
    return () => {
      if (pipLongPressTimerRef.current) clearTimeout(pipLongPressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const placeBottomLeft = () => {
      const boxW = Math.min(window.innerWidth * 0.34, 180);
      const top = Math.max(48, window.innerHeight - boxW - 76);
      setPipPos({ top, left: 12 });
    };
    placeBottomLeft();
    window.addEventListener("resize", placeBottomLeft);
    return () => window.removeEventListener("resize", placeBottomLeft);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchDest = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const r = await fetch(
          `/api/live/rooms/${room.roomId}/destination-route`,
          { cache: "no-store" },
        );
        if (!r.ok) {
          retryTimer = setTimeout(() => {
            void fetchDest();
          }, 1000);
          return;
        }
        const j = (await r.json()) as {
          route: {
            polyline: Array<{ lat: number; lng: number }>;
            distanceMeters: number;
            durationSec: number;
          } | null;
          distanceToDestinationMeters?: number;
          reason?: "no_room" | "no_destination" | "no_position" | "arrived";
        };
        if (cancelled) return;
        // Only update when we have an actual Google road polyline.
        // Keep last valid route on transient misses; retry until Google returns again.
        if (j.route?.polyline && j.route.polyline.length > 1) {
          setDestinationRoute(j.route.polyline);
        } else if (j.reason === "no_destination" || j.reason === "arrived") {
          setDestinationRoute(null);
        }
        setDestinationDistanceM(
          j.route?.distanceMeters ?? j.distanceToDestinationMeters ?? null,
        );
        setDestinationEtaSec(j.route?.durationSec ?? null);
      } catch {
        /* transient */
      } finally {
        if (!cancelled) {
          const cur = destinationRouteRef.current;
          const delay =
            cur && cur.length > 1 ? 2000 : 1000;
          retryTimer = setTimeout(() => {
            void fetchDest();
          }, delay);
        }
      }
    };
    void fetchDest();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [room.roomId]);

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
            pins: Array<{ id: number; lat: number; lng: number; distanceMeters: number }>;
            approachLine: Array<{ lat: number; lng: number }>;
          } | null;
        };
        if (cancelled) return;
        if (j.instruction && j.instruction.pins.length > 0) {
          setDriverPins(j.instruction.pins);
          setApproachLine(
            j.instruction.approachLine.length >= 2
              ? j.instruction.approachLine
              : null,
          );
        } else {
          setDriverPins(null);
          setApproachLine(null);
        }
      } catch {
        /* transient */
      }
    };
    void fetchRoute();
    const id = setInterval(fetchRoute, 700);
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
    const boxW = Math.min(window.innerWidth * 0.34, 180);
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

  const showJoystick =
    joyPortalReady &&
    showLiveBets &&
    currentMarket != null &&
    !viewerHasBetOnCurrentMarket &&
    !isLocked &&
    (currentMarket.marketType !== "city_grid" ||
      effectiveEngineType === "next_turn") &&
    (!mapBetSheetOpen || effectiveEngineType === "next_turn");

  const joystickLocked =
    isLocked ||
    !currentMarket ||
    (currentMarket.marketType === "city_grid" &&
      effectiveEngineType !== "next_turn") ||
    !!placingOptionId ||
    viewerHasBetOnCurrentMarket;

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
      {immersiveLiveRoom ? null : <TopBar />}
      {immersiveLiveRoom ? <LiveViewerStakePicker /> : null}
      <LiveDecisionStatusRibbon
        phase={viewerRailPhase}
        locksAt={currentMarket?.locksAt ?? null}
        revealAt={currentMarket?.revealAt ?? null}
        turnPoint={viewerDecisionLatLng}
        driverPos={viewerDriverPos}
        betOptionLabel={
          currentMarket && lastBetMarketId === currentMarket.id
            ? lastBetOptionLabel
            : null
        }
        currentBetHeadline={viewerCurrentBetHeadline}
        nowTick={nowTick}
        eligibleRoundPlans={activeBettingRound?.eligibleRoundPlans ?? []}
        highlightedEngineType={effectiveEngineType}
        onSelectEngineType={(t) => {
          setViewerEnginePillType((prev) => (prev === t ? null : t));
        }}
      />
      <BottomNav />
      <LiveEventToasts
        roomId={room.roomId}
        role="viewer"
        onSettlement={handleSettlement}
        onRoomActivity={onViewerRoomActivity}
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
            showCourseArrow={true}
            transportMode={room.transportMode}
            rotateWithHeading={true}
            followMode={mapFollow}
            onUserInteract={() => setMapFollow(false)}
            tileOpacity={1}
            mapCaption={
              viewerCurrentBetHeadline ?? currentMarket?.title ?? undefined
            }
            zones={zones}
            checkpoints={checkpoints}
            selectedZoneId={selectedZoneId}
            selectedCheckpointId={selectedCheckpointId}
            showZones={effectiveShowZones}
            zonesVisualStyle={zonesVisualStyleForBet}
            showCheckpoints={true}
            turnTarget={viewerTurnTargetForMap}
            driverPins={viewerOsrmPreviewPins}
            approachLine={approachLine}
            railPhase={viewerRailPhase}
            destination={room.destination}
            destinationRoute={destinationRoute}
            destinationRouteLabel="Google suggested route"
            driverRouteBadges={driverRouteBadges}
            viewerFollowLatLngBounds={viewerGridMapFraming.bounds}
            viewerFollowBoundsMinZoom={viewerGridMapFraming.minZoom}
            viewerTargetWidthMeters={viewerTargetWidthMeters}
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

      {room.destination ? (
        <div className="pointer-events-none fixed bottom-[4.75rem] left-2 z-30 max-w-[min(72vw,14rem)]">
          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-white/10 bg-black/35 px-1.5 py-px text-[8px] font-normal leading-tight text-white/55 shadow-none backdrop-blur-sm">
            <span className="shrink-0 opacity-70" aria-hidden>
              📍
            </span>
            <span className="min-w-0 flex-1 truncate">{room.destination.label}</span>
            {destinationDistanceM != null && (
              <span className="shrink-0 tabular-nums opacity-60">
                · {formatDistance(destinationDistanceM)}
                {destinationEtaSec != null ? ` · ${formatEta(destinationEtaSec)}` : ""}
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Corner live dot + compact actions (no stake stepper — use header stake) */}
      <div
        className="pointer-events-none fixed left-3 top-3 z-[62]"
        role="status"
        aria-label="Live broadcast"
      >
        <span
          className="relative flex h-3 w-3 items-center justify-center"
          title="Live"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.95)]" />
        </span>
      </div>
      <button
        type="button"
        onClick={() => setShowReplay(true)}
        className="fixed right-3 top-3 z-[62] flex h-7 w-7 items-center justify-center rounded-full bg-black/35 text-xs text-white/75 shadow-md backdrop-blur active:bg-black/50"
        title="Decision history"
      >
        📋
      </button>

      {mapExpanded ? (
        <div className="absolute right-4 top-[10.5rem] z-40 flex flex-col items-center gap-5">
          <IconRailButton
            active={effectiveShowZones}
            onClick={() => setShowZones((v) => !v)}
            title={
              zoneMarketActive
                ? "Zones on for this bet"
                : effectiveShowZones
                  ? "Hide zones"
                  : "Show zones"
            }
          >
            <IconLayers />
          </IconRailButton>
          <IconRailButton
            active
            onClick={() => setShowCheckpoints(true)}
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
      {/* ── PiP corner: swapped view + expand toggle ── */}
      <div
        className="absolute z-30 overflow-hidden rounded-2xl border border-white/25 shadow-2xl"
        style={{
          top: pipPos.top,
          left: pipPos.left,
          width: "34vw",
          height: "34vw",
          maxWidth: 180,
          maxHeight: 180,
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
              showCourseArrow={true}
              transportMode={room.transportMode}
              rotateWithHeading={true}
              tileOpacity={0.65}
              mapCaption={
              viewerCurrentBetHeadline ?? currentMarket?.title ?? undefined
            }
              zones={zones}
              checkpoints={checkpoints}
              selectedZoneId={selectedZoneId}
              selectedCheckpointId={selectedCheckpointId}
              showZones={effectiveShowZones}
              zonesVisualStyle={zonesVisualStyleForBet}
              showCheckpoints={true}
              turnTarget={viewerTurnTargetForMap}
              driverPins={viewerOsrmPreviewPins}
              approachLine={approachLine}
              railPhase={viewerRailPhase}
              destination={room.destination}
              destinationRoute={destinationRoute}
              destinationRouteLabel="Google suggested route"
              driverRouteBadges={driverRouteBadges}
              viewerFollowLatLngBounds={viewerGridMapFraming.bounds}
              viewerFollowBoundsMinZoom={viewerGridMapFraming.minZoom}
              viewerTargetWidthMeters={viewerTargetWidthMeters}
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

      {showViewerGridBetSheet ? (
        <MapSelectionBottomSheet
          betHeadline={
            viewerCurrentBetHeadline ??
            currentMarket.title ??
            sheetBetHeadline
          }
          selectionDetail={gridSheetSubtitle()}
          marketOptions={[]}
          selectedOptionId={selectedZoneId}
          onSelectOption={() => undefined}
          bettingClosed={isLocked || !currentMarket}
          isPlacing={!!placingOptionId}
          error={mapSheetError}
          countdown={currentMarket ? <MarketTimer locksAt={currentMarket.locksAt} /> : null}
          onClose={() => {
            setSelectedZoneId(null);
            setSelectedCheckpointId(null);
            setMapSheetError(null);
            setBetPanelDismissed(true);
          }}
          onPlaceBet={async () => {
            if (!selectedZoneId) return;
            const result = await placeBet(selectedZoneId);
            if (result?.ok) {
              setSelectedZoneId(null);
              setSelectedCheckpointId(null);
              setMapSheetError(null);
            }
          }}
          gridMode
        />
      ) : null}
      {showViewerDirectionalBetSheet ? (
        <MapSelectionBottomSheet
          betHeadline={
            viewerCurrentBetHeadline ??
            currentMarket?.title ??
            sheetBetHeadline
          }
          selectionDetail={
            directionalPickLabel
              ? `Pick · ${directionalPickLabel}`
              : null
          }
          marketOptions={sheetMarketOptionsLimited}
          selectedOptionId={selectedMapOptionId}
          onSelectOption={setSelectedMapOptionId}
          bettingClosed={sheetBettingClosed}
          bettingPending={
            !currentMarket ||
            (isEngineMarketType(displayBetType ?? "") &&
              currentMarket.marketType !== (displayBetType ?? ""))
          }
          isPlacing={!!placingOptionId}
          error={mapSheetError}
          countdown={currentMarket ? <MarketTimer locksAt={currentMarket.locksAt} /> : null}
          onClose={() => {
            setSelectedZoneId(null);
            setSelectedCheckpointId(null);
            setMapSheetError(null);
            setBetPanelDismissed(true);
          }}
          onPlaceBet={async () => {
            if (!selectedMapOptionId || sheetBettingClosed) return;
            const result = await placeBet(selectedMapOptionId);
            if (result?.ok) {
              setSelectedZoneId(null);
              setSelectedCheckpointId(null);
              setMapSheetError(null);
            }
          }}
        />
      ) : null}

      {betPanelDismissed &&
      mapExpanded &&
      showLiveBets &&
      currentMarket != null &&
      !viewerHasBetOnCurrentMarket ? (
        <button
          type="button"
          onClick={() => setBetPanelDismissed(false)}
          className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] left-1/2 z-[199] -translate-x-1/2 rounded-full border border-violet-400/35 bg-violet-950/75 px-4 py-2 text-[11px] font-semibold text-violet-100 shadow-lg backdrop-blur-md active:bg-violet-900/85"
        >
          Show bet card
        </button>
      ) : null}

      {joyPortalReady && showJoystick
        ? createPortal(
            <div
              className="pointer-events-none fixed right-3 z-[380] flex max-w-[100vw] flex-col items-end"
              style={{
                bottom: "calc(5.25rem + env(safe-area-inset-bottom, 0px))",
              }}
            >
              <div className="pointer-events-auto flex flex-col items-center">
                <DirectionalBetPad
                  options={currentMarket?.options ?? []}
                  betAmount={lastStakeAmount}
                  onBet={async (optionId, _dir) => {
                    await placeBet(optionId);
                  }}
                  locked={joystickLocked}
                  routePoints={routePoints}
                />
                {error ? (
                  <div className="mt-1 max-w-[10rem] text-right text-[10px] text-red-400">
                    {error}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0 m";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0 min";
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
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
  betHeadline,
  selectionDetail,
  marketOptions,
  selectedOptionId,
  onSelectOption,
  bettingClosed,
  bettingPending = false,
  isPlacing,
  error,
  countdown,
  onClose,
  onPlaceBet,
  gridMode = false,
}: {
  betHeadline: string;
  selectionDetail: string | null;
  marketOptions: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  bettingClosed: boolean;
  bettingPending?: boolean;
  isPlacing: boolean;
  error: string | null;
  countdown: ReactNode;
  onClose: () => void;
  onPlaceBet: () => Promise<void>;
  gridMode?: boolean;
}) {
  const sorted = [...marketOptions].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[200] px-3 pb-[calc(4.75rem+env(safe-area-inset-bottom,0px))]">
      <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/40 p-2 text-white shadow-lg backdrop-blur-md">
        <div className="mb-1 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold leading-snug text-white">
              {betHeadline}
            </div>
            {selectionDetail ? (
              <div
                className={`mt-1 text-[10px] leading-snug ${
                  gridMode ? "text-white/70" : "mt-0.5 text-white/55"
                }`}
              >
                {selectionDetail}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="text-[10px] text-white/55">{countdown}</div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/75"
            >
              Close
            </button>
          </div>
        </div>
        {gridMode ? null : (
          <div className="max-h-28 space-y-1 overflow-y-auto">
            {sorted.map((opt) => {
              const active = selectedOptionId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onSelectOption(opt.id)}
                  className={`block w-full rounded-lg px-2 py-1 text-left text-[10px] ${
                    active
                      ? "border border-red-400/55 bg-red-500/15 text-white"
                      : "border border-transparent bg-white/5 text-white/80"
                  }`}
                >
                  {opt.shortLabel ?? opt.label}
                </button>
              );
            })}
          </div>
        )}
        {error ? <div className="mt-1.5 text-[10px] text-red-300">{error}</div> : null}
        <button
          type="button"
          disabled={bettingClosed || !selectedOptionId || isPlacing}
          onClick={() => void onPlaceBet()}
          className="mt-2 w-full rounded-lg bg-red-500/90 px-2 py-1.5 text-[11px] font-semibold text-white disabled:bg-white/15 disabled:text-white/45"
        >
          {bettingPending
            ? "Opening soon…"
            : bettingClosed
              ? "Betting closed"
              : isPlacing
                ? "Placing…"
                : !selectedOptionId
                  ? gridMode
                    ? "Choose a cell on the map"
                    : "Select option"
                  : "Place bet"}
        </button>
      </div>
    </div>
  );
}
