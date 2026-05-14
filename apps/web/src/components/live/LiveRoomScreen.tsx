"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import {
  type CityGridSpecCompact,
  cellIdForPosition,
  cellLabel,
  distanceToCurrentCellEdgeMeters,
  enumerateGridCells,
  gridCellCenter,
  parseGridOptionId,
  type Wgs84LatLngBoundsTuple,
} from "@/lib/live/grid/cityGrid500";
import { drivingRouteStyleBadges } from "@/lib/live/routing/drivingRouteStyle";
import dynamic from "next/dynamic";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LIVE_BET_LOCK_DISTANCE_M } from "@/lib/live/liveBetLockDistance";
import {
  MIN_MARKET_OPEN_MS_BEFORE_LOCK,
  VIEWER_BET_MIN_DISPLAY_MS,
} from "@/lib/live/liveBetMinOpenMs";
import { liveBetRelaxClient } from "@/lib/live/liveBetRelax";
import { viewerLiveLog, viewerLiveWarn } from "@/lib/live/viewerLiveConsole";
import { metersBetween, squareWgs84BoundsFromCenter } from "@/lib/live/routing/geometry";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { LiveDecisionStatusRibbon } from "./LiveDecisionStatusRibbon";
import { useCountdown } from "./useCountdown";
import { LiveEventToasts } from "./LiveEventToasts";
import type { SkillFeedbackData } from "./SkillFeedbackCard";
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
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { useUserStore } from "@/stores/user-store";

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
  return t === "next_zone" || t === "zone_exit_time";
}

/** At most once per zone visit; `next_turn` + `time_vs_google` are excluded (repeatable). */
const ZONE_BET_ONCE_ORDER: BetTypeV2[] = [
  "next_zone",
  "zone_exit_time",
];
const ZONE_BET_ONCE_SET = new Set<BetTypeV2>(ZONE_BET_ONCE_ORDER);

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const pathname = usePathname();
  const immersiveLiveRoom = (pathname ?? "").startsWith("/live/rooms/");

  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(
    initialRoom.routePoints ?? [],
  );
  const lastStakeAmount = useViewerChromeStore((s) => s.lastStakeAmount);
  const isMuted = useViewerChromeStore((s) => s.isMuted);
  const wallet = useUserStore((s) => s.wallet);
  const setWallet = useUserStore((s) => s.setWallet);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapSheetError, setMapSheetError] = useState<string | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  /** Big center readout: stake committed, then win (green +) or loss (red -). */
  const [centerMoneyFlash, setCenterMoneyFlash] = useState<{
    kind: "stake" | "win" | "loss";
    amount: number;
    /** Optional descriptor, e.g. "0–1 stops"; rendered as `$2 on 0–1 stops`. */
    target?: string | null;
  } | null>(null);
  const [balanceWinSplash, setBalanceWinSplash] = useState<{
    from: number;
    to: number;
    gain: number;
    nonce: number;
  } | null>(null);
  /** Cache of the most recent city_grid spec so zone polygons keep showing
   *  even while an engine market is the current round. */
  const [latestCityGridSpec, setLatestCityGridSpec] = useState<
    CityGridSpecCompact | null
  >(null);
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
  const passedViewerPinIdsRef = useRef<Set<string>>(new Set());
  const passedMarketTurnIdsRef = useRef<Set<string>>(new Set());
  const centerFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseCenterMoney = useCallback(
    (kind: "stake" | "win" | "loss", amount: number, target?: string | null) => {
      viewerLiveLog("center_money_flash", { kind, amount, target: target ?? null });
      if (centerFlashTimerRef.current) clearTimeout(centerFlashTimerRef.current);
      setCenterMoneyFlash({ kind, amount, target: target ?? null });
      const ms = kind === "stake" ? 1_800 : 2_600;
      centerFlashTimerRef.current = setTimeout(() => {
        setCenterMoneyFlash(null);
        centerFlashTimerRef.current = null;
      }, ms);
    },
    [],
  );
  const pulseBalanceWin = useCallback(
    (gain: number) => {
      if (!Number.isFinite(gain) || gain <= 0) return;
      const from = Number(wallet?.balance ?? 0);
      const to = from + gain;

      setBalanceWinSplash({
        from,
        to,
        gain,
        nonce: Date.now(),
      });
      playMoneySound(isMuted);

      if (wallet) {
        setWallet({
          ...wallet,
          balance: to,
          total_won: Number(wallet.total_won ?? 0) + gain,
        });
      }
    },
    [isMuted, setWallet, wallet],
  );

  useEffect(() => {
    return () => {
      if (centerFlashTimerRef.current) clearTimeout(centerFlashTimerRef.current);
    };
  }, []);
  const { data: activeBettingRound } = useActiveBetRound(room.roomId, 2500);
  const [viewerEnginePillType, setViewerEnginePillType] = useState<BetTypeV2 | null>(
    null,
  );
  const lastAutoPickTypeRef = useRef<BetTypeV2 | null>(null);

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

  // ── Moment-based bet selection (no "next_turn always priority") ────────────
  const eligibleTypes = useMemo<BetTypeV2[]>(
    () => {
      const src = activeBettingRound?.eligibleRoundPlans ?? [];
      const seen = new Set<BetTypeV2>();
      const out: BetTypeV2[] = [];
      for (const p of src) {
        if (!seen.has(p.type)) {
          seen.add(p.type);
          out.push(p.type);
        }
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeBettingRound?.eligibleRoundPlans?.map((p) => p.type).join(",")],
  );

  const [rotationIdx, setRotationIdx] = useState(0);
  useEffect(() => {
    if (eligibleTypes.length <= 1) return;
    const id = setInterval(() => {
      setRotationIdx((prev) => (prev + 1) % eligibleTypes.length);
    }, 8_000);
    return () => clearInterval(id);
  }, [eligibleTypes.length]);

  const currentMarket = room.currentMarket;
  /** Live grid spec only when the current market is a grid round (used for
   *  betting math). */
  const cityGridSpec = useMemo(
    () =>
      currentMarket?.marketType === "city_grid" ||
      currentMarket?.marketType === "zone_exit_time"
        ? (currentMarket.cityGridSpec as CityGridSpecCompact | null | undefined)
        : null,
    [currentMarket?.marketType, currentMarket?.cityGridSpec],
  );
  /** Latch the most recent grid spec so zone polygons remain visible even
   *  while an engine market is the active round. */
  useEffect(() => {
    if (
      (currentMarket?.marketType === "city_grid" ||
        currentMarket?.marketType === "zone_exit_time") &&
      currentMarket.cityGridSpec
    ) {
      setLatestCityGridSpec(
        currentMarket.cityGridSpec as CityGridSpecCompact,
      );
    }
  }, [currentMarket?.marketType, currentMarket?.cityGridSpec]);
  /** Drop the cached spec when the room changes (different driver / viewport). */
  useEffect(() => {
    setLatestCityGridSpec(null);
  }, [room.roomId]);
  const currentZoneId = useMemo(() => {
    const spec = cityGridSpec ?? latestCityGridSpec;
    if (!spec || routePoints.length === 0) return null;
    const last = routePoints[routePoints.length - 1]!;
    return cellIdForPosition(spec, last.lat, last.lng);
  }, [cityGridSpec, latestCityGridSpec, routePoints]);

  /**
   * "Zone" for rotation = named region from streamer session OR current grid cell id.
   * We do **not** have polygon crossing on the client; server sets `region_label` on heartbeat.
   */
  const zoneSessionKey = room.regionLabel ?? currentZoneId ?? null;
  const clientInZone = Boolean(zoneSessionKey);

  const [zoneConsumedBetTypes, setZoneConsumedBetTypes] = useState<Set<BetTypeV2>>(
    () => new Set(),
  );
  useEffect(() => {
    setZoneConsumedBetTypes(new Set());
  }, [zoneSessionKey]);

  const prevZoneSessionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevZoneSessionKeyRef.current === zoneSessionKey) return;
    prevZoneSessionKeyRef.current = zoneSessionKey;
  }, [zoneSessionKey]);

  const effectiveEngineType: BetTypeV2 | null = useMemo(() => {
    if (viewerEnginePillType != null) return viewerEnginePillType;
    // Match the live system market type when it's an engine-driven bet.
    if (
      currentMarket?.marketType &&
      isEngineMarketType(currentMarket.marketType)
    ) {
      return currentMarket.marketType as BetTypeV2;
    }
    if (!eligibleTypes.length) return null;

    const nextPinDist = driverPins?.[0]?.distanceMeters ?? null;
    const inTurnWindow = nextPinDist != null && nextPinDist <= 200 && nextPinDist >= 150;

    const pick = (...types: BetTypeV2[]): BetTypeV2 | null => {
      for (const t of types) if (eligibleTypes.includes(t)) return t;
      return null;
    };

    // 1) next_turn — only within the distance window.
    if (inTurnWindow) {
      const turnBet = pick("next_turn");
      if (turnBet) return turnBet;
    }

    // 2) In zone: one slot per bet type until consumed, next_zone first.
    if (clientInZone) {
      for (const betType of ZONE_BET_ONCE_ORDER) {
        if (!eligibleTypes.includes(betType)) continue;
        if (zoneConsumedBetTypes.has(betType)) continue;
        return betType;
      }
    }

    const rotated = eligibleTypes[rotationIdx % eligibleTypes.length] ?? null;
    if (!rotated) return null;
    if (eligibleTypes.length === 1) return rotated;
    const alt = eligibleTypes[(rotationIdx + 1) % eligibleTypes.length] ?? rotated;
    return rotated === lastAutoPickTypeRef.current ? alt : rotated;
  }, [
    viewerEnginePillType,
    currentMarket?.marketType,
    eligibleTypes,
    rotationIdx,
    clientInZone,
    zoneConsumedBetTypes,
    driverPins,
  ]);

  useEffect(() => {
    if (viewerEnginePillType == null) {
      lastAutoPickTypeRef.current = effectiveEngineType;
    }
  }, [effectiveEngineType, viewerEnginePillType]);

  /**
   * Stable display bet — only switches to a new type when:
   *  1. The user explicitly tapped a pill (`viewerEnginePillType` changed), OR
   *  2. The effective engine type changed AND the current type has been shown for the
   *     minimum hold window (VIEWER_BET_MIN_DISPLAY_MS).
   */
  const [stableDisplayBetType, setStableDisplayBetType] = useState<BetTypeV2 | null>(
    effectiveEngineType,
  );
  const stableDisplayLastChangedAtRef = useRef<number>(0);
  const BET_MIN_DISPLAY_MS = VIEWER_BET_MIN_DISPLAY_MS;

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

  /** After a zone-once bet is shown this long, allow the next type in the zone queue. */
  useEffect(() => {
    if (!clientInZone || viewerEnginePillType != null) return;
    const t = stableDisplayBetType;
    if (!t || !ZONE_BET_ONCE_SET.has(t)) return;
    if (zoneConsumedBetTypes.has(t)) return;
    const id = setTimeout(() => {
      setZoneConsumedBetTypes((prev) => {
        if (prev.has(t)) return prev;
        const next = new Set(prev);
        next.add(t);
        return next;
      });
    }, BET_MIN_DISPLAY_MS);
    return () => clearTimeout(id);
  }, [
    stableDisplayBetType,
    clientInZone,
    viewerEnginePillType,
    zoneConsumedBetTypes,
  ]);

  useEffect(() => {
    setJoyPortalReady(true);
  }, []);

  const handleSettlement = useCallback(
    (data: SkillFeedbackData) => {
      const myOpt = data.options.find((o) => o.id === data.myOptionId) ?? null;
      const targetLabel = myOpt?.shortLabel ?? myOpt?.label ?? null;
      viewerLiveLog("settlement_feedback", {
        won: data.won,
        myOptionId: data.myOptionId,
        targetLabel,
        payoutAmount: data.payoutAmount,
        stakeAmount: data.stakeAmount,
      });
      if (data.won) {
        pulseCenterMoney("win", data.payoutAmount, targetLabel);
        pulseBalanceWin(data.payoutAmount);
      } else {
        pulseCenterMoney("loss", data.stakeAmount, targetLabel);
      }
    },
    [pulseBalanceWin, pulseCenterMoney],
  );

  const onViewerRoomActivity = useCallback(
    (summary: { myOpenBetMarketIds: string[] }) => {
      viewerLiveLog("room_activity", { myOpenBetMarketIds: summary.myOpenBetMarketIds });
      setMyOpenBetMarketIds(new Set(summary.myOpenBetMarketIds));
    },
    [],
  );

  const lastRoomDebugSigRef = useRef("");
  useEffect(() => {
    const sig = JSON.stringify({
      phase: room.phase,
      mid: room.currentMarket?.id ?? null,
      mtype: room.currentMarket?.marketType ?? null,
      locksAt: room.currentMarket?.locksAt ?? null,
      opensAt: room.currentMarket?.opensAt ?? null,
      participants: room.participantCount,
      viewers: room.viewerCount,
    });
    if (sig === lastRoomDebugSigRef.current) return;
    lastRoomDebugSigRef.current = sig;
    viewerLiveLog("room_state_change", {
      roomId: room.roomId,
      phase: room.phase,
      currentMarketId: room.currentMarket?.id ?? null,
      marketType: room.currentMarket?.marketType ?? null,
      title: room.currentMarket?.title ?? null,
      opensAt: room.currentMarket?.opensAt ?? null,
      locksAt: room.currentMarket?.locksAt ?? null,
      revealAt: room.currentMarket?.revealAt ?? null,
      optionCount: room.currentMarket?.options?.length ?? 0,
      optionIds: room.currentMarket?.options?.map((o) => o.id) ?? [],
      regionLabel: room.regionLabel,
      participantCount: room.participantCount,
      viewerCount: room.viewerCount,
    });
  }, [room]);

  useEffect(() => {
    /**
     * Clients only poll /state (read-only).  All room mutations now happen
     * in the server-side cron at /api/cron/live-tick which runs at ~1 Hz
     * and owns the CAS lock — no viewer can race another.
     *
     * Stop condition: /state returning 404 means the room is gone.
     */
    const stopped = { current: false };
    const id = setInterval(async () => {
      if (stopped.current) return;
      try {
        const stateRes = await fetch(
          `/api/live/rooms/${initialRoom.roomId}/state`,
          { cache: "no-store" },
        );

        if (stateRes.ok) {
          const json = (await stateRes.json()) as { room: LiveFeedRow | null };
          if (json.room) setRoom(json.room);
        } else {
          viewerLiveWarn("state_http_error", { status: stateRes.status });
          if (stateRes.status === 404) {
            stopped.current = true;
            clearInterval(id);
          }
        }
      } catch (e) {
        viewerLiveWarn("viewer_poll_error", String(e));
      }
    }, 1500);
    return () => {
      stopped.current = true;
      clearInterval(id);
    };
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
    if (placingOptionId) return;
    const market = room.currentMarket;
    viewerLiveLog("place_bet_request", {
      roomId: room.roomId,
      marketId: market.id,
      marketType: market.marketType,
      optionId,
      stakeAmount: lastStakeAmount,
    });
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
        let pickedLabel: string | null = null;
        if (market.marketType === "city_grid") {
          const spec = market.cityGridSpec;
          const p = parseGridOptionId(optionId);
          pickedLabel = p && spec ? cellLabel(p.row, p.col) : optionId;
        } else if (market.marketType === "zone_exit_time") {
          pickedLabel =
            zoneTimeOptionLabel(
              optionId,
              estimatedZoneSecondsRemaining(market, Date.now()),
            ) ??
            market.options.find((o) => o.id === optionId)?.shortLabel ??
            market.options.find((o) => o.id === optionId)?.label ??
            null;
        } else {
          pickedLabel =
            market.options.find((o) => o.id === optionId)?.shortLabel ??
            market.options.find((o) => o.id === optionId)?.label ??
            null;
        }
        pulseCenterMoney("stake", lastStakeAmount, pickedLabel);
        setSelectedMapOptionId(null);
        setLastBetMarketId(market.id);
        setLastBetOptionLabel(pickedLabel);
        setMyOpenBetMarketIds((prev) => new Set(prev).add(market.id));
        viewerLiveLog("place_bet_ok", {
          marketId: market.id,
          optionId,
          pickedLabel,
          stakeAmount: lastStakeAmount,
        });
        return { ok: true as const };
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        const message = j.error ?? "Bet failed";
        viewerLiveWarn("place_bet_failed", {
          status: res.status,
          message,
          marketId: market.id,
          optionId,
        });
        setError(message);
        setMapSheetError(message);
        return { ok: false as const, error: message };
      }
      return { ok: false as const, error: "Bet failed" };
    } finally {
      setPlacingOptionId(null);
    }
  }

  const viewerTurnTarget = currentMarket?.turnPointLat != null && currentMarket?.turnPointLng != null
    ? { lat: currentMarket.turnPointLat, lng: currentMarket.turnPointLng, kind: "straight" as const, label: "" }
    : null;

  useEffect(() => {
    setStickyViewerPin(null);
    passedViewerPinIdsRef.current = new Set();
    passedMarketTurnIdsRef.current = new Set();
  }, [room.roomId]);

  useEffect(() => {
    const last = routePoints[routePoints.length - 1];
    const apiHead = driverPins?.[0];
    const PASSED_CLEAR_LINE_M = 12;

    setStickyViewerPin((sticky) => {
      let next = sticky;

      if (next && last && metersBetween(last, next) < PASSED_CLEAR_LINE_M) {
        passedViewerPinIdsRef.current.add(String(next.id));
        next = null;
      }

      const candidate =
        apiHead?.id != null
          ? { id: apiHead.id, lat: apiHead.lat, lng: apiHead.lng }
          : null;
      const candidateId = candidate ? String(candidate.id) : null;
      const candidateWasPassed =
        candidateId != null && passedViewerPinIdsRef.current.has(candidateId);

      // Lock pin identity: once shown, never switch to another pin until passed.
      // Also ignore stale "already passed" pins that can briefly come back from API refreshes.
      if (!next && candidate && !candidateWasPassed) return candidate;

      if (next && apiHead?.id === next.id) {
        return { ...next, lat: apiHead.lat, lng: apiHead.lng };
      }

      return next;
    });
  }, [
    driverPins,
    routePoints,
  ]);

  /** Polygons are drawn from `cityGridSpec` when a grid round is live, or from
   *  the latched spec otherwise — viewer always sees the grid once it's known. */
  const zonesSpec = cityGridSpec ?? latestCityGridSpec;
  const zones: MapZone[] = useMemo(() => {
    if (!zonesSpec) return [];
    const cells = enumerateGridCells(zonesSpec);
    return cells.map((c) => ({
      id: c.id,
      slug: c.id,
      name: c.label,
      kind: "district" as const,
      color: `hsl(${(c.col * 37 + c.row * 17) % 360} 38% 52%)`,
      isActive: true,
      polygon: c.polygon,
    }));
  }, [zonesSpec]);

  const zoneMarketActive =
    currentMarket?.marketType === "city_grid" && zones.length > 0;

  const zoneEngineBetActive = (() => {
    const t = effectiveEngineType;
    if (!t || !zoneMarketActive) return false;
    return t === "next_zone" || t === "zone_exit_time";
  })();

  /** Show zones whenever we know the grid — live bet or not — plus when the
   *  layers button is on. Keeps polygons visible across engine ↔ grid cycling. */
  const effectiveShowZones = zones.length > 0 || showZones;

  const PASSED_HIDE_PIN_LINE_M = 12;
  const routeLast =
    routePoints.length > 0 ? routePoints[routePoints.length - 1]! : null;

  /**
   * Single source of truth for "what bet is the viewer looking at right now".
   * Priority:
   *  1) Explicit pill pick by the viewer.
   *  2) Open market (engine or grid) so the headline matches the live round.
   *  3) Stable auto-rotation / heuristics as fallback when between markets.
   */
  const marketAnchoredBetType: BetTypeV2 | null =
    currentMarket?.marketType === "city_grid"
      ? "next_zone"
      : currentMarket?.marketType === "next_turn"
        ? "next_turn"
        : (currentMarket?.marketType &&
              isEngineMarketType(currentMarket.marketType)
            ? (currentMarket.marketType as BetTypeV2)
            : null);
  const displayBetType: BetTypeV2 | null =
    viewerEnginePillType ??
    marketAnchoredBetType ??
    stableDisplayBetType ??
    effectiveEngineType;
  const bettableDisplayBetType: BetTypeV2 | null =
    currentMarket?.marketType &&
    isEngineMarketType(currentMarket.marketType) &&
    displayBetType != null &&
    currentMarket.marketType !== displayBetType
      ? (currentMarket.marketType as BetTypeV2)
      : displayBetType;
  /**
   * What the viewer sheet / headline / locks describe. On `city_grid`, `next_turn` is only a
   * map/camera hint — the actionable bet is still picking a cell (`next_zone`), otherwise both
   * grid and directional sheets stay hidden.
   */
  const viewerBetOfferType: BetTypeV2 | null =
    currentMarket?.marketType === "city_grid" &&
    bettableDisplayBetType === "next_turn"
      ? "next_zone"
      : bettableDisplayBetType;
  /** Map camera tracks intent immediately; ribbon/sheet can stay stable via `displayBetType`. */
  const mapBetTypeForCamera: BetTypeV2 | null =
    viewerEnginePillType ?? effectiveEngineType ?? marketAnchoredBetType;

  const zonesVisualStyleForBet =
    viewerBetOfferType === "next_zone" ? "pick_zone" : zoneEngineBetActive ? "muted" : "default";

  /**
   * Three fixed zoom tiers, one per bet category — every bet maps to exactly one.
   *  - TIGHT (~320 m): next_turn (navigation feel).
   *  - MID   (~850 m): pin / route bets (time_vs_google, turn_count_to_pin, eta_drift).
   *  - WIDE  (~1400 m): zone-level bets (next_zone, stop_count, turns_before_zone_exit,
   *                                       zone_exit_time, zone_duration).
   *    WIDE was 2200 m — viewer asked to bring this in so adjacent cells stay
   *    big enough to tap accurately.
   */
  const ZOOM_TIER_TIGHT_M = 420;
  const ZOOM_TIER_MID_M = 750;
  const ZOOM_TIER_WIDE_M = 1050;
  const viewerTargetWidthMeters = (() => {
    switch (mapBetTypeForCamera) {
      case "next_turn":
        return ZOOM_TIER_TIGHT_M;
      case "next_zone":
      case "zone_exit_time":
        return ZOOM_TIER_WIDE_M;
      default:
        return ZOOM_TIER_MID_M;
    }
  })();

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
    if (mapBetTypeForCamera === "next_turn" || !routeLast) {
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

      const pickZone = mapBetTypeForCamera === "next_zone";
      const framingM = Math.max(320, viewerTargetWidthMeters ?? 320);

      return {
        bounds: squareWgs84BoundsFromCenter(centerLat, centerLng, framingM),
        minZoom: pickZone ? 14.5 : 15.5,
      };
    }

    // Non–city_grid markets: frame by active bet type.
    if (mapBetTypeForCamera != null && routeLast) {
      const pickZone = mapBetTypeForCamera === "next_zone";
      const framingM = Math.max(320, viewerTargetWidthMeters ?? 320);
      return {
        bounds: squareWgs84BoundsFromCenter(routeLast.lat, routeLast.lng, framingM),
        minZoom: pickZone ? 14.5 : 15.5,
      };
    }

    return { bounds: null, minZoom: null };
  }, [
    currentMarket?.marketType,
    cityGridSpec,
    mapBetTypeForCamera,
    routeLast?.lat,
    routeLast?.lng,
    selectedZoneId,
    viewerTargetWidthMeters,
  ]);

  const marketTurnPassKey =
    currentMarket != null && currentMarket.marketType !== "city_grid"
      ? currentMarket.id
      : null;
  const passedMarketTurnByDistance =
    !!viewerTurnTarget &&
    !!routeLast &&
    currentMarket != null &&
    currentMarket.marketType !== "city_grid" &&
    metersBetween(routeLast, viewerTurnTarget) < PASSED_HIDE_PIN_LINE_M;
  useEffect(() => {
    if (marketTurnPassKey && passedMarketTurnByDistance) {
      passedMarketTurnIdsRef.current.add(marketTurnPassKey);
    }
  }, [marketTurnPassKey, passedMarketTurnByDistance]);
  const passedMarketTurn =
    !!marketTurnPassKey && passedMarketTurnIdsRef.current.has(marketTurnPassKey);

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
      : stickyViewerPin
        ? { lat: stickyViewerPin.lat, lng: stickyViewerPin.lng }
        : null;

  // Per-bet lock rules (client-side mirror of server rules):
  // - next_turn: lock at <= 70m to next pin (looser, keeps market open longer)
  // - next_turn: lock at <= 70m to next pin
  // - next_zone: lock when within 60m of current cell edge (near another zone)
  const nextPinDistanceM = driverPins?.[0]?.distanceMeters ?? null;
  const isDistanceLocked =
    !liveBetRelaxClient() &&
    (() => {
      if (!viewerBetOfferType) return false;
      if (viewerBetOfferType === "next_turn") {
        return nextPinDistanceM != null && nextPinDistanceM <= 70;
      }
      if (viewerBetOfferType === "next_zone") {
        if (currentMarket?.marketType === "city_grid") return false;
        const last = routePoints[routePoints.length - 1];
        if (!last || !cityGridSpec) return false;
        const edgeM = distanceToCurrentCellEdgeMeters(cityGridSpec, last.lat, last.lng);
        return edgeM != null && edgeM <= 60;
      }
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
  /** Match server/tick: never treat market as lockable until this long after opens_at. */
  const marketOpenGraceElapsed =
    !currentMarket?.opensAt ||
    !Number.isFinite(Date.parse(currentMarket.opensAt)) ||
    nowTick >= Date.parse(currentMarket.opensAt) + MIN_MARKET_OPEN_MS_BEFORE_LOCK;

  const isLocked =
    marketOpenGraceElapsed &&
    (isTimeLocked || isDistanceLocked);

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
      marketOpenGraceElapsed &&
      !liveBetRelaxClient() &&
      !!currentMarket &&
      Number.isFinite(Date.parse(currentMarket.locksAt)) &&
      nowTick >= Date.parse(currentMarket.locksAt);
    const distClosed =
      marketOpenGraceElapsed &&
      !liveBetRelaxClient() &&
      distBet <= LIVE_BET_LOCK_DISTANCE_M;
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

  /**
   * "Has bet on this market" derives purely from local state: the moment
   * placeBet succeeds we stamp `lastBetMarketId`, and a market-change effect
   * clears it. Using the activity-API set caused stale "open bet" rows to
   * keep the popup hidden across markets even after the bet settled.
   */
  const viewerHasBetOnCurrentMarket = Boolean(
    currentMarket && lastBetMarketId === currentMarket.id,
  );
  void myOpenBetMarketIds;

  /**
   * `betPanelDismissed` used to start true for an 800 ms interstitial so the
   * popup "felt fresh", and could be flipped on by the close button. The
   * product rule now is: bet card appears IMMEDIATELY when the market opens
   * and stays for the full 7-second `locks_at` window — no interstitial, no
   * dismiss-then-reappear UX. The flag is kept (always false) so we can
   * reintroduce a dismiss action later without rewiring every consumer.
   */
  const betPanelDismissed = false;
  const lastSeenMarketIdRef = useRef<string | null>(null);
  useEffect(() => {
    lastSeenMarketIdRef.current = currentMarket?.id ?? null;
  }, [currentMarket?.id]);
  useEffect(() => {
    if (displayBetType) setMapFollow(true);
  }, [displayBetType]);

  /**
   * Product rule: every bet stays on screen for at most 7 seconds, or until
   * the viewer commits a bet, whichever comes first. `locks_at` on the
   * market row is exactly `opens_at + 7 s`, so flipping `betWindowClosed`
   * the moment `locks_at` passes hides the popup without waiting for the
   * server to clear `current_market_id`. The bet itself stays bettable on
   * the server only inside the open window — once locked, attempts return
   * "Market has locked", so the UI must match that gate.
   */
  const betWindowClosed = (() => {
    if (!currentMarket) return false;
    const t = Date.parse(currentMarket.locksAt);
    if (!Number.isFinite(t)) return false;
    return nowTick >= t;
  })();
  /**
   * Unified bet card visibility: every active bet type renders through the
   * same `MapSelectionBottomSheet` so the viewer sees the same component,
   * the same countdown, and the same one-touch interaction regardless of
   * whether the round is `next_turn`, `next_zone`, or `zone_exit_time`.
   * The old joystick + grid-map-tap surfaces are gone.
   */
  /**
   * Bet card overlays video or map — do not require `mapExpanded`, or viewers
   * who stay on the camera fullscreen never see a market.
   */
  const showUnifiedBetSheet =
    showLiveBets &&
    currentMarket != null &&
    !viewerHasBetOnCurrentMarket &&
    !betWindowClosed;
  void isLocked;
  void betPanelDismissed;

  const sheetMarketOptions = useMemo<
    Array<{
      id: string;
      label: string;
      shortLabel?: string;
      displayOrder: number;
    }>
  >(() => currentMarket?.options ?? [], [currentMarket]);

  /**
   * For zone_exit_time bets: estimated seconds remaining inside the zone,
   * counting down each second using nowTick.  T is stored in the market
   * subtitle as `estimatedSec` and set at market-open time by the server.
   */
  const zoneTimeRemainingEstSec = useMemo(() => {
    return currentMarket
      ? estimatedZoneSecondsRemaining(currentMarket, nowTick)
      : null;
  }, [currentMarket, nowTick]);

  /**
   * One-touch sheet: tapping an option places the bet immediately. The only
   * remaining "closed" trigger is the 7-second window expiring (already
   * captured by `betWindowClosed`, which also hides the sheet entirely).
   */
  const sheetBettingClosed =
    !currentMarket ||
    (!liveBetRelaxClient() && isLocked);

  const mapBetSheetOpen = showUnifiedBetSheet;

  const viewerCurrentBetHeadline =
    viewerBetOfferType != null ? engineBetHeadline(viewerBetOfferType) : null;

  const sheetBetHeadline = viewerCurrentBetHeadline ?? "Live bet";

  const driverRouteBadges = useMemo(
    () => drivingRouteStyleBadges(room.drivingRouteStyle, room.transportMode),
    [
      room.transportMode,
      room.drivingRouteStyle.comfortVsSpeed,
      room.drivingRouteStyle.pathStyle,
      room.drivingRouteStyle.ecoConscious,
    ],
  );

  /** Reset any selection on market change — viewer must explicitly tap to bet. */
  useEffect(() => {
    if (currentMarket?.marketType === "city_grid") {
      setSelectedMapOptionId(selectedZoneId);
      return;
    }
    setSelectedMapOptionId(null);
  }, [
    currentMarket?.id,
    currentMarket?.marketType,
    selectedZoneId,
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
      // Flush against the BottomNav (h-16 = 64px) and the left edge — no gap.
      const top = Math.max(48, window.innerHeight - boxW - 64);
      setPipPos({ top, left: 0 });
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

  /**
   * The joystick (DirectionalBetPad) and the grid-tap UI were removed in
   * favour of a single unified bet card so every market — `next_turn`,
   * `next_zone`, and `zone_exit_time` — looks and feels identical. The
   * `joyPortalReady` ref is still produced by the layout but no longer
   * gates any input surface.
   */
  void joyPortalReady;

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
        highlightedEngineType={
          displayBetType && displayBetType !== viewerBetOfferType
            ? displayBetType
            : null
        }
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
      {centerMoneyFlash ? (
        <ViewerCenterMoneyFlash
          kind={centerMoneyFlash.kind}
          amount={centerMoneyFlash.amount}
          target={centerMoneyFlash.target ?? null}
        />
      ) : null}
      {balanceWinSplash ? (
        <BalanceWinSplash
          key={balanceWinSplash.nonce}
          from={balanceWinSplash.from}
          to={balanceWinSplash.to}
          gain={balanceWinSplash.gain}
          onDone={() => setBalanceWinSplash(null)}
        />
      ) : null}

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
            currentZoneId={currentZoneId}
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
            viewerZoomRuleKey={`${mapBetTypeForCamera ?? "none"}:${currentMarket?.id ?? "nomarket"}`}
            onZoneSelect={(id) => {
              /**
               * For a live `city_grid` (`next_zone`) market, tapping a cell
               * IS the bet — fire `placeBet` immediately if a bet hasn't
               * already been placed. Outside of `next_zone` we just keep
               * the selection so the map can highlight it.
               */
              setSelectedZoneId(id);
              if (id) setSelectedCheckpointId(null);
              if (
                id &&
                currentMarket?.marketType === "city_grid" &&
                !sheetBettingClosed &&
                !placingOptionId &&
                !viewerHasBetOnCurrentMarket
              ) {
                void placeBet(id).then((result) => {
                  if (result?.ok) {
                    setSelectedZoneId(null);
                    setMapSheetError(null);
                  }
                });
              }
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
        className="absolute z-30 overflow-hidden border-y border-l border-white/15 shadow-2xl"
        style={{
          top: pipPos.top,
          left: pipPos.left,
          width: "34vw",
          height: "34vw",
          maxWidth: 180,
          maxHeight: 180,
          opacity: 0.95,
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
              currentZoneId={currentZoneId}
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
              viewerZoomRuleKey={`${mapBetTypeForCamera ?? "none"}:${currentMarket?.id ?? "nomarket"}`}
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

      {showUnifiedBetSheet ? (
        <MapSelectionBottomSheet
          betHeadline={
            currentMarket.title ??
            viewerCurrentBetHeadline ??
            sheetBetHeadline
          }
          selectionDetail={
            currentMarket.marketType === "city_grid"
              ? selectedZone
                ? `Selected · ${selectedZone.name}`
                : "Tap a square on the map"
              : null
          }
          marketOptions={sheetMarketOptions}
          selectedOptionId={selectedMapOptionId}
          onSelectOption={(id) => {
            /**
             * Non-grid markets: tapping any option commits the bet
             * immediately. `city_grid` selection happens via the map
             * (`onZoneSelect` above) and ignores this path.
             */
            setSelectedMapOptionId(id);
            if (currentMarket.marketType === "city_grid") return;
            if (
              sheetBettingClosed ||
              placingOptionId ||
              viewerHasBetOnCurrentMarket
            ) {
              viewerLiveLog("place_bet_skipped", {
                optionId: id,
                sheetBettingClosed,
                placingOptionId: !!placingOptionId,
                viewerHasBetOnCurrentMarket,
              });
              return;
            }
            void placeBet(id).then((result) => {
              if (result?.ok) {
                setSelectedZoneId(null);
                setSelectedCheckpointId(null);
                setMapSheetError(null);
              }
            });
          }}
          bettingClosed={sheetBettingClosed}
          isPlacing={!!placingOptionId}
          error={mapSheetError}
          countdown={
            currentMarket ? <MarketTimer locksAt={currentMarket.locksAt} /> : null
          }
          onClose={() => {
            setSelectedZoneId(null);
            setSelectedCheckpointId(null);
            setMapSheetError(null);
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
          gridMode={currentMarket.marketType === "city_grid"}
          turnMode={currentMarket.marketType === "next_turn"}
          zoneTimeRemainingEstSec={zoneTimeRemainingEstSec}
          oneTapOptionBet={currentMarket.marketType !== "city_grid"}
        />
      ) : null}
    </div>
  );
}

function fmtUsdFlash(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

function playMoneySound(muted: boolean) {
  if (muted || typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.11, ctx.currentTime + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.42);
    master.connect(ctx.destination);

    [880, 1175, 1568].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.075;
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.75, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.18);
    });

    window.setTimeout(() => void ctx.close().catch(() => undefined), 700);
  } catch {
    // Sound is non-critical; browsers may block audio until the first gesture.
  }
}

/** Full-screen center money cue: stake (white), win (green +payout), loss (red -stake). */
function ViewerCenterMoneyFlash({
  kind,
  amount,
  target,
}: {
  kind: "stake" | "win" | "loss";
  amount: number;
  target: string | null;
}) {
  const abs = Math.abs(amount);
  const s = fmtUsdFlash(abs);
  /** Stake → "$2 on 0–1 stops"; settle → "+$24" / "-$2" (target shown below). */
  const main =
    kind === "stake"
      ? target
        ? `$${s} on ${target}`
        : `$${s}`
      : kind === "win"
        ? `+$${s}`
        : `-$${s}`;
  const colorClass =
    kind === "win"
      ? "text-emerald-400"
      : kind === "loss"
        ? "text-rose-400"
        : "text-white";

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[245] flex flex-col items-center justify-center gap-1"
      aria-live="polite"
    >
      <div
        className={`text-5xl font-black tabular-nums tracking-tight [text-shadow:0_0_28px_rgba(0,0,0,0.92)] sm:text-6xl ${colorClass}`}
      >
        {main}
      </div>
      {kind !== "stake" && target ? (
        <div className="text-xs font-semibold text-white/85 [text-shadow:0_0_8px_rgba(0,0,0,0.92)] sm:text-sm">
          on {target}
        </div>
      ) : null}
    </div>
  );
}

function BalanceWinSplash({
  from,
  to,
  gain,
  onDone,
}: {
  from: number;
  to: number;
  gain: number;
  onDone: () => void;
}) {
  const [display, setDisplay] = useState(from);

  useEffect(() => {
    const duration = 1250;
    const started = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        setDisplay(to);
        window.setTimeout(onDone, 700);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [from, onDone, to]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[246] flex items-center justify-center">
      <div className="relative flex flex-col items-center rounded-3xl border border-emerald-300/35 bg-black/55 px-7 py-5 text-center shadow-[0_0_42px_rgba(16,185,129,0.55)] backdrop-blur-md">
        <div className="absolute inset-[-18px] rounded-[2rem] border border-emerald-300/30 opacity-70 animate-ping" />
        {["$", "$", "$", "$", "$", "$"].map((coin, i) => (
          <span
            key={i}
            className="absolute text-lg font-black text-emerald-200/80 [text-shadow:0_0_10px_rgba(16,185,129,0.95)]"
            style={{
              left: `${10 + i * 16}%`,
              top: `${i % 2 === 0 ? -16 : 96}%`,
              animation: `money-splash-${i % 3} 1050ms ease-out forwards`,
            }}
          >
            {coin}
          </span>
        ))}
        <div className="text-[10px] font-black uppercase tracking-[0.28em] text-emerald-200/80">
          Balance
        </div>
        <div className="mt-1 text-4xl font-black tabular-nums text-emerald-300 [text-shadow:0_0_24px_rgba(16,185,129,0.9)]">
          ${fmtUsdFlash(display)}
        </div>
        <div className="mt-1 rounded-full bg-emerald-400/20 px-3 py-1 text-sm font-black text-emerald-100">
          +${fmtUsdFlash(gain)}
        </div>
      </div>
      <style jsx>{`
        @keyframes money-splash-0 {
          from { transform: translate3d(0, 0, 0) scale(0.5) rotate(0deg); opacity: 0; }
          18% { opacity: 1; }
          to { transform: translate3d(-26px, -48px, 0) scale(1.25) rotate(-18deg); opacity: 0; }
        }
        @keyframes money-splash-1 {
          from { transform: translate3d(0, 0, 0) scale(0.5) rotate(0deg); opacity: 0; }
          18% { opacity: 1; }
          to { transform: translate3d(18px, -54px, 0) scale(1.18) rotate(22deg); opacity: 0; }
        }
        @keyframes money-splash-2 {
          from { transform: translate3d(0, 0, 0) scale(0.5) rotate(0deg); opacity: 0; }
          18% { opacity: 1; }
          to { transform: translate3d(34px, 38px, 0) scale(1.2) rotate(15deg); opacity: 0; }
        }
      `}</style>
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

function estimatedZoneSecondsRemaining(
  market: NonNullable<LiveFeedRow["currentMarket"]>,
  nowMs: number,
): number | null {
  if (market.marketType !== "zone_exit_time") return null;
  const T = market.meta?.estimatedSec;
  if (typeof T !== "number") return null;
  const opensAtMs = Date.parse(market.opensAt);
  if (!Number.isFinite(opensAtMs)) return T;
  return Math.max(0, T - Math.floor((nowMs - opensAtMs) / 1000));
}

function zoneTimeOptionLabel(optionId: string, remainingSec: number | null): string | null {
  if (remainingSec == null) return null;
  if (optionId === "exit_under") return `< ${remainingSec} sec`;
  if (optionId === "exit_at") return `= ${remainingSec} sec`;
  if (optionId === "exit_over") return `> ${remainingSec} sec`;
  return null;
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
  turnMode = false,
  zoneTimeRemainingEstSec = null,
  oneTapOptionBet = false,
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
  turnMode?: boolean;
  /** When non-null, renders a 3-column < / ≈ / > layout with live countdown labels. */
  zoneTimeRemainingEstSec?: number | null;
  oneTapOptionBet?: boolean;
}) {
  const sorted = [...marketOptions].sort((a, b) => a.displayOrder - b.displayOrder);
  const zoneTimeMode = zoneTimeRemainingEstSec != null;
  const zoneTimeOptions = zoneTimeMode
    ? (["exit_under", "exit_at", "exit_over"] as const)
        .map((id) => sorted.find((o) => o.id === id) ?? { id, label: id, displayOrder: 0 })
    : [];
  const turnOptions = turnMode
    ? ["left", "straight", "right"]
        .map((id) => sorted.find((o) => o.id === id))
        .filter((o): o is NonNullable<typeof o> => o != null)
    : [];
  return (
    <div
      className="pointer-events-none fixed bottom-0 right-0 z-[200] pb-16"
      style={{
        // Use full remaining screen width to the right of the PiP square —
        // no horizontal margins. pb-16 = BottomNav h-16, so no bottom gap.
        left: "min(34vw, 180px)",
        paddingRight: "0px",
      }}
    >
      <div
        className="pointer-events-auto flex h-full flex-col border-y border-r border-white/10 bg-black/40 p-2 text-white shadow-lg backdrop-blur-md"
        /** Match the PiP square (left): width:34vw capped at 180px → height the same. */
        style={{
          height: "min(34vw, 180px)",
          minHeight: "min(34vw, 180px)",
        }}
      >
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
        {gridMode ? null : zoneTimeMode ? (
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-1">
            {zoneTimeOptions.map((opt) => {
              const active = selectedOptionId === opt.id;
              const label =
                zoneTimeOptionLabel(opt.id, zoneTimeRemainingEstSec) ??
                (opt.shortLabel ?? opt.label);
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => void onSelectOption(opt.id)}
                  className={`flex h-full items-center justify-center rounded-lg px-1 text-center text-[11px] font-semibold ${
                    active
                      ? "bg-white text-black"
                      : bettingClosed
                        ? "bg-white/5 text-white/30"
                        : "bg-white/15 text-white"
                  }`}
                  disabled={bettingClosed || isPlacing}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : turnMode ? (
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-1">
            {turnOptions.map((opt) => {
              const active = selectedOptionId === opt.id;
              const arrow =
                opt.id === "left"
                  ? "←"
                  : opt.id === "right"
                    ? "→"
                    : "↑";
              const label =
                opt.id === "left"
                  ? "Left"
                  : opt.id === "right"
                    ? "Right"
                    : "Straight";
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => void onSelectOption(opt.id)}
                  className={`flex h-full flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-center font-semibold ${
                    active
                      ? "border border-violet-400/55 bg-violet-500/20 text-white"
                      : "border border-transparent bg-white/5 text-white/85"
                  }`}
                >
                  <span className="text-base leading-none">{arrow}</span>
                  <span className="text-[9px] leading-none">{label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {sorted.map((opt) => {
              const active = selectedOptionId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => void onSelectOption(opt.id)}
                  className={`block w-full rounded-lg px-2 py-1 text-left text-[10px] ${
                    active
                      ? "border border-violet-400/55 bg-violet-500/20 text-white"
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
        {oneTapOptionBet ? null : (
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
        )}
      </div>
    </div>
  );
}
