"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  type CityGridSpecCompact,
  cellIdForPosition,
  cellLabel,
  distanceToCurrentCellEdgeMeters,
  enumerateGridCells,
  gridCellCenter,
  neighborCellIds,
  parseGridOptionId,
} from "@/lib/live/grid/cityGrid500";
import { drivingRouteStyleBadges } from "@/lib/live/routing/drivingRouteStyle";
import { fetchNearbyLandmark, type NearbyLandmark } from "@/lib/live/routing/wikipediaLandmark";
import { NEXT_TURN_BETS_ENABLED } from "@/lib/live/featureFlags";
import dynamic from "next/dynamic";
import type { LiveFeedRow, LiveMarketSlot, RoutePoint } from "@/actions/live-feed";
import {
  LIVE_BET_LOCK_DISTANCE_M,
  NEXT_TURN_BET_LOCK_DISTANCE_M,
} from "@/lib/live/liveBetLockDistance";
import {
  MIN_MARKET_OPEN_MS_BEFORE_LOCK,
  VIEWER_BET_MIN_DISPLAY_MS,
} from "@/lib/live/liveBetMinOpenMs";
import { liveBetRelaxClient } from "@/lib/live/liveBetRelax";
import { viewerLiveLog, viewerLiveWarn } from "@/lib/live/viewerLiveConsole";
import { metersBetween } from "@/lib/live/routing/geometry";
import { isDriverOffGoogleDestinationRoute } from "@/lib/live/routing/destinationRouteDisplay";
import {
  buildRouteToPinPolyline,
  isDriverOffRouteToPin,
  type CompactLatLng,
} from "@/lib/live/routing/nextStepRoutePath";
import {
  BET_OPEN_WINDOW_MS,
  NEXT_TURN_PIN_MAX_M,
  NEXT_TURN_PIN_MIN_M,
} from "@/lib/live/betting/betWindowConstants";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import {
  VideoStreamOverlay,
  resolveVideoOverlayPin,
} from "./VideoStreamOverlay";
import { LiveDecisionStatusRibbon } from "./LiveDecisionStatusRibbon";
import { useCountdown } from "./useCountdown";
import { LiveEventToasts } from "./LiveEventToasts";
import type { SkillFeedbackData } from "./SkillFeedbackCard";
import { ReplaySheet } from "./ReplaySheet";
import { LiveViewerStakePicker } from "./LiveViewerStakePicker";
import { TopBar } from "@/components/layout/top-bar";
import { useActiveBetRound } from "@/hooks/useActiveBetRound";
import { engineBetHeadline } from "@/lib/live/betting/betTypeV2Label";
import {
  IconRailButton,
  IconLayers,
  IconSparkle,
  IconCoin,
  IconZoomScale,
} from "./OwnerLiveControlPanel";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";
import type { BetTypeV2 } from "@bettok/live";
import { isEngineMarketType } from "@/lib/live/betting/engineMarketOptions";
import { useUserStore } from "@/stores/user-store";
import { getWallet } from "@/actions/wallet";
import { walletLiveBalance } from "@/lib/live/walletBalance";
import type { TrafficCamera } from "@/app/api/live/traffic-cameras/route";
import { TrafficCameraPanel } from "./TrafficCameraPanel";
import { StraightStreakTracker } from "./StraightStreakTracker";
import { isTwoWheeled, mapZoomLevelOffset, zoomWidthForLevelOffset } from "./LiveMap";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), {
  ssr: false,
});

/** Dev-only YouTube stand-in; production always uses WebRTC LiveVideoPlayer. */
const YOUTUBE_DASHCAM_DEV_ONLY = process.env.NODE_ENV === "development";
const DASHCAM_YOUTUBE_EMBED =
  "https://www.youtube.com/embed/8G1MiDfIDig?start=7&autoplay=1&mute=1&controls=0&loop=1&playlist=8G1MiDfIDig&modestbranding=1&rel=0";

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

type BetFeedSlot = "unified" | "step";

type BetFeedEntry = {
  marketId: string;
  slot: BetFeedSlot;
  shownAtMs: number;
  market: LiveMarketSlot;
  /** Fixed vertical slot — 0 = bottom anchor; never renumbered when siblings leave. */
  stackSlot: number;
  betPlaced?: boolean;
};

function snapshotBetFeedMarket(market: LiveMarketSlot): LiveMarketSlot {
  return {
    ...market,
    options: market.options.map((o) => ({ ...o })),
    meta: market.meta ? { ...market.meta } : null,
  };
}

function isBetFeedMarketLocked(market: LiveMarketSlot, nowMs: number): boolean {
  const locksMs = Date.parse(market.locksAt);
  return Number.isFinite(locksMs) && nowMs >= locksMs;
}

/** Estimated popup height for stack layout (px). */
const BET_FEED_EST_CARD_PX = 62;

function betFeedStackInsetPx(stackSlot: number): number {
  return Math.min(stackSlot, 3) * 5;
}

function nextFreeBetFeedStackSlot(entries: BetFeedEntry[]): number {
  const used = new Set(entries.map((e) => e.stackSlot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const pathname = usePathname();
  const router = useRouter();
  const immersiveLiveRoom = (pathname ?? "").startsWith("/live/rooms/");

  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(
    initialRoom.routePoints ?? [],
  );
  const routePointsRef = useRef(routePoints);
  routePointsRef.current = routePoints;
  const lastStakeAmount = useViewerChromeStore((s) => s.lastStakeAmount);
  const isMuted = useViewerChromeStore((s) => s.isMuted);
  const wallet = useUserStore((s) => s.wallet);
  const walletLoading = useUserStore((s) => s.isLoading);
  const setWallet = useUserStore((s) => s.setWallet);
  const liveBalance = walletLiveBalance(wallet);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Error shown inside the active bet sheet.  Stored as `{ marketId, message }`
   * so it is automatically invisible when a new market opens — no manual clear
   * needed, no stale "Too close to turn" bleed-through on the next sheet.
   *
   * Use the `mapSheetError` / `setMapSheetError` pair declared later in this
   * component (after `currentMarket` is available) — they are derived from
   * this raw state and safely scoped to the active market.
   */
  const [mapSheetErrorState, setMapSheetErrorState] = useState<{
    marketId: string;
    message: string;
  } | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  /** Big center readout: stake committed, then win (green +) or loss (red -). */
  const [centerMoneyFlash, setCenterMoneyFlash] = useState<{
    kind: "stake" | "win" | "loss";
    amount: number;
    /** Optional descriptor, e.g. "0–1 stops"; rendered as `$2 on 0–1 stops`. */
    target?: string | null;
  } | null>(null);
  const [balanceChangeSplash, setBalanceChangeSplash] = useState<{
    from: number;
    to: number;
    delta: number;
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
  /** Dev-only: sparkle toggles YouTube vs WebRTC. Production always shows live WebRTC. */
  const [useYoutubeDashcam, setUseYoutubeDashcam] = useState(false);
  const showYoutubeDashcam = YOUTUBE_DASHCAM_DEV_ONLY && useYoutubeDashcam;
  const toggleYoutubeDashcam = useCallback(() => {
    if (!YOUTUBE_DASHCAM_DEV_ONLY) return;
    setUseYoutubeDashcam((on) => !on);
  }, []);
  // Drop stale toggle from when YouTube replaced the live feed in production builds.
  useEffect(() => {
    if (YOUTUBE_DASHCAM_DEV_ONLY) return;
    try {
      localStorage.removeItem("camtok_youtube_dashcam");
    } catch {
      /* ignore */
    }
  }, []);
  const [mapFollow, setMapFollow] = useState(true);
  const mapFollowRestoreRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMapUserInteract = useCallback(() => {
    setMapFollow(false);
    if (mapFollowRestoreRef.current) clearTimeout(mapFollowRestoreRef.current);
    mapFollowRestoreRef.current = setTimeout(() => {
      setMapFollow(true);
      mapFollowRestoreRef.current = null;
    }, 5000);
  }, []);
  const handleMapPerfDegrade = useCallback(() => {
    setMapPerfDegraded(true);
    setTrafficCameras([]);
  }, []);

  const ZOOM_SCALES = [1, 0.7, 1.2] as const;
  const [zoomScaleIdx, setZoomScaleIdx] = useState(0);
  const zoomScale = ZOOM_SCALES[zoomScaleIdx]!;
  const [mapPerfDegraded, setMapPerfDegraded] = useState(false);
  const [layoutViewportW, setLayoutViewportW] = useState(390);
  useEffect(() => {
    const sync = () => setLayoutViewportW(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);
  const isMobileViewport = layoutViewportW < 768;
  const pipSizePx = Math.min(Math.round(layoutViewportW * 0.34), 180);
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
  const [destinationRouteTraffic, setDestinationRouteTraffic] = useState<
    Array<{ startIndex: number; endIndex: number; speed: "NORMAL" | "SLOW" | "TRAFFIC_JAM" }> | null
  >(null);
  /** Hide stale Google path after a turn until a fresh route is refetched. */
  const [googleRouteHidden, setGoogleRouteHidden] = useState(false);
  const googleRouteHiddenRef = useRef(false);
  const offRouteRefetchAtRef = useRef(0);
  const fetchDestRouteRef = useRef<(offRoute?: boolean) => Promise<void>>(
    async () => {},
  );
  const mapDestinationRoute = useMemo(() => {
    if (googleRouteHidden || !destinationRoute || destinationRoute.length < 2) {
      return null;
    }
    return destinationRoute;
  }, [googleRouteHidden, destinationRoute]);
  const mapDestinationTraffic = useMemo(() => {
    if (!mapDestinationRoute) return null;
    return destinationRouteTraffic;
  }, [mapDestinationRoute, destinationRouteTraffic]);
  const [destinationEtaSec, setDestinationEtaSec] = useState<number | null>(null);
  const [destinationDistanceM, setDestinationDistanceM] = useState<number | null>(null);
  const [trafficCameras, setTrafficCameras] = useState<TrafficCamera[]>([]);

  // Pick the first camera ahead on the Google Maps route polyline.
  // Projects each camera onto the route, keeps only those within 400 m of it,
  // and returns whichever has the smallest route-distance from the driver.
  // Falls back to API-flagged isNearest when no route is available.
  const nearestCamera = useMemo(() => {
    if (trafficCameras.length === 0) return null;
    const route = destinationRoute;
    // No route yet — fall back to the API-flagged nearest camera so the
    // panel and map pin appear immediately (before Google Maps route loads).
    if (!route || route.length < 2) {
      return trafficCameras.find((c) => c.isNearest) ?? null;
    }
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const hav = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const dLat = rad(b.lat - a.lat);
      const dLng = rad(b.lng - a.lng);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    };
    let bestCam: TrafficCamera | null = null;
    let bestRouteDist = Infinity;
    for (const cam of trafficCameras) {
      let minOff = Infinity;
      let routeDistAtClosest = 0;
      let accDist = 0;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!;
        const b = route[i]!;
        const segLen = hav(a, b);

        // Correct for longitude compression at this latitude so the
        // perpendicular projection is accurate in metric space.
        const cosLat = Math.cos(rad((a.lat + b.lat) / 2));
        const dxM = (b.lng - a.lng) * cosLat;
        const dyM = b.lat - a.lat;
        const len2M = dxM * dxM + dyM * dyM;
        const camDxM = (cam.lng - a.lng) * cosLat;
        const camDyM = cam.lat - a.lat;
        const t = len2M > 0
          ? Math.max(0, Math.min(1, (camDxM * dxM + camDyM * dyM) / len2M))
          : 0;
        const proj = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
        const off = hav(cam, proj);
        if (off < minOff) {
          minOff = off;
          routeDistAtClosest = accDist + t * segLen;
        }
        accDist += segLen;
      }
      // Camera must be within 50 m of the route polyline (same road, not a
      // parallel street) AND within the next 400 m of route distance ahead.
      if (
        minOff < 50 &&
        routeDistAtClosest > 0 &&
        routeDistAtClosest < 400 &&
        routeDistAtClosest < bestRouteDist
      ) {
        bestRouteDist = routeDistAtClosest;
        bestCam = cam;
      }
    }
    return bestCam;
  }, [trafficCameras, destinationRoute]);
  // nowTick removed — each consumer owns its own clock via useDeadlinePassed / local state.
  const [myOpenBetMarketIds, setMyOpenBetMarketIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setMyOpenBetMarketIds(new Set());
    setZoneExitPending(null);
    setNextStepPending(null);
  }, [room.roomId]);

  // Keep the screen awake for the entire live session (viewer + driver room).
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let active = true;
    let sentinel: WakeLockSentinel | null = null;
    const acquire = () => {
      if (!active || document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then((s) => {
        if (!active) { void s.release(); return; }
        sentinel = s;
        s.addEventListener("release", () => { sentinel = null; });
      }).catch(() => {/* unsupported or denied — ignore */});
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acquire);
      if (sentinel) { void sentinel.release(); sentinel = null; }
    };
  }, []);
  const [lastBetMarketId, setLastBetMarketId] = useState<string | null>(null);
  const [lastBetOptionLabel, setLastBetOptionLabel] = useState<string | null>(null);
  // Set immediately on bet press — hides the popup before the server even responds.
  const [betJustPlaced, setBetJustPlaced] = useState(false);
  const betJustPlacedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "✓ Bet placed" confirmation chip shown for 2.5 s after a confirmed bet.
  const [betAcceptedLabel, setBetAcceptedLabel] = useState<string | null>(null);
  const betAcceptedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Settling chip deadline — set when a bet is confirmed and persists even
   * if currentMarket goes null briefly between settlement and the next market.
   * Cleared only when lastBetMarketId changes (new market / rollback).
   */
  const [settlingDeadlineMs, setSettlingDeadlineMs] = useState<number | null>(null);
  const [settlingMarketType, setSettlingMarketType] = useState<string | null>(null);
  // Show the pressed button for 1 s, then close the sheet.
  const scheduleBetClose = useCallback(() => {
    if (betJustPlacedTimerRef.current) clearTimeout(betJustPlacedTimerRef.current);
    betJustPlacedTimerRef.current = setTimeout(() => {
      setBetJustPlaced(true);
      betJustPlacedTimerRef.current = null;
    }, 1000);
  }, []);
  /** Active zone_exit_time bet waiting for countdown / zone exit / settlement. */
  const [zoneExitPending, setZoneExitPending] = useState<{
    marketId: string;
    opensAtMs: number;
    estimatedSec: number;
    startCellKey: string;
  } | null>(null);
  /** Market IDs whose countdown already finished — prevents sync effect from restoring them. */
  const zoneExitDismissedRef = useRef<Set<string>>(new Set());
  /** Active next_step bet showing the time-to-pin countdown. */
  const [nextStepPending, setNextStepPending] = useState<{
    marketId: string;
    betPlacedAtMs: number;
    remainingAtBetSec: number;
    stepLat?: number;
    stepLng?: number;
    routeToPin?: CompactLatLng[];
  } | null>(null);
  const nextStepDismissedRef = useRef<Set<string>>(new Set());
  /** Tracks the last market a step bet was placed on (mirrors lastBetMarketId for step slot). */
  const [lastBetStepMarketId, setLastBetStepMarketId] = useState<string | null>(null);
  const [stepBetJustPlaced, setStepBetJustPlaced] = useState(false);
  const stepBetJustPlacedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stepPlacingOptionId, setStepPlacingOptionId] = useState<string | null>(null);
  /** Active next_zone (city_grid) bet — tracks start cell to detect border crossing. */
  const [cityGridBetPending, setCityGridBetPending] = useState<{
    marketId: string;
    startCellKey: string;
  } | null>(null);
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
  const [betFeedEntries, setBetFeedEntries] = useState<BetFeedEntry[]>([]);
  const betFeedDismissedRef = useRef<Set<string>>(new Set());
  const dismissBetFeedEntry = useCallback((marketId: string) => {
    betFeedDismissedRef.current.add(marketId);
    setBetFeedEntries((prev) => prev.filter((e) => e.marketId !== marketId));
  }, []);
  const markBetFeedPlaced = useCallback((marketId: string) => {
    setBetFeedEntries((prev) =>
      prev.map((e) =>
        e.marketId === marketId ? { ...e, betPlaced: true } : e,
      ),
    );
  }, []);
  const restoreBetFeedEntry = useCallback(
    (market: LiveMarketSlot, slot: BetFeedSlot) => {
      if (isBetFeedMarketLocked(market, Date.now())) return;
      betFeedDismissedRef.current.delete(market.id);
      setBetFeedEntries((prev) => {
        if (prev.some((e) => e.marketId === market.id)) {
          return prev.map((e) =>
            e.marketId === market.id
              ? { ...e, betPlaced: false, market: snapshotBetFeedMarket(market) }
              : e,
          );
        }
        return [
          ...prev,
          {
            marketId: market.id,
            slot,
            shownAtMs: Date.now(),
            market: snapshotBetFeedMarket(market),
            stackSlot: nextFreeBetFeedStackSlot(prev),
            betPlaced: false,
          },
        ];
      });
    },
    [],
  );
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
  const syncWalletFromServer = useCallback(async () => {
    const fresh = await getWallet();
    if (fresh) setWallet(fresh as Parameters<typeof setWallet>[0]);
  }, [setWallet]);

  const pulseBalanceChange = useCallback(
    (delta: number) => {
      if (!Number.isFinite(delta) || delta === 0) return;
      const from = walletLiveBalance(wallet);
      const to = from + delta;

      setBalanceChangeSplash({
        from,
        to,
        delta,
        nonce: Date.now(),
      });
      if (delta > 0) playMoneySound(isMuted);

      if (wallet) {
        setWallet({
          ...wallet,
          balance_demo: to,
          balance: to,
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
  // Step market runs independently in its own slot — can be non-null even
  // while currentMarket (zone/turn) is also running.
  const currentStepMarket = room.currentStepMarket ?? null;

  // ── Market-scoped bet-sheet error ─────────────────────────────────────────
  // `mapSheetError` is the error message visible in the current bet sheet.
  // It is null whenever the active market differs from the one that produced
  // the error — no useEffect, no explicit clear on market change needed.
  const mapSheetError =
    mapSheetErrorState != null &&
    mapSheetErrorState.marketId === currentMarket?.id
      ? mapSheetErrorState.message
      : null;
  const setMapSheetError = useCallback(
    (message: string | null) => {
      if (!message) {
        setMapSheetErrorState(null);
        return;
      }
      setMapSheetErrorState(
        currentMarket?.id ? { marketId: currentMarket.id, message } : null,
      );
    },
    [currentMarket?.id],
  );

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

  const currentZoneCellKey = useMemo(() => {
    if (!currentZoneId) return null;
    // currentZoneId is "grid:r{row}:c{col}"; server stores startCellKey as "cell:r{row}:c{col}".
    // Parse the row/col and rebuild with the "cell:" prefix to match the server format.
    const p = parseGridOptionId(currentZoneId);
    if (!p) return null;
    return `cell:r${p.row}:c${p.col}`;
  }, [currentZoneId]);

  // Deadline-based: fires a single setTimeout at the exact moment instead of polling.
  const zoneExitDeadlineMs = zoneExitPending
    ? zoneExitPending.opensAtMs + Math.round(zoneExitPending.estimatedSec) * 1000
    : null;
  const zoneExitCountdownElapsed = useDeadlinePassed(zoneExitDeadlineMs);

  const zoneExitLeftZone = Boolean(
    zoneExitPending &&
      currentZoneCellKey &&
      currentZoneCellKey !== zoneExitPending.startCellKey,
  );

  // Show spinner when the bet outcome is imminent:
  //   1. Local countdown timer has elapsed (estimated T has passed).
  //   2. Driver has left the start cell (zone exit detected client-side).
  // Do NOT show spinner just because the BET WINDOW locked (market_locked
  // phase at t=8 s) — the driver is still inside the zone counting down.
  // Do NOT clear the widget on any of these — only handleSettlement or the
  // 45 s safety valve may clear it.
  const zoneExitResolving = Boolean(
    zoneExitPending && (zoneExitCountdownElapsed || zoneExitLeftZone),
  );

  // ── next_step (time-to-pin) countdown ──────────────────────────────────────
  const nextStepDeadlineMs = nextStepPending
    ? nextStepPending.betPlacedAtMs + Math.round(nextStepPending.remainingAtBetSec) * 1000
    : null;
  const nextStepCountdownElapsed = useDeadlinePassed(nextStepDeadlineMs);
  const nextStepResolving = Boolean(nextStepPending && nextStepCountdownElapsed);

  // Client-side pin proximity: fire urgent polling as soon as the driver is
  // within 80 m of the step pin, even before the countdown expires.
  // This mirrors the server's approach radius and ensures the 450 ms poll
  // loop starts at the same moment the server is likely to settle.
  const driverLastPos =
    routePoints.length > 0 ? routePoints[routePoints.length - 1]! : null;

  const nextStepRouteToPin = useMemo((): CompactLatLng[] | null => {
    const fromMeta = routeToPinFromMeta(currentStepMarket?.meta ?? null);
    if (fromMeta) return fromMeta;
    if (nextStepPending?.routeToPin && nextStepPending.routeToPin.length >= 2) {
      return nextStepPending.routeToPin;
    }
    if (
      destinationRoute &&
      destinationRoute.length >= 2 &&
      driverLastPos &&
      currentStepMarket?.turnPointLat != null &&
      currentStepMarket.turnPointLng != null
    ) {
      return buildRouteToPinPolyline(destinationRoute, driverLastPos, {
        lat: currentStepMarket.turnPointLat,
        lng: currentStepMarket.turnPointLng,
      });
    }
    return null;
  }, [
    currentStepMarket?.meta,
    currentStepMarket?.turnPointLat,
    currentStepMarket?.turnPointLng,
    nextStepPending?.routeToPin,
    destinationRoute,
    driverLastPos,
  ]);

  const nextStepOffRoute = useMemo(() => {
    if (!driverLastPos || !nextStepRouteToPin) return false;
    const pinLat =
      currentStepMarket?.turnPointLat ??
      nextStepPending?.stepLat ??
      null;
    const pinLng =
      currentStepMarket?.turnPointLng ??
      nextStepPending?.stepLng ??
      null;
    const pin =
      pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null;
    return isDriverOffRouteToPin(driverLastPos, nextStepRouteToPin, pin);
  }, [
    driverLastPos,
    nextStepRouteToPin,
    currentStepMarket?.turnPointLat,
    currentStepMarket?.turnPointLng,
    nextStepPending?.stepLat,
    nextStepPending?.stepLng,
  ]);

  useEffect(() => {
    if (!nextStepOffRoute) return;
    const marketId = currentStepMarket?.id ?? nextStepPending?.marketId;
    if (!marketId) return;
    nextStepDismissedRef.current.add(marketId);
    setNextStepPending(null);
    dismissBetFeedEntry(marketId);
    void syncWalletFromServer();
  }, [nextStepOffRoute, currentStepMarket?.id, nextStepPending?.marketId, dismissBetFeedEntry, syncWalletFromServer]);

  const stepPinNearby = Boolean(
    nextStepPending &&
      nextStepPending.stepLat != null &&
      nextStepPending.stepLng != null &&
      driverLastPos != null &&
      metersBetween(driverLastPos, {
        lat: nextStepPending.stepLat!,
        lng: nextStepPending.stepLng!,
      }) < 80,
  );

  /** True once the vehicle has left the start cell for a next_zone bet. */
  const cityGridBetCrossed = Boolean(
    cityGridBetPending &&
      currentZoneCellKey &&
      currentZoneCellKey !== cityGridBetPending.startCellKey,
  );

  // Urgent polling: start fast 450 ms activity polls as soon as the driver
  // exits the zone / approaches the pin (even before the countdown elapses)
  // so the settlement result is delivered immediately rather than waiting up to 3 s.
  const urgentSettlementMarketId =
    zoneExitResolving || zoneExitLeftZone
      ? zoneExitPending!.marketId
      : nextStepResolving || stepPinNearby
        ? nextStepPending!.marketId
        : cityGridBetCrossed
          ? cityGridBetPending!.marketId
          : null;

  // Countdown stays visible until the server confirms settlement via handleSettlement.
  // zoneExitResolving only switches the widget to a spinner — it never clears it.

  // Safety valve for zone countdown: if the spinner has been showing for > 45 s
  // with no server response, force a wallet sync and clear so the UI never hangs.
  useEffect(() => {
    if (!zoneExitResolving || !zoneExitPending) return;
    const t = setTimeout(() => {
      setZoneExitPending((prev) => {
        if (!prev) return prev;
        zoneExitDismissedRef.current.add(prev.marketId);
        return null;
      });
      void syncWalletFromServer();
    }, 45_000);
    return () => clearTimeout(t);
  }, [zoneExitResolving, zoneExitPending, syncWalletFromServer]);

  // Safety valve for pin countdown: same 45 s cap.
  useEffect(() => {
    if (!nextStepResolving || !nextStepPending) return;
    const t = setTimeout(() => {
      setNextStepPending((prev) => {
        if (!prev) return prev;
        nextStepDismissedRef.current.add(prev.marketId);
        return null;
      });
      void syncWalletFromServer();
    }, 45_000);
    return () => clearTimeout(t);
  }, [nextStepResolving, nextStepPending, syncWalletFromServer]);

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
      setZoneExitPending((prev) => {
        if (prev?.marketId === data.marketId) {
          zoneExitDismissedRef.current.add(data.marketId);
          return null;
        }
        return prev;
      });
      setNextStepPending((prev) => {
        if (prev?.marketId === data.marketId) {
          nextStepDismissedRef.current.add(data.marketId);
          return null;
        }
        return prev;
      });
      setCityGridBetPending((prev) =>
        prev?.marketId === data.marketId ? null : prev,
      );
      if (data.won) {
        // Net profit = payout − stake (stake was already removed from DB at
        // bet placement).  Animating the raw payout would overshoot if the
        // UI hasn't yet synced the stake deduction.
        const netProfit = data.payoutAmount - data.stakeAmount;
        pulseCenterMoney("win", data.payoutAmount, targetLabel);
        if (netProfit > 0) pulseBalanceChange(netProfit);
      } else if (data.payoutAmount > 0) {
        // Refund: stake returned — show a neutral "stake" flash so the
        // countdown doesn't disappear completely silently.  Balance will be
        // corrected by the syncWalletFromServer call below.
        pulseCenterMoney("stake", data.stakeAmount, "↩ refunded");
      } else {
        // Loss: stake was removed server-side at bet time; deduct from UI now
        // so the badge doesn't wait for the next syncWalletFromServer.
        pulseCenterMoney("loss", data.stakeAmount, targetLabel);
        pulseBalanceChange(-data.stakeAmount);
      }
      void syncWalletFromServer();
    },
    [pulseBalanceChange, pulseCenterMoney, syncWalletFromServer],
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
    const id = setInterval(fetchPoints, 1200);
    return () => clearInterval(id);
  }, [room.liveSessionId]);

  async function placeBet(optionId: string, marketOverride?: NonNullable<typeof currentMarket>) {
    const market = marketOverride ?? room.currentMarket;
    if (!market) return;
    const isStepBet = market.marketType === "next_step";
    if (!isStepBet && placingOptionId) return;
    if (isStepBet && stepPlacingOptionId) return;
    const stake = lastStakeAmount;

    // Resolve the label from local data — no network needed.
    let pickedLabel: string | null = null;
    if (market.marketType === "city_grid") {
      const spec = market.cityGridSpec;
      const p = parseGridOptionId(optionId);
      pickedLabel = p && spec ? cellLabel(p.row, p.col) : optionId;
    } else if (market.marketType === "zone_exit_time") {
      pickedLabel =
        zoneTimeOptionLabel(optionId, estimatedZoneSecondsRemaining(market, Date.now())) ??
        market.options.find((o) => o.id === optionId)?.shortLabel ??
        market.options.find((o) => o.id === optionId)?.label ??
        null;
    } else {
      pickedLabel =
        market.options.find((o) => o.id === optionId)?.shortLabel ??
        market.options.find((o) => o.id === optionId)?.label ??
        null;
    }

    // ── Optimistic UI — fire immediately, before the network call ──────────
    pulseCenterMoney("stake", stake, pickedLabel);
    setSelectedMapOptionId(null);
    if (isStepBet) {
      setLastBetStepMarketId(market.id);
    } else {
      setLastBetMarketId(market.id);
      setLastBetOptionLabel(pickedLabel);
      setBetJustPlaced(true);
    }
    markBetFeedPlaced(market.id);
    if (market.marketType === "zone_exit_time") {
      const parsed = parseZoneExitMarketMeta(market);
      const startCellKey = parsed?.startCellKey ?? currentZoneCellKey;
      if (parsed && startCellKey) {
        zoneExitDismissedRef.current.delete(market.id);
        setZoneExitPending({
          marketId: market.id,
          opensAtMs: parsed.opensAtMs,
          estimatedSec: parsed.estimatedSec,
          startCellKey,
        });
      }
    }
    if (market.marketType === "city_grid" && currentZoneCellKey) {
      setCityGridBetPending({ marketId: market.id, startCellKey: currentZoneCellKey });
      setZoneConsumedBetTypes((prev) => {
        const next = new Set(prev);
        next.add("next_zone");
        return next;
      });
    }
    if (market.marketType === "zone_exit_time") {
      setZoneConsumedBetTypes((prev) => {
        const next = new Set(prev);
        next.add("zone_exit_time");
        return next;
      });
    }
    if (market.marketType === "next_step") {
      const parsed = parseNextStepMarketMeta(market);
      if (parsed) {
        const now = Date.now();
        const elapsedSinceOpen = Math.max(0, (now - parsed.opensAtMs) / 1000);
        const remaining = Math.max(1, parsed.estimatedSec - elapsedSinceOpen);
        nextStepDismissedRef.current.delete(market.id);
        setNextStepPending({
          marketId: market.id,
          betPlacedAtMs: now,
          remainingAtBetSec: remaining,
          stepLat: market.turnPointLat ?? undefined,
          stepLng: market.turnPointLng ?? undefined,
          routeToPin: routeToPinFromMeta(market.meta) ?? undefined,
        });
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    viewerLiveLog("place_bet_request", {
      roomId: room.roomId,
      marketId: market.id,
      marketType: market.marketType,
      optionId,
      stakeAmount: stake,
    });
    setError(null);
    setMapSheetError(null);
    if (isStepBet) setStepPlacingOptionId(optionId);
    else setPlacingOptionId(optionId);

    // Capture the tap time before the network call so the server can use it
    // as the effective bet time — bets placed before locks_at are accepted
    // even if network latency pushes the request past the lock transition.
    const clientBetAt = Date.now();

    // 8 s hard timeout so "Placing…" never hangs forever.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const rollbackOptimistic = (showSheet: boolean) => {
      clearTimeout(timeoutId);
      // Only clear the pending countdown for the market type that failed.
      // Never clear a countdown that belongs to a DIFFERENT market — e.g. a
      // failed next_step bet must not wipe the zone-exit countdown that the
      // user placed successfully on an earlier market.
      if (market.marketType === "zone_exit_time") {
        setZoneExitPending((prev) =>
          prev?.marketId === market.id ? null : prev,
        );
      }
      if (market.marketType === "next_step") {
        setNextStepPending((prev) =>
          prev?.marketId === market.id ? null : prev,
        );
      }
      if (market.marketType === "city_grid") {
        setCityGridBetPending((prev) =>
          prev?.marketId === market.id ? null : prev,
        );
      }
      setSettlingDeadlineMs(null);
      setSettlingMarketType(null);
      if (isStepBet) {
        if (stepBetJustPlacedTimerRef.current) {
          clearTimeout(stepBetJustPlacedTimerRef.current);
          stepBetJustPlacedTimerRef.current = null;
        }
        setStepBetJustPlaced(false);
        if (showSheet) {
          setLastBetStepMarketId(null);
          restoreBetFeedEntry(market, "step");
        }
      } else {
        if (betJustPlacedTimerRef.current) {
          clearTimeout(betJustPlacedTimerRef.current);
          betJustPlacedTimerRef.current = null;
        }
        setBetJustPlaced(false);
        if (showSheet) {
          setLastBetMarketId(null);
          setLastBetOptionLabel(null);
          restoreBetFeedEntry(market, "unified");
        }
      }
    };

    try {
      const res = await fetch(`/api/live/rooms/${room.roomId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: market.id, optionId, stakeAmount: stake, clientBetAt }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        setMyOpenBetMarketIds((prev) => new Set(prev).add(market.id));
        // Show "✓ accepted" chip for 2.5 s.
        setBetAcceptedLabel(pickedLabel ?? `$${stake}`);
        if (betAcceptedTimerRef.current) clearTimeout(betAcceptedTimerRef.current);
        betAcceptedTimerRef.current = setTimeout(() => setBetAcceptedLabel(null), 2500);
        if (isStepBet) {
          setLastBetStepMarketId(market.id);
        } else {
          // Capture locksAt for the settling chip — stored independently so it
          // survives even if currentMarket goes null briefly between settlement
          // and the next market opening.
          if (market.locksAt) {
            setSettlingDeadlineMs(new Date(market.locksAt).getTime() + 2_000);
            setSettlingMarketType(market.marketType ?? null);
          }
        }
        viewerLiveLog("place_bet_ok", { marketId: market.id, optionId, pickedLabel, stakeAmount: stake });
        return { ok: true as const };
      }

      const j = (await res.json().catch(() => ({}))) as { error?: string };
      const message = j.error ?? "Bet failed";
      viewerLiveWarn("place_bet_failed", { status: res.status, message, marketId: market.id, optionId });

      if (message === "Market not open" || message === "Market has locked") {
        // Race condition — market closed between client tap and server check.
        // Roll back the optimistic countdown and show a brief error so the
        // user understands the countdown disappeared because the bet was NOT
        // placed (not a silent resolution).
        rollbackOptimistic(true);
        setMapSheetError("Betting just closed — bet not placed");
        return { ok: false as const, error: message };
      }

      // Any other server error: rollback and re-show the sheet so user can retry.
      rollbackOptimistic(true);
      setError(message);
      setMapSheetError(message);
      return { ok: false as const, error: message };

    } catch (e) {
      const message =
        e instanceof Error && e.name === "AbortError"
          ? "Timed out — tap to try again"
          : "Connection error — tap to try again";
      viewerLiveWarn("place_bet_failed", { message, marketId: market.id, optionId });
      rollbackOptimistic(true);
      setError(message);
      setMapSheetError(message);
      return { ok: false as const, error: message };
    } finally {
      if (isStepBet) setStepPlacingOptionId(null);
      else setPlacingOptionId(null);
    }
  }

  const viewerTurnTarget = useMemo(
    () =>
      currentMarket?.turnPointLat != null && currentMarket?.turnPointLng != null
        ? { lat: currentMarket.turnPointLat, lng: currentMarket.turnPointLng, kind: "straight" as const, label: "" }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentMarket?.turnPointLat, currentMarket?.turnPointLng],
  );

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
    const bike = isTwoWheeled(room.transportMode);
    return cells.map((c) => ({
      id: c.id,
      slug: c.id,
      name: c.label,
      kind: "district" as const,
      color: bike
        ? `hsl(${(c.col * 37 + c.row * 17) % 360} 14% 78%)`
        : `hsl(${(c.col * 47 + c.row * 29) % 360} 68% 58%)`,
      isActive: true,
      polygon: c.polygon,
    }));
  }, [zonesSpec, room.transportMode]);

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
  /**
   * Map zoom follows only the **open market** — not engine-pill rotation between
   * rounds (that was flipping 900↔250 m without a visible change on mobile).
   */
  const mapBetTypeForCamera: BetTypeV2 | null = currentMarket
    ? marketAnchoredBetType
    : null;

  const zonesVisualStyleForBet =
    viewerBetOfferType === "next_zone" ? "pick_zone" : zoneEngineBetActive ? "muted" : "default";

  /**
   * Two zoom widths only:
   *   • default  → always show 700 m on mobile (900 m on desktop)
   *   • next_turn bet popup open → 450 m on mobile (600 m on desktop)
   * Everything else (zone, time-in-zone, cruising) stays at the default.
   */
  const ZOOM_DEFAULT_M = isMobileViewport ? 700 : 900;
  const ZOOM_NEXT_TURN_M = isMobileViewport ? 450 : 600;

  // Extra close zoom only during an active time-to-pin (next_step) bet.
  const pinBetZoomActive = currentStepMarket?.marketType === "next_step";
  const pinZoomLevelOffset =
    pinBetZoomActive && isTwoWheeled(room.transportMode)
      ? mapZoomLevelOffset(room.transportMode)
      : 0;

  // Zoom tightens when there is an open next_turn market and no bet placed yet.
  // betJustPlaced is declared early enough; viewerHasBetOnCurrentMarket/betWindowClosed
  // are derived later but when true the sheet is already gone so zoom reverts naturally.
  const nextTurnSheetOpen =
    currentMarket?.marketType === "next_turn" && !betJustPlaced;

  const targetWidthMeters = nextTurnSheetOpen ? ZOOM_NEXT_TURN_M : ZOOM_DEFAULT_M;
  // Divide by zoomScale so 0.7 → 1/0.7 ≈ 1.43× wider = zoomed out.
  const viewerTargetWidthMeters = zoomWidthForLevelOffset(
    targetWidthMeters / zoomScale,
    pinZoomLevelOffset,
  );

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

  // Prefer the live step market's stored maneuver point so ALL viewers see the
  // pin the moment the next_step market opens — no bet required.
  // Falls back to nextStepPending so the pin stays visible after the market
  // closes until the server confirms resolution for users who placed a bet.
  const stepPin =
    nextStepOffRoute
      ? null
      : currentStepMarket?.turnPointLat != null &&
          currentStepMarket?.turnPointLng != null
        ? { lat: currentStepMarket.turnPointLat, lng: currentStepMarket.turnPointLng }
        : nextStepPending?.stepLat != null && nextStepPending?.stepLng != null
          ? { lat: nextStepPending.stepLat, lng: nextStepPending.stepLng }
          : null;

  // Countdown props for the pin widget.
  // Priority:
  //   1. Active next_step market open → count from opensAt/estimatedSec (visible to ALL viewers).
  //   2. Market closed but user has a pending bet → count from betPlacedAt (resolving state).
  //   3. Nothing → null (widget hidden).
  const nextStepCountdown: { betPlacedAtMs: number; remainingAtBetSec: number } | null =
    nextStepOffRoute
      ? null
      : (() => {
          if (currentStepMarket?.marketType === "next_step") {
            const parsed = parseNextStepMarketMeta(currentStepMarket);
            if (parsed) return { betPlacedAtMs: parsed.opensAtMs, remainingAtBetSec: parsed.estimatedSec };
          }
          if (nextStepPending) {
            return { betPlacedAtMs: nextStepPending.betPlacedAtMs, remainingAtBetSec: nextStepPending.remainingAtBetSec };
          }
          return null;
        })();

  const viewerDecisionLatLng =
    viewerTurnTargetForMap != null
      ? { lat: viewerTurnTargetForMap.lat, lng: viewerTurnTargetForMap.lng }
      : stickyViewerPin
        ? { lat: stickyViewerPin.lat, lng: stickyViewerPin.lng }
        : null;

  const videoOverlayPin = useMemo(
    () =>
      resolveVideoOverlayPin({
        driver: routePoints.length > 0 ? routePoints[routePoints.length - 1]! : null,
        stepPin,
        driverPin: driverPins?.[0],
        turnTarget: viewerTurnTargetForMap,
      }),
    [routePoints, stepPin, driverPins, viewerTurnTargetForMap],
  );

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
        return nextPinDistanceM != null && nextPinDistanceM <= NEXT_TURN_BET_LOCK_DISTANCE_M;
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
  const _graceDeadlineMs =
    currentMarket?.opensAt && Number.isFinite(Date.parse(currentMarket.opensAt))
      ? Date.parse(currentMarket.opensAt) + MIN_MARKET_OPEN_MS_BEFORE_LOCK
      : null;
  const _graceElapsed = useDeadlinePassed(_graceDeadlineMs);
  const marketOpenGraceElapsed =
    !currentMarket?.opensAt ||
    !Number.isFinite(Date.parse(currentMarket.opensAt)) ||
    _graceElapsed;

  /** Single-shot lock flag — fires exactly when locksAt is reached. */
  const _locksAtMs =
    currentMarket?.locksAt && Number.isFinite(Date.parse(currentMarket.locksAt))
      ? Date.parse(currentMarket.locksAt)
      : null;
  const marketLocked = useDeadlinePassed(_locksAtMs);

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
      marketLocked;
    const distClosed =
      marketOpenGraceElapsed &&
      !liveBetRelaxClient() &&
      distBet <= LIVE_BET_LOCK_DISTANCE_M;
    if (distClosed || timeClosed) return "active";
    return "pending";
  })();

  // Sync market turn point into stickyViewerPin so the blue pin stays visible
  // after the market settles — until the vehicle physically passes it.
  useEffect(() => {
    if (!viewerTurnTarget) return;
    setStickyViewerPin((prev) => {
      // Only update if it's a different position (new turn target from market).
      if (
        prev &&
        Math.abs(prev.lat - viewerTurnTarget.lat) < 1e-7 &&
        Math.abs(prev.lng - viewerTurnTarget.lng) < 1e-7
      ) return prev;
      return { id: `market-turn`, lat: viewerTurnTarget.lat, lng: viewerTurnTarget.lng };
    });
  }, [viewerTurnTarget?.lat, viewerTurnTarget?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewerOsrmPreviewPins = useMemo(() => {
    // Suppress the turn-layer blue dot while a next_step (time-to-pin) market is
    // active or a pending bet is resolving — showing both creates two blue dots.
    if (currentStepMarket || nextStepPending) return null;
    if (currentMarket?.marketType === "city_grid") return driverPins;
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
    nextStepPending,
    viewerTurnTarget?.lat,
    viewerTurnTarget?.lng,
    stickyViewerPin,
    driverPins,
  ]);
  const viewerDriverPos =
    routePoints.length > 0
      ? { lat: routePoints[routePoints.length - 1]!.lat, lng: routePoints[routePoints.length - 1]!.lng }
      : null;
  // Clear the "just placed" flag and pick label when market changes.
  useEffect(() => {
    if (!currentMarket || currentMarket.id !== lastBetMarketId) {
      if (lastBetMarketId && currentMarket?.id !== lastBetMarketId) {
        setLastBetMarketId(null);
        setLastBetOptionLabel(null);
        // A new market opened while the old bet was still in the "settling"
        // state — clear the chip so it doesn't bleed into the new market.
        setSettlingDeadlineMs(null);
        setSettlingMarketType(null);
      }
    }
    if (betJustPlacedTimerRef.current) {
      clearTimeout(betJustPlacedTimerRef.current);
      betJustPlacedTimerRef.current = null;
    }
    setBetJustPlaced(false);
    setCityGridBetPending((prev) => {
      if (!prev) return null;
      if (!currentMarket || currentMarket.id !== prev.marketId) return null;
      return prev;
    });
  }, [currentMarket?.id, lastBetMarketId]);

  // Clear step-bet tracking when the step market changes.
  useEffect(() => {
    if (lastBetStepMarketId && currentStepMarket?.id !== lastBetStepMarketId) {
      setLastBetStepMarketId(null);
    }
    if (stepBetJustPlacedTimerRef.current) {
      clearTimeout(stepBetJustPlacedTimerRef.current);
      stepBetJustPlacedTimerRef.current = null;
    }
    setStepBetJustPlaced(false);
  }, [currentStepMarket?.id, lastBetStepMarketId]);

  // Keep right-column countdown in sync after a zone-exit bet (incl. page refresh / feed tick).
  // Note: once dismissed (countdown finished), we do NOT restore the widget.
  useEffect(() => {
    if (!currentMarket || currentMarket.marketType !== "zone_exit_time") return;
    if (lastBetMarketId !== currentMarket.id) return;
    if (zoneExitDismissedRef.current.has(currentMarket.id)) return;
    if (zoneExitPending?.marketId === currentMarket.id) return;
    const parsed = parseZoneExitMarketMeta(currentMarket);
    if (!parsed) return;
    const startCellKey = parsed.startCellKey ?? currentZoneCellKey;
    if (!startCellKey) return;
    setZoneExitPending({
      marketId: currentMarket.id,
      opensAtMs: parsed.opensAtMs,
      estimatedSec: parsed.estimatedSec,
      startCellKey,
    });
  }, [
    currentMarket,
    currentMarket?.id,
    currentMarket?.marketType,
    currentMarket?.opensAt,
    currentMarket?.meta,
    currentZoneCellKey,
    lastBetMarketId,
    zoneExitPending?.marketId,
  ]);

  // Sync next_step countdown on page refresh / feed tick.
  // next_step markets now live in currentStepMarket (independent slot).
  useEffect(() => {
    if (!currentStepMarket || currentStepMarket.marketType !== "next_step") return;
    if (lastBetMarketId !== currentStepMarket.id) return;
    if (nextStepDismissedRef.current.has(currentStepMarket.id)) return;
    if (nextStepPending?.marketId === currentStepMarket.id) return;
    const parsed = parseNextStepMarketMeta(currentStepMarket);
    if (!parsed) return;
    const now = Date.now();
    const elapsedSinceOpen = Math.max(0, (now - parsed.opensAtMs) / 1000);
    // Math.max(1, …) not 0 — a restored value of 0 immediately fires the
    // nextStepResolving (spinner) before the user sees any countdown.
    const remaining = Math.max(1, parsed.estimatedSec - elapsedSinceOpen);
    setNextStepPending({
      marketId: currentStepMarket.id,
      betPlacedAtMs: now,
      remainingAtBetSec: remaining,
      stepLat: currentStepMarket.turnPointLat ?? undefined,
      stepLng: currentStepMarket.turnPointLng ?? undefined,
      routeToPin: routeToPinFromMeta(currentStepMarket.meta) ?? undefined,
    });
  }, [
    currentStepMarket,
    currentStepMarket?.id,
    currentStepMarket?.marketType,
    currentStepMarket?.opensAt,
    currentStepMarket?.meta,
    currentStepMarket?.turnPointLat,
    currentStepMarket?.turnPointLng,
    lastBetMarketId,
    nextStepPending?.marketId,
  ]);

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
   * "Settling" chip — shown in the gap between locks_at (countdown ends) and
   * the actual settlement arriving via the server sweep.
   *
   * Uses `settlingDeadlineMs` (captured at bet-placement time) rather than
   * deriving from `currentMarket?.locksAt` so it survives the brief null
   * window between market settlement and the next market opening.
   */
  const settleLocksPassed = useDeadlinePassed(settlingDeadlineMs);
  const showSettlingChip = Boolean(
    settleLocksPassed &&
      lastBetMarketId &&
      // zone_exit_time and next_step have their own countdown widgets
      settlingMarketType !== "zone_exit_time" &&
      settlingMarketType !== "next_step",
  );

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
  // Re-engage follow + auto-zoom on every new market so a previous pan/drag
  // doesn't permanently disable zoom switching between bet rounds.
  useEffect(() => {
    if (currentMarket?.id) {
      if (mapFollowRestoreRef.current) {
        clearTimeout(mapFollowRestoreRef.current);
        mapFollowRestoreRef.current = null;
      }
      setMapFollow(true);
    }
  }, [currentMarket?.id]);

  /**
   * Product rule: each bet card stays until `locks_at` (≥ 8 s from open) or
   * until the viewer places a bet — whichever makes it impossible to bet first.
   * Cards stack independently; a new market does not replace older cards early.
   */
  // Reuse _locksAtMs / marketLocked computed above — no polling needed.
  const betWindowClosed = !!(currentMarket && _locksAtMs != null && marketLocked);
  void betWindowClosed;

  const viewerHasBetOnStepMarket = Boolean(
    currentStepMarket && lastBetStepMarketId === currentStepMarket.id,
  );
  const stepMarketLockedMs = currentStepMarket?.locksAt
    ? new Date(currentStepMarket.locksAt).getTime()
    : null;
  const stepMarketLocked = useDeadlinePassed(stepMarketLockedMs);
  void isLocked;
  void betPanelDismissed;

  // Zone countdown clock lives inside BetFeedCard.

  /**
   * One-touch sheet: tapping an option places the bet immediately. The only
   * remaining "closed" trigger is the 7-second window expiring (already
   * captured by `betWindowClosed`, which also hides the sheet entirely).
   */
  const sheetBettingClosed =
    !currentMarket ||
    (!liveBetRelaxClient() && isLocked);

  const viewerCurrentBetHeadline =
    viewerBetOfferType != null ? engineBetHeadline(viewerBetOfferType) : null;

  const sheetBetHeadline = viewerCurrentBetHeadline ?? "Live bet";

  useEffect(() => {
    betFeedDismissedRef.current.clear();
    setBetFeedEntries([]);
  }, [room.roomId]);

  useEffect(() => {
    if (!showLiveBets) return;
    setBetFeedEntries((prev) => {
      let next = prev.filter((e) => !betFeedDismissedRef.current.has(e.marketId));
      const upsert = (market: LiveMarketSlot, slot: BetFeedSlot) => {
        if (betFeedDismissedRef.current.has(market.id)) return;
        if (isBetFeedMarketLocked(market, Date.now())) return;
        const ix = next.findIndex((e) => e.marketId === market.id);
        const snap = snapshotBetFeedMarket(market);
        if (ix >= 0) {
          next[ix] = {
            ...next[ix],
            market: snap,
            stackSlot: next[ix]!.stackSlot,
          };
        } else {
          next.push({
            marketId: market.id,
            slot,
            shownAtMs: Date.now(),
            market: snap,
            stackSlot: nextFreeBetFeedStackSlot(next),
          });
        }
      };
      if (currentMarket) upsert(currentMarket, "unified");
      if (currentStepMarket) upsert(currentStepMarket, "step");
      return next;
    });
  }, [showLiveBets, currentMarket, currentStepMarket]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setBetFeedEntries((prev) => {
        const next = prev.filter((entry) => {
          if (betFeedDismissedRef.current.has(entry.marketId)) return false;
          const locked = isBetFeedMarketLocked(entry.market, now);
          if (locked) {
            betFeedDismissedRef.current.add(entry.marketId);
            return false;
          }
          return true;
        });
        return next.length === prev.length ? prev : next;
      });
    }, 300);
    return () => clearInterval(id);
  }, []);

  const sortedBetFeedEntries = useMemo(
    () =>
      [...betFeedEntries].sort(
        (a, b) => Date.parse(a.market.opensAt) - Date.parse(b.market.opensAt),
      ),
    [betFeedEntries],
  );

  const betFeedVisible = sortedBetFeedEntries.length > 0;

  const betMapHighlights = useMemo(() => {
    const now = Date.now();
    const open = sortedBetFeedEntries.filter(
      (e) => !isBetFeedMarketLocked(e.market, now),
    );
    let stepPinPulse = false;
    let turnPinPulse = false;
    const zonePulseById: Record<string, "current" | `neighbor-${number}`> = {};

    for (const e of open) {
      const t = e.market.marketType;
      if (t === "next_step") stepPinPulse = true;
      if (t === "next_turn") turnPinPulse = true;
      if (t === "zone_exit_time" && currentZoneCellKey) {
        zonePulseById[currentZoneCellKey] = "current";
      }
      if (t === "city_grid" && zonesSpec && currentZoneCellKey) {
        for (const [i, nid] of neighborCellIds(
          zonesSpec,
          currentZoneCellKey,
        ).entries()) {
          if (zonePulseById[nid] !== "current") {
            zonePulseById[nid] = `neighbor-${i}` as `neighbor-${number}`;
          }
        }
      }
    }

    return {
      stepPinPulse,
      turnPinPulse,
      zonePulseById:
        Object.keys(zonePulseById).length > 0 ? zonePulseById : undefined,
    };
  }, [sortedBetFeedEntries, currentZoneCellKey, zonesSpec]);

  const mapHighlightsActive =
    betMapHighlights.stepPinPulse ||
    betMapHighlights.turnPinPulse ||
    !!betMapHighlights.zonePulseById;

  const mapBetSheetOpen =
    currentMarket?.marketType === "city_grid" &&
    sortedBetFeedEntries.some(
      (e) => e.slot === "unified" && e.marketId === currentMarket.id,
    );

  const driverRouteBadges = useMemo(
    () => drivingRouteStyleBadges(room.drivingRouteStyle, room.transportMode),
    [
      room.transportMode,
      room.drivingRouteStyle.comfortVsSpeed,
      room.drivingRouteStyle.pathStyle,
      room.drivingRouteStyle.ecoConscious,
    ],
  );

  /**
   * Stable callbacks for LiveMap — must never change identity so React.memo
   * on LiveMap is not defeated by every parent render.
   *
   * All values that the handlers need to read at call-time are stored in a
   * single mutable ref that is updated every render (no React re-render cost).
   * The callbacks themselves are created once with useCallback(() => ..., []).
   */
  const zoneSelectCtxRef = useRef({
    currentMarket,
    sheetBettingClosed,
    placingOptionId,
    viewerHasBetOnCurrentMarket: false as boolean,
    scheduleBetClose,
    placeBet,
  });
  // Update synchronously during render (safe for refs).
  zoneSelectCtxRef.current = {
    currentMarket,
    sheetBettingClosed,
    placingOptionId,
    viewerHasBetOnCurrentMarket,
    scheduleBetClose,
    placeBet,
  };

  const handleZoneSelect = useCallback((id: string | null) => {
    const ctx = zoneSelectCtxRef.current;
    setSelectedZoneId(id);
    if (id) setSelectedCheckpointId(null);
    if (
      id &&
      ctx.currentMarket?.marketType === "city_grid" &&
      !ctx.sheetBettingClosed &&
      !ctx.placingOptionId &&
      !ctx.viewerHasBetOnCurrentMarket
    ) {
      ctx.scheduleBetClose();
      void ctx.placeBet(id).then((result) => {
        if (result?.ok) {
          setSelectedZoneId(null);
          setMapSheetError(null);
        }
      });
    }
  }, []);

  const handleCheckpointSelect = useCallback((id: string | null) => {
    setSelectedCheckpointId(id);
    if (id) setSelectedZoneId(null);
  }, []);

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
      const top = Math.max(48, window.innerHeight - boxW - 16);
      setPipPos({ top, left: 0 });
    };
    placeBottomLeft();
    window.addEventListener("resize", placeBottomLeft);
    return () => window.removeEventListener("resize", placeBottomLeft);
  }, []);

  // nowTick interval removed — replaced by per-consumer useDeadlinePassed / local clocks.

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchDest = async (offRoute = false): Promise<void> => {
      if (cancelled) return;
      try {
        const url = offRoute
          ? `/api/live/rooms/${room.roomId}/destination-route?offRoute=1`
          : `/api/live/rooms/${room.roomId}/destination-route`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) {
          retryTimer = setTimeout(() => {
            void fetchDest(false);
          }, 60_000);
          return;
        }
        const j = (await r.json()) as {
          route: {
            polyline: Array<{ lat: number; lng: number }>;
            distanceMeters: number;
            durationSec: number;
            trafficSegments?: Array<{ startIndex: number; endIndex: number; speed: "NORMAL" | "SLOW" | "TRAFFIC_JAM" }>;
          } | null;
          distanceToDestinationMeters?: number;
          refetched?: boolean;
          reason?: "no_room" | "no_destination" | "no_position" | "arrived";
        };
        if (cancelled) return;
        if (j.route?.polyline && j.route.polyline.length > 1) {
          setDestinationRoute(j.route.polyline);
          setDestinationRouteTraffic(j.route.trafficSegments ?? null);
          if (j.refetched) {
            googleRouteHiddenRef.current = false;
            setGoogleRouteHidden(false);
          }
        } else if (j.reason === "no_destination" || j.reason === "arrived") {
          setDestinationRoute(null);
          setDestinationRouteTraffic(null);
          googleRouteHiddenRef.current = false;
          setGoogleRouteHidden(false);
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
            cur && cur.length > 1 ? 90_000 : 60_000;
          retryTimer = setTimeout(() => {
            void fetchDest(false);
          }, delay);
        }
      }
    };
    fetchDestRouteRef.current = fetchDest;
    void fetchDest(false);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [room.roomId]);

  useEffect(() => {
    const route = destinationRouteRef.current;
    const last = routePoints[routePoints.length - 1];
    if (!route || route.length < 2 || !last) return;

    if (!isDriverOffGoogleDestinationRoute(last, route)) return;

    if (!googleRouteHiddenRef.current) {
      googleRouteHiddenRef.current = true;
      setGoogleRouteHidden(true);
    }

    const now = Date.now();
    if (now - offRouteRefetchAtRef.current < 45_000) return;
    offRouteRefetchAtRef.current = now;
    void fetchDestRouteRef.current(true);
  }, [routePoints]);

  useEffect(() => {
    let cancelled = false;
    const fetchRoute = async () => {
      // next_turn is suspended — skip the route fetch entirely so no pins
      // or approach lines are shown on the map.
      if (!NEXT_TURN_BETS_ENABLED) {
        setDriverPins(null);
        setApproachLine(null);
        return;
      }
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

  // ── Traffic cameras — fetch nearby cameras based on position + heading ────
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const fetchCameras = async () => {
      try {
        const pts = routePointsRef.current;
        const last = pts[pts.length - 1];
        if (!last) return;
        const heading = last.heading ?? 0;
        const res = await fetch(
          `/api/live/traffic-cameras?lat=${last.lat}&lng=${last.lng}&heading=${heading}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as { cameras: TrafficCamera[] };
        if (!cancelled) setTrafficCameras(j.cameras ?? []);
      } catch {
        /* transient */
      } finally {
        if (!cancelled) timer = setTimeout(fetchCameras, 20_000);
      }
    };

    if (!mapPerfDegraded) void fetchCameras();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  // Re-kick when room changes or perf degrades; routePoints are NOT in deps (read via closure).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId, mapPerfDegraded]);

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

  const feedEntryIsLive = (entry: BetFeedEntry) =>
    entry.slot === "unified"
      ? entry.marketId === currentMarket?.id
      : entry.marketId === currentStepMarket?.id;

  const feedEntryBettingClosed = (entry: BetFeedEntry) => {
    if (entry.betPlaced) return true;
    if (isBetFeedMarketLocked(entry.market, Date.now())) return true;
    if (!feedEntryIsLive(entry)) return true;
    if (entry.slot === "unified") return sheetBettingClosed;
    return !!stepMarketLocked;
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
        eligibleRoundPlans={activeBettingRound?.eligibleRoundPlans ?? []}
        highlightedEngineType={
          displayBetType && displayBetType !== viewerBetOfferType
            ? displayBetType
            : null
        }
        onSelectEngineType={(t) => {
          setViewerEnginePillType((prev) => (prev === t ? null : t));
        }}
        leftOffsetPx={nearestCamera ? pipSizePx : 0}
      />
      {immersiveLiveRoom && !betFeedVisible ? (
        <button
          type="button"
          onClick={() => router.push("/live")}
          className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 z-[55] flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/80 text-base text-white/90 active:bg-black/95"
          title="Leave room"
          aria-label="Leave room"
        >
          ✕
        </button>
      ) : null}
      <LiveEventToasts
        roomId={room.roomId}
        role="viewer"
        onSettlement={handleSettlement}
        onRoomActivity={onViewerRoomActivity}
        urgentSettlementMarketId={urgentSettlementMarketId}
      />
      {centerMoneyFlash ? (
        <ViewerCenterMoneyFlash
          kind={centerMoneyFlash.kind}
          amount={centerMoneyFlash.amount}
          target={centerMoneyFlash.target ?? null}
        />
      ) : null}
      {/* Replay sheet — shown when user taps history button */}
      {showReplay && (
        <ReplaySheet
          roomId={room.roomId}
          onClose={() => setShowReplay(false)}
        />
      )}

      {/* ── Split layout: dashcam (top 1/3) + map (bottom 2/3) ── */}
      <div
        className="absolute inset-x-0 top-0 z-[8] flex items-center justify-center overflow-hidden bg-black"
        style={{ height: "33dvh", minHeight: "33dvh" }}
      >
        {showYoutubeDashcam ? (
          <iframe
            src={DASHCAM_YOUTUBE_EMBED}
            className="absolute inset-0 h-full w-full border-0"
            style={{
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "177.78vh",
              minWidth: "100%",
              height: "56.25vw",
              minHeight: "100%",
            }}
            allow="autoplay; encrypted-media"
            allowFullScreen
            title="Dashcam feed (dev test)"
          />
        ) : room.liveSessionId ? (
          <LiveVideoPlayer
            key={room.liveSessionId}
            liveSessionId={room.liveSessionId}
            className="h-full w-full"
            objectFit={isMobileViewport ? "cover" : "contain"}
            objectPosition={isMobileViewport ? "top" : "center"}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            Waiting for live session…
          </div>
        )}
        {!showYoutubeDashcam ? (
        <VideoStreamOverlay
          routePoints={routePoints}
          pinTarget={videoOverlayPin}
          zoneGridSpec={zonesSpec}
          zoneLabel={room.regionLabel}
        />
        ) : null}
      </div>

      {/* Map panel — bottom 67% of screen; clip rotated map bleed */}
      <div
        className="absolute inset-x-0 bottom-0 z-0 overflow-hidden"
        style={{ top: "33dvh" }}
      >
        <LiveMap
          routePoints={routePoints}
          className="h-full w-full"
          interactive={true}
          audienceRole="viewer"
          showCourseArrow={true}
          transportMode={room.transportMode}
          rotateWithHeading={true}
          followMode={mapFollow}
          onUserInteract={handleMapUserInteract}
          onPerformanceDegrade={handleMapPerfDegrade}
          tileOpacity={1}
          mapCaption={
            viewerCurrentBetHeadline ?? currentMarket?.title ?? undefined
          }
          zones={zones}
          checkpoints={checkpoints}
          selectedZoneId={selectedZoneId}
          currentZoneId={currentZoneId}
          selectedCheckpointId={selectedCheckpointId}
          showZones={effectiveShowZones || mapHighlightsActive}
          zonesVisualStyle={
            mapHighlightsActive && betMapHighlights.zonePulseById
              ? "pick_zone"
              : zonesVisualStyleForBet
          }
          showCheckpoints={true}
          turnTarget={viewerTurnTargetForMap}
          stepPin={stepPin}
          stepPinPulse={betMapHighlights.stepPinPulse}
          turnPinPulse={betMapHighlights.turnPinPulse}
          zonePulseById={betMapHighlights.zonePulseById ?? undefined}
          driverPins={viewerOsrmPreviewPins}
          approachLine={approachLine}
          railPhase={viewerRailPhase}
          destination={room.destination}
          destinationRoute={mapDestinationRoute}
          destinationRouteTraffic={mapDestinationTraffic}
          destinationRouteLabel="Google suggested route"
          driverRouteBadges={driverRouteBadges}
          trafficCameras={trafficCameras}
          activeCameraId={nearestCamera?.id ?? null}
          leftInsetPx={nearestCamera ? pipSizePx : 0}
          viewerFollowLatLngBounds={null}
          viewerFollowBoundsMinZoom={null}
          viewerTargetWidthMeters={viewerTargetWidthMeters}
          viewerZoomRuleKey={`zoom:${Math.round(viewerTargetWidthMeters)}:${pinZoomLevelOffset}:${currentMarket?.id ?? "nomarket"}`}
          zoomLevelBonus={pinZoomLevelOffset}
          layoutViewportWidthPx={layoutViewportW}
          onZoneSelect={handleZoneSelect}
          onCheckpointSelect={handleCheckpointSelect}
        />
      </div>

      {room.destination ? (
        <div className="pointer-events-none fixed right-12 top-3 z-[62] max-w-[min(58vw,13rem)]">
          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-white/10 bg-black/70 px-1.5 py-px text-[8px] font-normal leading-tight text-white/55 shadow-none">
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

      {/* Route overview — only during active next_zone bet */}
      {currentMarket?.marketType === "city_grid" && routeLast && room.destination ? (
        <RouteOverviewMap
          routePoints={routePoints}
          destination={room.destination}
          destinationRoute={mapDestinationRoute}
        />
      ) : null}

      {/* Corner live dot — shifts right when traffic camera panel is occupying top-left */}
      <div
        className="pointer-events-none fixed top-3 z-[62] transition-all duration-200"
        style={{ left: nearestCamera ? pipSizePx + 6 : 12 }}
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
        className="fixed right-3 top-3 z-[62] flex h-7 w-7 items-center justify-center rounded-full bg-black/65 text-xs text-white/75 shadow-md active:bg-black/80"
        title="Decision history"
      >
        📋
      </button>

      <div className="fixed right-3 top-[calc(33dvh+0.5rem)] z-40 flex flex-col items-end gap-3">
        {wallet && !walletLoading ? (
          <BalanceBadge
            balance={liveBalance}
            splash={balanceChangeSplash}
            onSplashDone={() => setBalanceChangeSplash(null)}
          />
        ) : null}
        {mapExpanded ? (
          <div className="flex flex-col items-center gap-5">
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
          <IconRailButton active onClick={() => undefined} title="Live bets">
            <IconCoin />
          </IconRailButton>
          <IconRailButton
            active={zoomScaleIdx !== 0}
            onClick={() => setZoomScaleIdx((i) => (i + 1) % ZOOM_SCALES.length)}
            title={zoomScaleIdx === 0 ? "Zoom out" : `Zoom: ${zoomScale}×`}
          >
            <IconZoomScale scale={zoomScale} />
          </IconRailButton>
          </div>
        ) : null}
        {YOUTUBE_DASHCAM_DEV_ONLY ? (
          <IconRailButton
            active={useYoutubeDashcam}
            onClick={toggleYoutubeDashcam}
            title={
              useYoutubeDashcam
                ? "YouTube test feed — tap for live camera"
                : "Live camera — tap for YouTube test feed"
            }
          >
            <IconSparkle />
          </IconRailButton>
        ) : null}
        {zoneExitPending ? (
          <ZoneExitCountdownWidget
            deadlineMs={zoneExitDeadlineMs!}
            resolving={zoneExitResolving}
          />
        ) : null}
        {nextStepCountdown ? (
          <NextStepCountdownWidget
            betPlacedAtMs={nextStepCountdown.betPlacedAtMs}
            remainingAtBetSec={nextStepCountdown.remainingAtBetSec}
            resolving={nextStepResolving}
            pinLat={stepPin?.lat ?? null}
            pinLng={stepPin?.lng ?? null}
          />
        ) : null}
      </div>
      {mapExpanded && !mapFollow ? (
        <button
          type="button"
          onClick={() => setMapFollow(true)}
          className="absolute bottom-48 right-4 z-50 flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-600/70 px-3 py-1.5 text-[11px] font-semibold text-amber-50 shadow-lg active:bg-amber-600/90"
          title="Recenter on streamer"
        >
          <span className="text-base leading-none">◎</span>
          Center on streamer
        </button>
      ) : null}
      {/* ── Traffic camera panel — flush top-left corner ── */}
      {nearestCamera && !mapPerfDegraded ? (
        <div className="absolute left-0 top-0 z-30">
          <TrafficCameraPanel camera={nearestCamera} size={pipSizePx} />
        </div>
      ) : null}

      {/* ── PiP corner: swapped view + expand toggle ── */}
      {/* EXPERIMENT: dashcam PiP hidden while YouTube feed is active — restore together with LiveVideoPlayer */}
      {false && <div
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
              onPerformanceDegrade={handleMapPerfDegrade}
              tileOpacity={0.65}
              mapCaption={
              viewerCurrentBetHeadline ?? currentMarket?.title ?? undefined
            }
              zones={zones}
              checkpoints={checkpoints}
              selectedZoneId={selectedZoneId}
              currentZoneId={currentZoneId}
              selectedCheckpointId={selectedCheckpointId}
              showZones={effectiveShowZones || mapHighlightsActive}
              zonesVisualStyle={
                mapHighlightsActive && betMapHighlights.zonePulseById
                  ? "pick_zone"
                  : zonesVisualStyleForBet
              }
              showCheckpoints={true}
              turnTarget={viewerTurnTargetForMap}
              stepPin={stepPin}
              stepPinPulse={betMapHighlights.stepPinPulse}
              turnPinPulse={betMapHighlights.turnPinPulse}
              zonePulseById={betMapHighlights.zonePulseById ?? undefined}
              driverPins={viewerOsrmPreviewPins}
              approachLine={approachLine}
              railPhase={viewerRailPhase}
              destination={room.destination}
              destinationRoute={mapDestinationRoute}
              destinationRouteTraffic={mapDestinationTraffic}
              destinationRouteLabel="Google suggested route"
              driverRouteBadges={driverRouteBadges}
              trafficCameras={trafficCameras}
              activeCameraId={nearestCamera?.id ?? null}
              viewerFollowLatLngBounds={null}
              viewerFollowBoundsMinZoom={null}
              viewerTargetWidthMeters={viewerTargetWidthMeters}
              viewerZoomRuleKey={`zoom:${Math.round(viewerTargetWidthMeters)}:${currentMarket?.id ?? "nomarket"}`}
              layoutViewportWidthPx={layoutViewportW}
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
          className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white active:bg-black/90"
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
      </div>}
      {/* END EXPERIMENT PiP hide */}

      {/* ── Bottom gradient scrim ────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-black/70 to-transparent" />

      {/* ── Bet feed (full-width stacked cards) ───────────── */}
      {sortedBetFeedEntries.length > 0 ? (
        <BetFeedStack entries={sortedBetFeedEntries}>
          {(entry) => {
            const market = entry.market;
            const isLive = feedEntryIsLive(entry);
            const bettingClosed = feedEntryBettingClosed(entry);
            const isUnified = entry.slot === "unified";
            const referenceCountdown =
              market.marketType === "zone_exit_time"
                ? parseZoneExitMarketMeta(market)
                : market.marketType === "next_step"
                  ? parseNextStepMarketMeta(market)
                  : null;
            const referenceStreak =
              market.marketType === "straight_streak"
                ? parseStraightStreakMeta(market)
                : null;
            const title =
              isUnified && isLive
                ? market.title ?? viewerCurrentBetHeadline ?? sheetBetHeadline
                : market.title;
            const selectionDetail =
              market.marketType === "city_grid" && isLive
                ? selectedZone
                  ? selectedZone.name
                  : "Tap map"
                : null;
            const isPlacingThis =
              isUnified
                ? isLive && !!placingOptionId && market.id === currentMarket?.id
                : isLive && !!stepPlacingOptionId && market.id === currentStepMarket?.id;
            return (
              <BetFeedCard
                key={entry.marketId}
                stackSlot={entry.stackSlot}
                maxStackSlot={Math.max(...sortedBetFeedEntries.map((e) => e.stackSlot))}
                marketType={market.marketType}
                title={title}
                betPlaced={entry.betPlaced}
                referenceCountdown={referenceCountdown}
                referenceStreak={referenceStreak}
                selectionDetail={selectionDetail}
                marketOptions={market.options ?? []}
                selectedOptionId={
                  isUnified && isLive && market.marketType === "city_grid"
                    ? selectedMapOptionId
                    : null
                }
                onSelectOption={(id) => {
                  if (bettingClosed) return;
                  if (isUnified) {
                    setSelectedMapOptionId(id);
                    if (market.marketType === "city_grid") return;
                    if (
                      (placingOptionId && market.id === currentMarket?.id) ||
                      (viewerHasBetOnCurrentMarket && market.id === currentMarket?.id)
                    ) {
                      return;
                    }
                    void placeBet(id, market).then((result) => {
                      if (result?.ok) {
                        setSelectedZoneId(null);
                        setSelectedCheckpointId(null);
                        setMapSheetError(null);
                      }
                    });
                    return;
                  }
                  if (
                    (stepPlacingOptionId && market.id === currentStepMarket?.id) ||
                    (viewerHasBetOnStepMarket && market.id === currentStepMarket?.id)
                  ) {
                    return;
                  }
                  void placeBet(id, market).then(() => {
                    setMapSheetError(null);
                  });
                }}
                bettingClosed={bettingClosed}
                isPlacing={isPlacingThis}
                error={isUnified && isLive ? mapSheetError : null}
                locksAt={market.locksAt}
                onClose={() => {
                  if (isUnified) {
                    setSelectedZoneId(null);
                    setSelectedCheckpointId(null);
                    setMapSheetError(null);
                  }
                }}
                onPlaceBet={async () => {
                  if (bettingClosed) return;
                  if (isUnified) {
                    if (!selectedMapOptionId) return;
                    const result = await placeBet(selectedMapOptionId, market);
                    if (result?.ok) {
                      setSelectedZoneId(null);
                      setSelectedCheckpointId(null);
                      setMapSheetError(null);
                    }
                    return;
                  }
                  const opts = market.options ?? [];
                  if (!opts[0]) return;
                  void placeBet(opts[0].id, market);
                }}
                gridMode={market.marketType === "city_grid"}
                turnMode={market.marketType === "next_turn"}
                oneTapOptionBet={market.marketType !== "city_grid"}
              />
            );
          }}
        </BetFeedStack>
      ) : null}

      {/* ── Straight streak passage tracker — only for viewers who bet ── */}
      {currentMarket?.marketType === "straight_streak" &&
      viewerHasBetOnCurrentMarket ? (
        <StraightStreakTracker
          marketMeta={currentMarket.meta}
          marketId={currentMarket.id}
          vehiclePosition={routeLast}
        />
      ) : null}

      {/* ── Settling chip (post-locks_at gap) ────────────────── */}
      {/* For straight_streak the tracker is already at bottom-28, push this chip above it. */}
      {showSettlingChip ? (
        <div
          className={[
            "pointer-events-none absolute inset-x-0 z-[195] flex justify-center",
            settlingMarketType === "straight_streak" ? "bottom-44" : "bottom-28",
          ].join(" ")}
        >
          <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-sm font-semibold text-white/80 shadow-lg backdrop-blur-sm">
            {/* Spinning indicator */}
            <svg
              className="size-3.5 shrink-0 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                d="M12 2a10 10 0 0 1 10 10"
                strokeDasharray="20 40"
              />
            </svg>
            <span>{settlingChipText(settlingMarketType ?? "")}</span>
          </div>
        </div>
      ) : null}

      {/* ── Bet accepted confirmation chip ───────────────────── */}
      {/* Always shown when set — no showUnifiedBetSheet gate which could hide it
          if a new market opens in the ~200 ms window while the API call is in-flight. */}
      {betAcceptedLabel ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-[210] flex justify-center">
          <div className="flex animate-fade-in items-center gap-2 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg">
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0">
              <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
            </svg>
            <span>Bet placed · {betAcceptedLabel}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fmtUsdFlash(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

function fmtUsdWhole(n: number): string {
  return String(Math.round(n));
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
    master.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.25);
    master.connect(ctx.destination);

    // Casino "cha-ching" — bright triad cascading like a slot win, plus a
    // bell tail. Frequencies chosen to feel celebratory but short.
    const cascade = [
      { f: 783.99, t: 0.0,  d: 0.18 }, // G5
      { f: 987.77, t: 0.07, d: 0.20 }, // B5
      { f: 1318.5, t: 0.16, d: 0.28 }, // E6
      { f: 1568.0, t: 0.26, d: 0.30 }, // G6
      { f: 2093.0, t: 0.38, d: 0.40 }, // C7  ← bell
    ];
    cascade.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + t;
      osc.type = t < 0.3 ? "triangle" : "sine";
      osc.frequency.setValueAtTime(f, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.95, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + d);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + d + 0.02);
    });

    // Coin-shake noise burst (filtered white-ish noise) for "metal-on-metal".
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.45, ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      const env = Math.pow(1 - i / ch.length, 1.8);
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.value = 2400;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(ctx.currentTime);
    noise.stop(ctx.currentTime + 0.5);

    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
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
        className={`text-2xl font-bold tabular-nums tracking-tight [text-shadow:0_0_16px_rgba(0,0,0,0.92)] sm:text-3xl ${colorClass}`}
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

/**
 * Square button countdown for zone_exit_time bets.
 * Counts down to market open + estimated seconds, shows 0 when elapsed, stays
 * visible until `handleSettlement` clears it (or 45 s safety fires).
 */
const ZoneExitCountdownWidget = memo(function ZoneExitCountdownWidget({
  deadlineMs,
  resolving = false,
}: {
  deadlineMs: number;
  resolving?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingSec = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
  const urgent = !resolving && remainingSec <= 5;
  return (
    <div
      className={`pointer-events-none flex h-11 w-11 items-center justify-center rounded-xl border text-sm font-bold tabular-nums transition-colors ${
        resolving
          ? "border-amber-400/50 bg-amber-600/30 text-amber-100"
          : urgent
            ? "border-red-400/60 bg-red-600/40 text-red-100"
            : "border-cyan-500/30 bg-cyan-950/50 text-cyan-100"
      }`}
      title={resolving ? "Awaiting zone result…" : "Time left in zone"}
    >
      {resolving ? (
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-amber-300/40 border-t-amber-200" />
      ) : (
        remainingSec
      )}
    </div>
  );
});

/**
 * Pin-shaped countdown for next_step bets.
 * A rounded square (pin head) with a downward triangle (pin point) — classic
 * map-pin silhouette. Counts down from `remainingAtBetSec` seconds.
 */
const NextStepCountdownWidget = memo(function NextStepCountdownWidget({
  betPlacedAtMs,
  remainingAtBetSec,
  resolving = false,
  pinLat = null,
  pinLng = null,
}: {
  betPlacedAtMs: number;
  remainingAtBetSec: number;
  resolving?: boolean;
  pinLat?: number | null;
  pinLng?: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [landmark, setLandmark] = useState<NearbyLandmark | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch nearest landmark (name + photo) when pin coords are available.
  useEffect(() => {
    if (pinLat == null || pinLng == null) { setLandmark(null); return; }
    let cancelled = false;
    fetchNearbyLandmark(pinLat, pinLng).then((result) => {
      if (!cancelled) setLandmark(result);
    });
    return () => { cancelled = true; };
  }, [pinLat, pinLng]);

  const remainingSec = Math.max(
    0,
    Math.round(remainingAtBetSec) - Math.floor((now - betPlacedAtMs) / 1000),
  );
  const urgent = !resolving && remainingSec <= 5;

  const bg = resolving
    ? "bg-amber-600/30 border-amber-400/50 text-amber-100"
    : urgent
      ? "bg-red-600/40 border-red-400/60 text-red-100"
      : "bg-stone-900/60 border-stone-400/30 text-stone-100";

  const title = landmark?.name ?? (resolving ? "Awaiting result…" : "Nearby landmark");

  return (
    <div
      className="pointer-events-none flex flex-col items-center gap-0.5"
      title={title}
    >
      {/* Photo bubble + name label + pointer — mirrors the map marker exactly */}
      <div className="flex flex-col items-center" style={{ filter: "drop-shadow(0 3px 7px rgba(0,0,0,0.55))" }}>
        {/* Name pill */}
        {landmark && (
          <div className="mb-1 max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-white/20 bg-black/75 px-2 py-px text-center text-[9px] font-semibold leading-tight tracking-wide text-white">
            {landmark.name}
          </div>
        )}
        {/* Circular photo */}
        <div className="h-14 w-14 overflow-hidden rounded-full border-[3px] border-white bg-stone-800">
          {landmark?.photo ? (
            <img
              src={landmark.photo}
              alt={landmark.name}
              className="h-full w-full object-cover transition-opacity duration-300"
              crossOrigin="anonymous"
              draggable={false}
            />
          ) : landmark ? (
            /* OSM-only result — colored initial circle */
            <div
              className="flex h-full w-full items-center justify-center text-2xl font-bold text-white"
              style={{
                background: `hsl(${[...landmark.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360},55%,38%)`,
              }}
            >
              {(landmark.name[0] ?? "?").toUpperCase()}
            </div>
          ) : (
            /* No landmark at all — amber dot */
            <div className="flex h-full w-full items-center justify-center bg-amber-500">
              <span className="text-lg text-white">📍</span>
            </div>
          )}
        </div>
        {/* Pointer tip */}
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "9px solid transparent",
            borderRight: "9px solid transparent",
            borderTop: "13px solid white",
            marginTop: -2,
          }}
        />
      </div>
      {/* Countdown pill */}
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-md border text-sm font-bold tabular-nums transition-colors ${bg}`}
      >
        {resolving ? (
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-amber-300/40 border-t-amber-200" />
        ) : (
          remainingSec
        )}
      </div>
    </div>
  );
});

const BalanceBadge = memo(function BalanceBadge({
  balance,
  splash,
  onSplashDone,
}: {
  balance: number;
  splash: { from: number; to: number; delta: number; nonce: number } | null;
  onSplashDone: () => void;
}) {
  const isWin = (splash?.delta ?? 0) > 0;
  const animating = splash != null;
  /** Gold glow / coins only during the 1 s win animation, never after. */
  const showWinFx = animating && isWin;

  /** Animated rolling number — runs for both wins (up) and deductions (down). */
  const [rolling, setRolling] = useState<number>(balance);
  useEffect(() => {
    if (!splash || splash.from === splash.to) {
      setRolling(balance);
      return;
    }
    const fromVal = splash.from;
    const toVal = splash.to;
    const startMs = performance.now();
    const dur = splash.delta > 0 ? 700 : 350;
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - startMs) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setRolling(fromVal + (toVal - fromVal) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [splash, balance]);

  useEffect(() => {
    if (!splash) return;
    const timer = window.setTimeout(onSplashDone, 1000);
    return () => window.clearTimeout(timer);
  }, [splash, onSplashDone]);

  // 12 coin trajectories around the badge.
  const coins = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="pointer-events-none flex justify-end">
      <div
        className={[
          "relative overflow-hidden rounded-full border border-white/10 bg-black/75 px-2.5 py-1 text-xs font-medium tabular-nums text-white/85",
          showWinFx ? "scale-105" : "",
          "transition-transform duration-150",
        ].join(" ")}
      >
        {/* Coin burst — only during 1 s win animation */}
        {showWinFx ? (
          <>
            {coins.map((i) => {
              const angle = (i / coins.length) * Math.PI * 2;
              const dist = 28 + (i % 3) * 6;
              const dx = Math.cos(angle) * dist;
              const dy = Math.sin(angle) * dist - 6;
              return (
                <span
                  key={i}
                  aria-hidden
                  className="balance-coin pointer-events-none absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
                  style={{
                    background:
                      "radial-gradient(circle at 30% 30%, #fff7c2 0%, #fbbf24 55%, #b45309 100%)",
                    ["--cx" as string]: `${dx}px`,
                    ["--cy" as string]: `${dy}px`,
                    animationDelay: `${i * 30}ms`,
                  }}
                />
              );
            })}
          </>
        ) : null}

        <span className="relative z-10">
          ${fmtUsdWhole(animating && splash!.from !== splash!.to ? rolling : balance)}
        </span>

        <style jsx>{`
          .balance-coin {
            transform: translate3d(-50%, -50%, 0) scale(0.4);
            opacity: 0;
            animation: balance-coin 900ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
          }
          @keyframes balance-coin {
            0%   { transform: translate3d(-50%, -50%, 0) scale(0.4); opacity: 0; }
            15%  { opacity: 1; transform: translate3d(-50%, -50%, 0) scale(1.1); }
            70%  { opacity: 1; }
            100% {
              transform: translate3d(
                calc(-50% + var(--cx)),
                calc(-50% + var(--cy)),
                0
              ) scale(0.6);
              opacity: 0;
            }
          }
        `}</style>
      </div>
    </div>
  );
});


/**
 * Small north-up overview map shown in the top-left during a next_zone bet.
 * Fits the visible area to include both the driver's current position and
 * the destination so the viewer can see the full Google route at a glance.
 */
function RouteOverviewMap({
  routePoints,
  destination,
  destinationRoute,
}: {
  routePoints: Array<{ lat: number; lng: number }>;
  destination: { lat: number; lng: number; label?: string } | null;
  destinationRoute: Array<{ lat: number; lng: number }> | null;
}) {
  const last = routePoints[routePoints.length - 1];

  // Compute a bounding box that covers both current position and destination
  // with 20% padding, so the map auto-fits both points.
  const bounds = useMemo((): [[number, number], [number, number]] | null => {
    if (!last || !destination) return null;
    const minLat = Math.min(last.lat, destination.lat);
    const maxLat = Math.max(last.lat, destination.lat);
    const minLng = Math.min(last.lng, destination.lng);
    const maxLng = Math.max(last.lng, destination.lng);
    const padLat = Math.max((maxLat - minLat) * 0.22, 0.003);
    const padLng = Math.max((maxLng - minLng) * 0.22, 0.003);
    return [
      [minLat - padLat, minLng - padLng],
      [maxLat + padLat, maxLng + padLng],
    ];
  }, [last?.lat, last?.lng, destination?.lat, destination?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!last || !destination) return null;

  return (
    <div
      className="pointer-events-none fixed left-3 top-[calc(33dvh+0.5rem)] z-[61] overflow-hidden rounded-xl border border-white/20 shadow-xl"
      style={{ width: 88, height: 220 }}
    >
      <LiveMap
        routePoints={routePoints}
        className="h-full w-full"
        interactive={false}
        audienceRole="viewer"
        showCourseArrow={true}
        rotateWithHeading={true}
        followMode={true}
        tileOpacity={0.85}
        destination={destination}
        destinationRoute={destinationRoute}
        viewerFollowLatLngBounds={bounds}
        viewerFollowBoundsMinZoom={null}
        viewerTargetWidthMeters={500}
        viewerZoomRuleKey={`route-overview:${destination.lat}:${destination.lng}`}
      />
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

/** What to show in the "settling" chip for each market type. */
function settlingChipText(marketType: string): string {
  switch (marketType) {
    case "next_turn":        return "Waiting for turn…";
    case "next_zone":        return "Waiting for grid move…";
    case "city_grid":        return "Waiting for driver to move…";
    case "straight_streak":  return "Counting straights…";
    case "zone_exit_time":   return "Waiting for zone exit…";
    default:                 return "Resolving…";
  }
}

function routeToPinFromMeta(meta: Record<string, unknown> | null): CompactLatLng[] | null {
  const raw = meta?.routeToPin;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  return raw as CompactLatLng[];
}

function parseNextStepMarketMeta(
  market: NonNullable<LiveFeedRow["currentMarket"]>,
): { estimatedSec: number; opensAtMs: number } | null {
  if (market.marketType !== "next_step") return null;
  const rawT = market.meta?.estimatedSec;
  const estimatedSec =
    typeof rawT === "number"
      ? rawT
      : typeof rawT === "string"
        ? Number(rawT)
        : Number.NaN;
  if (!Number.isFinite(estimatedSec) || estimatedSec <= 0) return null;
  const opensAtMs = Date.parse(market.opensAt);
  if (!Number.isFinite(opensAtMs)) return null;
  return { estimatedSec: Math.round(estimatedSec), opensAtMs };
}

function parseZoneExitMarketMeta(
  market: NonNullable<LiveFeedRow["currentMarket"]>,
): {
  estimatedSec: number;
  startCellKey: string | null;
  opensAtMs: number;
} | null {
  if (market.marketType !== "zone_exit_time") return null;
  const rawT = market.meta?.estimatedSec;
  const estimatedSec =
    typeof rawT === "number"
      ? rawT
      : typeof rawT === "string"
        ? Number(rawT)
        : Number.NaN;
  if (!Number.isFinite(estimatedSec) || estimatedSec <= 0) return null;
  const cellRaw = market.meta?.cellKey;
  const startCellKey =
    typeof cellRaw === "string" && cellRaw.length > 0 ? cellRaw : null;
  const opensAtMs = Date.parse(market.opensAt);
  if (!Number.isFinite(opensAtMs)) return null;
  return {
    estimatedSec: Math.round(estimatedSec),
    startCellKey,
    opensAtMs,
  };
}

function estimatedZoneSecondsRemaining(
  market: NonNullable<LiveFeedRow["currentMarket"]>,
  nowMs: number,
): number | null {
  const parsed = parseZoneExitMarketMeta(market);
  if (!parsed) return null;
  return Math.max(
    0,
    parsed.estimatedSec - Math.floor((nowMs - parsed.opensAtMs) / 1000),
  );
}

/**
 * Returns `true` once (and forever after) `deadlineMs` is reached.
 * Uses a single targeted `setTimeout` — no polling, no repeated re-renders.
 * Safe for SSR: initialises to `false` on the server; the `useEffect` corrects
 * it on the first client paint.
 */
function useDeadlinePassed(deadlineMs: number | null): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    if (deadlineMs == null) {
      setPassed(false);
      return;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      setPassed(true);
      return;
    }
    setPassed(false);
    const id = window.setTimeout(() => setPassed(true), remaining);
    return () => window.clearTimeout(id);
  }, [deadlineMs]);
  return passed;
}

function zoneTimeOptionLabel(optionId: string, remainingSec: number | null): string | null {
  if (remainingSec == null) return null;
  const sec = Math.round(remainingSec);
  if (optionId === "exit_under") return `< ${sec} sec`;
  if (optionId === "exit_at") return `= ${sec} sec`;
  if (optionId === "exit_over") return `> ${sec} sec`;
  return null;
}

/** Seconds before lock when the bet sheet turns red. */
const BET_URGENCY_RED_SEC = 3;
/** Seconds before lock when yellow warning starts (between calm and red). */
const BET_URGENCY_YELLOW_SEC = 5;

type BetSheetUrgencyPhase = "calm" | "warn" | "urgent";

function betSheetUrgencyPhase(secondsLeft: number): BetSheetUrgencyPhase {
  if (secondsLeft <= 0 || secondsLeft === -1) return "urgent";
  if (secondsLeft <= BET_URGENCY_RED_SEC) return "urgent";
  if (secondsLeft <= BET_URGENCY_YELLOW_SEC) return "warn";
  return "calm";
}

function betSheetUrgencyStyle(secondsLeft: number): {
  backgroundColor: string;
  borderColor: string;
} {
  switch (betSheetUrgencyPhase(secondsLeft)) {
    case "calm":
      return {
        backgroundColor: "rgba(22, 36, 26, 0.97)",
        borderColor: "rgba(255, 255, 255, 0.18)",
      };
    case "warn":
      return {
        backgroundColor: "rgba(42, 38, 16, 0.97)",
        borderColor: "rgba(251, 191, 36, 0.35)",
      };
    case "urgent":
      return {
        backgroundColor: "rgba(96, 10, 10, 0.98)",
        borderColor: "rgba(248, 113, 113, 0.5)",
      };
  }
}

function useLiveReferenceSec(
  reference: { opensAtMs: number; estimatedSec: number } | null | undefined,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!reference) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [reference?.opensAtMs, reference?.estimatedSec]);
  if (!reference) return null;
  return Math.max(
    0,
    reference.estimatedSec - Math.floor((now - reference.opensAtMs) / 1000),
  );
}

function parseStraightStreakMeta(
  market: NonNullable<LiveFeedRow["currentMarket"]>,
): number | null {
  if (market.marketType !== "straight_streak") return null;
  const raw = market.meta?.expectedStreak;
  if (typeof raw === "number" && raw > 0) return Math.round(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function betFeedHeadline(
  marketType: string,
  refSec: number | null,
  title?: string | null,
  refStreak: number | null = null,
): string {
  const sec = refSec != null ? Math.max(0, Math.round(refSec)) : null;
  switch (marketType) {
    case "next_step":
      return sec != null ? `To pin · ${sec}s` : "To pin";
    case "zone_exit_time":
      return sec != null ? `Zone exit · ${sec}s` : "Zone exit";
    case "next_turn":
      return "Next turn";
    case "straight_streak":
      return refStreak != null
        ? `${refStreak} straight crosses`
        : "Straight crosses";
    case "city_grid":
      return "Pick grid square";
    case "next_zone":
      return "Next zone";
    default: {
      const t = (title ?? "").trim();
      if (!t) return "Live bet";
      if (sec != null) return `${t} · ${sec}s`;
      return t.length <= 28 ? t : `${t.slice(0, 26)}…`;
    }
  }
}

function shortOptionLabel(
  opt: { id: string; label: string; shortLabel?: string },
  mode: "turn" | "zoneTime" | "compare" | "streak" | "default",
  refSec: number | null,
  refStreak: number | null = null,
): string {
  if (mode === "turn") {
    if (opt.id === "left") return "←";
    if (opt.id === "right") return "→";
    return "↑";
  }
  if (mode === "streak") {
    if (opt.id === "streak_under" || opt.id.includes("under")) return "<";
    if (opt.id === "streak_at" || opt.id.includes("_at")) return "=";
    if (opt.id === "streak_over" || opt.id.includes("over")) return ">";
    return opt.shortLabel ?? opt.label;
  }
  if (mode === "zoneTime") {
    if (opt.id === "exit_under" || opt.id === "step_under" || opt.id.startsWith("lt")) return "<";
    if (opt.id === "exit_at" || opt.id === "step_at" || opt.id.startsWith("eq")) return "=";
    if (opt.id === "exit_over" || opt.id === "step_over" || opt.id.startsWith("gt")) return ">";
  }
  if (mode === "compare") {
    if (opt.id.includes("under") || opt.id.startsWith("lt")) return "<";
    if (opt.id.includes("over") || opt.id.startsWith("gt")) return ">";
    if (opt.id.includes("at") || opt.id.startsWith("eq")) return "=";
  }
  const raw = opt.shortLabel ?? opt.label;
  if (raw.length <= 12) return raw;
  return raw.slice(0, 11) + "…";
}

/** Full-width stacked bet cards — fixed slots so cards never jump when one leaves. */
function BetFeedStack({
  entries,
  children,
}: {
  entries: BetFeedEntry[];
  children: (entry: BetFeedEntry) => ReactNode;
}) {
  const maxSlot = Math.max(-1, ...entries.map((e) => e.stackSlot));
  if (maxSlot < 0) return null;
  const slotCount = maxSlot + 1;
  const reservePx =
    slotCount > 0 ? slotCount * BET_FEED_EST_CARD_PX + Math.max(0, slotCount - 1) * 2 : 0;

  return (
    <div
      className="bet-feed-stack pointer-events-none fixed inset-x-0 bottom-0 z-[200] flex flex-col justify-end gap-0.5 pb-[env(safe-area-inset-bottom,0px)]"
      style={{ minHeight: reservePx > 0 ? reservePx : undefined }}
    >
      {Array.from({ length: slotCount }, (_, i) => maxSlot - i).map((slot) => {
        const entry = entries.find((e) => e.stackSlot === slot);
        if (entry) return children(entry);
        return (
          <BetFeedSlotPlaceholder
            key={`bet-feed-slot-${slot}`}
            stackSlot={slot}
          />
        );
      })}
    </div>
  );
}

function BetFeedSlotPlaceholder({ stackSlot }: { stackSlot: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none w-full shrink-0"
      style={{
        minHeight: BET_FEED_EST_CARD_PX,
        marginLeft: betFeedStackInsetPx(stackSlot),
        marginRight: betFeedStackInsetPx(stackSlot),
      }}
    />
  );
}

const BetFeedCard = memo(function BetFeedCard({
  stackSlot = 0,
  maxStackSlot = 0,
  marketType,
  title,
  betPlaced = false,
  referenceCountdown = null,
  referenceStreak = null,
  selectionDetail,
  marketOptions,
  selectedOptionId,
  onSelectOption,
  bettingClosed,
  bettingPending = false,
  isPlacing,
  error,
  locksAt,
  onClose: _onClose,
  onPlaceBet,
  gridMode = false,
  turnMode = false,
  oneTapOptionBet = false,
}: {
  stackSlot?: number;
  maxStackSlot?: number;
  marketType: string;
  title?: string | null;
  betPlaced?: boolean;
  referenceCountdown?: { opensAtMs: number; estimatedSec: number } | null;
  referenceStreak?: number | null;
  selectionDetail: string | null;
  marketOptions: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  bettingClosed: boolean;
  bettingPending?: boolean;
  isPlacing: boolean;
  error: string | null;
  locksAt: string;
  onClose: () => void;
  onPlaceBet: () => Promise<void>;
  gridMode?: boolean;
  turnMode?: boolean;
  oneTapOptionBet?: boolean;
}) {
  const { secondsLeft } = useCountdown(locksAt);
  const sheetStyle = betSheetUrgencyStyle(secondsLeft);
  const refSec = useLiveReferenceSec(referenceCountdown);
  const headline = betFeedHeadline(marketType, refSec, title, referenceStreak);
  const sorted = [...marketOptions].sort((a, b) => a.displayOrder - b.displayOrder);
  const streakMode =
    marketType === "straight_streak" ||
    sorted.some((o) => o.id.startsWith("streak_"));
  const zoneTimeMode =
    !streakMode &&
    refSec != null &&
    (marketType === "zone_exit_time" ||
      marketType === "next_step" ||
      sorted.some((o) => /exit_|step_/.test(o.id)));
  const zoneTimeOptions = zoneTimeMode
    ? (["exit_under", "exit_at", "exit_over", "step_under", "step_at", "step_over"] as const)
        .map((id) => sorted.find((o) => o.id === id))
        .filter((o): o is NonNullable<typeof o> => o != null)
    : [];
  const streakOptions = streakMode
    ? (["streak_under", "streak_at", "streak_over"] as const)
        .map((id) => sorted.find((o) => o.id === id))
        .filter((o): o is NonNullable<typeof o> => o != null)
    : [];
  const turnOptions = turnMode
    ? ["left", "straight", "right"]
        .map((id) => sorted.find((o) => o.id === id))
        .filter((o): o is NonNullable<typeof o> => o != null)
    : [];
  const compareMode =
    !gridMode &&
    !turnMode &&
    !zoneTimeMode &&
    !streakMode &&
    sorted.length <= 3 &&
    sorted.some((o) => /under|over|at|lt|gt|eq/i.test(o.id));

  const optionBtnClass = (active: boolean, disabled: boolean) =>
    [
      "flex h-10 min-w-[50px] items-center justify-center rounded-lg px-3.5 text-base font-bold leading-none transition active:scale-[0.97]",
      active
        ? "bg-white text-black shadow-md ring-2 ring-white/25"
        : disabled
          ? "bg-white/5 text-white/30"
          : "bg-white/15 text-white hover:bg-white/25",
    ].join(" ");

  const renderOptionButtons = () => {
    if (gridMode) return null;
    const mkBtn = (opt: { id: string; label: string; shortLabel?: string }, label: string) => (
      <button
        key={opt.id}
        type="button"
        onClick={() => void onSelectOption(opt.id)}
        disabled={bettingClosed || isPlacing}
        className={optionBtnClass(selectedOptionId === opt.id, bettingClosed || isPlacing)}
      >
        {label}
      </button>
    );
    if (zoneTimeMode) {
      return zoneTimeOptions.map((opt) =>
        mkBtn(opt, shortOptionLabel(opt, "zoneTime", refSec)),
      );
    }
    if (streakMode) {
      return streakOptions.map((opt) =>
        mkBtn(opt, shortOptionLabel(opt, "streak", refSec, referenceStreak)),
      );
    }
    if (turnMode) {
      return turnOptions.map((opt) =>
        mkBtn(opt, shortOptionLabel(opt, "turn", refSec)),
      );
    }
    if (compareMode) {
      return sorted.map((opt) =>
        mkBtn(opt, shortOptionLabel(opt, "compare", refSec)),
      );
    }
    return sorted.map((opt) =>
      mkBtn(opt, shortOptionLabel(opt, "default", refSec)),
    );
  };

  return (
    <div
      className="bet-feed-enter pointer-events-auto w-full shrink-0"
      style={{
        minHeight: BET_FEED_EST_CARD_PX,
        marginLeft: betFeedStackInsetPx(stackSlot),
        marginRight: betFeedStackInsetPx(stackSlot),
        zIndex: 200 + (maxStackSlot - stackSlot),
      }}
    >
      <div
        className="overflow-hidden border-t"
        style={{
          backgroundColor: sheetStyle.backgroundColor,
          borderColor: sheetStyle.borderColor,
          transition: "background-color 0.3s ease, border-color 0.3s ease",
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <p className="min-w-0 flex-1 truncate text-sm font-bold leading-snug tabular-nums text-white">
            {headline}
          </p>

          <FeedTimer locksAt={locksAt} />

          {betPlaced ? (
            <span className="shrink-0 rounded-md bg-emerald-600/80 px-2.5 py-1.5 text-xs font-bold text-white">
              ✓ Placed
            </span>
          ) : gridMode ? (
            <>
              <span className="max-w-[28%] shrink truncate text-[11px] text-white/60">
                {selectionDetail ?? "Tap map"}
              </span>
              {!oneTapOptionBet ? (
                <button
                  type="button"
                  disabled={bettingClosed || !selectedOptionId || isPlacing}
                  onClick={() => void onPlaceBet()}
                  className="h-10 shrink-0 rounded-lg bg-red-500 px-4 text-sm font-bold text-white disabled:bg-white/10 disabled:text-white/35"
                >
                  {isPlacing ? "…" : bettingClosed ? "Closed" : "Bet"}
                </button>
              ) : null}
            </>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              {renderOptionButtons()}
            </div>
          )}
        </div>

        {error ? (
          <div className="truncate px-3 pb-2 text-xs leading-snug text-red-300">{error}</div>
        ) : null}
      </div>
    </div>
  );
});

const FeedTimer = memo(function FeedTimer({ locksAt }: { locksAt: string }) {
  const { secondsLeft } = useCountdown(locksAt);
  if (secondsLeft === -1) return null;
  const locked = secondsLeft <= 0;
  const urgent = !locked && secondsLeft <= BET_URGENCY_RED_SEC;
  const warn = !locked && !urgent && secondsLeft <= BET_URGENCY_YELLOW_SEC;
  return (
    <span
      className={`shrink-0 rounded px-1 py-px text-[10px] font-semibold tabular-nums leading-none ${
        locked || urgent
          ? "bg-red-700/80 text-red-50"
          : warn
            ? "bg-amber-500/30 text-amber-100"
            : "text-white/45"
      }`}
      title="Seconds left to place bet"
    >
      {locked ? "0s" : `${secondsLeft}s`}
    </span>
  );
});
