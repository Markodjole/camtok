"use client";

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { RoutePoint } from "@/actions/live-feed";
import { metersBetween } from "@/lib/live/routing/geometry";
import {
  GOOGLE_TRAFFIC_COLORS,
  trafficSegmentLatLngs,
} from "@/lib/live/routing/googleDirections";

function escapeDestinationLabel(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LiveMapProps {
  routePoints: RoutePoint[];
  className?: string;
  interactive?: boolean;
  /** 0-1, OSM base */
  tileOpacity?: number;
  mapCaption?: string;
  turnHint?: string | null;
  turnHintEtaSec?: number | null;
  turnHintDistanceM?: number | null;
  audienceRole?: "streamer" | "viewer";
  showCourseArrow?: boolean;
  transportMode?: string;
  /**
   * Rotate map so "forward" is always toward screen top based on heading.
   * Useful for viewer controls where left/right should match streamer POV.
   */
  rotateWithHeading?: boolean;
  zones?: Array<{
    id: string;
    name: string;
    kind?: string;
    color?: string;
    polygon: Array<{ lat: number; lng: number }>;
    isActive?: boolean;
  }>;
  checkpoints?: Array<{
    id: string;
    name: string;
    kind?: string;
    lat: number;
    lng: number;
    isActive?: boolean;
  }>;
  selectedZoneId?: string | null;
  currentZoneId?: string | null;
  selectedCheckpointId?: string | null;
  showZones?: boolean;
  showCheckpoints?: boolean;
  onZoneSelect?: (zoneId: string | null) => void;
  onCheckpointSelect?: (checkpointId: string | null) => void;
  /**
   * When true the map auto-centers on the latest route point and applies
   * heading rotation if `rotateWithHeading` is enabled. When false the map
   * preserves the user's current center/zoom without any auto-correction.
   */
  followMode?: boolean;
  /** Called when the user manually pans the map (dragstart) while interactive. */
  onUserInteract?: () => void;
  turnTarget?: {
    lat: number;
    lng: number;
    kind?: "left" | "right" | "straight";
    label?: string;
  } | null;
  /**
   * Independent orange pin for an active `next_step` (time-to-pin) bet.
   * Persists as long as the bet is alive — unaffected by zone market changes.
   */
  stepPin?: { lat: number; lng: number } | null;
  /**
   * Up to 3 AI-chosen pins ahead of the driver, ordered by road distance.
   * Each pin is a crossroad the vehicle will physically reach; the first
   * one is the next decision point. Pins persist until the vehicle passes
   * them, so they are stable from the moment they appear.
   */
  driverPins?: Array<{ lat: number; lng: number; id?: number | string; distanceMeters?: number }> | null;
  /**
   * Already-trimmed 50 m road segment ending at the first pin. The backend
   * does the slicing so the client just renders this as-is.
   */
  approachLine?: Array<{ lat: number; lng: number }> | null;
  /**
   * Lifecycle state of the current AI decision point. Controls whether the
   * map draws a blue marker only (bets open), a full rail (bets closed /
   * turn pending), or nothing (no active decision).
   *
   *  - "none"    → no active decision; map shows only the normal green trail.
   *  - "pending" → decision chosen, bets open: blue dot at the crossroad, no rail.
   *  - "active"  → bets closed, turn coming: rail (driver → checkpoint) + dot.
   */
  railPhase?: "none" | "pending" | "active";
  /**
   * Driver-chosen destination — rendered as a red pin with an optional
   * label tooltip. Independent of the AI decision pin (which is blue).
   */
  destination?: {
    lat: number;
    lng: number;
    label?: string;
  } | null;
  /**
   * Google-suggested route polyline from current position to destination.
   * Server recomputes whenever the driver deviates more than ~40 m.
   */
  destinationRoute?: Array<{ lat: number; lng: number }> | null;
  /**
   * Traffic speed per polyline segment, from Google Routes TRAFFIC_ON_POLYLINE.
   * Each entry covers [startIndex, endIndex] inclusive into `destinationRoute`.
   */
  destinationRouteTraffic?: Array<{
    startIndex: number;
    endIndex: number;
    speed: "NORMAL" | "SLOW" | "TRAFFIC_JAM";
  }> | null;
  /** UI label for destination route badge. */
  destinationRouteLabel?: string | null;
  /** Short labels derived from `driving_route_style` (shown to viewers & streamer). */
  driverRouteBadges?: string[] | null;
  /** Nearby traffic cameras — shown as pins on the map. */
  trafficCameras?: Array<{
    id: string;
    lat: number;
    lng: number;
    name: string;
    direction: string | null;
    isNearest: boolean;
  }> | null;
  /** ID of the camera whose feed is currently showing — drives the active pin highlight. */
  activeCameraId?: string | null;
  /** Pixels to inset from the left edge — used to push badges clear of the traffic camera panel. */
  leftInsetPx?: number;
  /**
   * Viewer + followMode: fixed zoom when not using `viewerFollowLatLngBounds`.
   */
  viewerFollowZoom?: number | null;
  /**
   * Viewer + followMode: fit map to this WGS84 bounds when set
   * `[[southLat, westLng], [northLat, eastLng]]` (Leaflet order). Overrides
   * `viewerFollowZoom` for framing (zoom is taken from `fitBounds`).
   */
  viewerFollowLatLngBounds?: [[number, number], [number, number]] | null;
  /**
   * With `viewerFollowLatLngBounds`, lower bound for zoom (larger = closer).
   * Stops city-grid fitBounds from zooming far out; may clip bounds edges.
   */
  viewerFollowBoundsMinZoom?: number | null;
  /**
   * Viewer + followMode: desired VISIBLE width in meters. Replaces the bounds/zoom
   * system for ongoing zoom control. Cleared user overrides when it changes (bet change).
   * - 125 m  → next_turn (tight turn view)
   * - 250 m  → default / all other bets
   * - 1000 m → next_zone (show surrounding cells)
   */
  viewerTargetWidthMeters?: number | null;
  /** Changes when bet framing rules change; clears any latched user zoom override. */
  viewerZoomRuleKey?: string | null;
  /**
   * Visible layout width in CSS px (e.g. `window.innerWidth` on mobile). When the
   * map wrapper is oversized for heading rotation, Leaflet `getSize().x` is much
   * larger than what the user sees — pass this so width→zoom matches the screen.
   */
  layoutViewportWidthPx?: number | null;
  /** Muted polygons for engine-highlighted zone overlays. */
  zonesVisualStyle?: "default" | "muted" | "pick_zone";
  /** Soft pulse on the step pin while a time-to-pin bet popup is open. */
  stepPinPulse?: boolean;
  /** Pulse the next-turn pin while a turn bet popup is open. */
  turnPinPulse?: boolean;
  /** Zone cell ids → pulse style (current cell vs neighbouring pick targets). */
  zonePulseById?: Record<string, "current" | `neighbor-${number}`>;
  /** Called once when sustained FPS < 30 — parent can disable rotation / reduce work. */
  onPerformanceDegrade?: () => void;
  /** Extra zoom levels (e.g. +1 for active time-to-pin bet on two-wheeled). */
  zoomLevelBonus?: number;
};

const C = {
  streamer: { line: "#2563eb", lineOp: 0.35, fill: "#4ade80", r: 7 },
  viewer: { line: "#2563eb", lineOp: 0.35, fill: "#4ade80", r: 7 },
};

const NEIGHBOR_PULSE_STROKE = [
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#38bdf8",
  "#fb923c",
  "#facc15",
  "#e879f9",
  "#2dd4bf",
];

function zonePulseClassName(
  kind: "current" | `neighbor-${number}` | undefined,
): string | undefined {
  if (!kind) return undefined;
  if (kind === "current") return "camtok-zone-pulse-current";
  const m = /^neighbor-(\d+)$/.exec(kind);
  if (!m) return "camtok-zone-pulse-neighbor";
  return `camtok-zone-pulse-neighbor camtok-zone-pulse-neighbor-${Number(m[1]) % 8}`;
}

function neighborPulseIndex(
  kind: "current" | `neighbor-${number}` | undefined,
): number | null {
  if (!kind || kind === "current") return null;
  const m = /^neighbor-(\d+)$/.exec(kind);
  return m ? Number(m[1]) % 8 : null;
}

function headingDivIcon(
  L: { divIcon: (o: object) => import("leaflet").DivIcon },
  deg: number,
  _streamer: boolean,
) {
  const m = 24;
  const c = "#4ade80";
  const html = `<div style="width:52px;height:52px;display:flex;align-items:center;justify-content:center;transform:rotate(${deg}deg)">
    <div style="width:0;height:0;border-left:${m * 0.35}px solid transparent;border-right:${m * 0.35}px solid transparent;
      border-bottom:${m * 0.8}px solid ${c};filter:drop-shadow(0 0 2px #000)"></div></div>`;
  return L.divIcon({ html, className: "camtok-h", iconSize: [52, 52], iconAnchor: [26, 26] });
}

const TWO_WHEELED_MAP_MODES = new Set(["bike", "scooter", "motorcycle", "cycle"]);

/** Extra Leaflet zoom levels applied to two-wheeled baseline (bike/scooter/motorcycle). */
export const TWO_WHEELED_ZOOM_LEVEL_OFFSET = 1;

const MAP_BASE_MAX_ZOOM = 20;

export function isTwoWheeled(mode?: string): boolean {
  if (!mode) return false;
  const m = mode.toLowerCase();
  return Array.from(TWO_WHEELED_MAP_MODES).some((k) => m.includes(k));
}

/** Baseline zoom offset for transport mode — bet/situation rules add on top of this. */
export function mapZoomLevelOffset(mode?: string): number {
  return isTwoWheeled(mode) ? TWO_WHEELED_ZOOM_LEVEL_OFFSET : 0;
}

/** Max Leaflet zoom (tile layer + clamp), with optional pin-bet bonus level. */
export function mapMaxZoom(levelBonus = 0): number {
  return MAP_BASE_MAX_ZOOM + Math.max(0, levelBonus);
}

/**
 * Scale a visible-width target (m) by the mode baseline offset.
 * One zoom level ≈ half the width on screen.
 */
export function zoomWidthForLevelOffset(baseWidthM: number, levelOffset: number): number {
  if (levelOffset <= 0) return baseWidthM;
  return baseWidthM / Math.pow(2, levelOffset);
}

/** MapTiler style slug to use per vehicle class. */
export function mapTileStyle(mode?: string): "openstreetmap" | "bright-v2" {
  // OSM raster: natural colours + footpaths, alleys, cycleways (best for bikes).
  return isTwoWheeled(mode) ? "openstreetmap" : "bright-v2";
}

/** Stadia fallback when MapTiler key is absent. */
export function mapTileFallbackUrl(mode?: string): string {
  return isTwoWheeled(mode)
    ? "https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}{r}.png"
    : "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png";
}

export function mapProfile(
  mode?: string,
  role: "streamer" | "viewer" = "viewer",
): {
  zoom: number;
  lineWeight: number;
  showSpeed: boolean;
  speedUnit: "kmh" | "none";
} {
  const m = (mode ?? "").toLowerCase();
  // Keep viewer viewpoint identical to driver viewpoint so motion/turning
  // perception matches exactly between roles.
  const bonus = 1;
  if (m.includes("car") || m.includes("drive")) {
    return { zoom: 16 + bonus, lineWeight: 4, showSpeed: true, speedUnit: "kmh" };
  }
  if (isTwoWheeled(mode)) {
    // Bikes/scooters/motos: closer zoom for alleys, cycleways, and shortcuts.
    return { zoom: 19 + bonus, lineWeight: 4, showSpeed: true, speedUnit: "kmh" };
  }
  // walking / default
  return { zoom: 17 + bonus, lineWeight: 3, showSpeed: false, speedUnit: "none" };
}

function normalizeAngleDeg(deg: number): number {
  let v = deg;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

/** Viewer bearing blend toward GPS heading (~Google Maps navigation feel). */
const VIEWER_MAP_ROTATION_TAU_SEC = 2;

/** One-shot zoom transition when visible width tier changes (ms). */
const VIEWER_ZOOM_ANIM_MS = 2400;

/**
 * Leaflet reloads OSM tiles on every `setView` — cap recenters (~15 Hz) so the map
 * does not stutter (LCP / stop-go on `leaflet-tile`).
 */
const MAP_VIEW_SYNC_MIN_MS = 150; // was 66 (~15 Hz); 150 ms caps map recenters to ~6.7 Hz
const MAP_VIEW_SYNC_MIN_MOVE_M = 0.85;
const MAP_VIEW_SYNC_MIN_ZOOM_DELTA = 0.035;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function zoomForVisibleWidthM(
  lat: number,
  viewportW: number,
  widthM: number,
  maxZ = MAP_BASE_MAX_ZOOM,
): number {
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const z = Math.log2((viewportW * 40075017 * cosLat) / (256 * widthM));
  return Math.max(12, Math.min(maxZ, z));
}

/** With `viewerFollowLatLngBounds`, never go wider than this (higher = closer). */
const VIEWER_FOLLOW_BOUNDS_ZOOM_FLOOR = 14;

/**
 * After `getBoundsZoom`, nudge **in** (viewer only) — fitBounds alone kept the
 * camera too loose for navigation-style follow.
 */
/** Extra zoom-out after bounds fit (~1 Leaflet level — lower z = wider). */
const VIEWER_FIT_BOUNDS_ZOOM_BIAS = -0.85;

/**
 * Added to `mapProfile().zoom` for viewers only (streamer unchanged).
 * Modest extra so spectators sit a little closer than driver baseline.
 */
const VIEWER_FOLLOW_ZOOM_EXTRA = 0.3;

/** Slower `setView` / zoom ramp — **city grid bounds framing only** (see `smoothGridFramingRef`). */
const MAP_SET_VIEW_DURATION_SEC = 1.35;
const MAP_SET_VIEW_EASE_LINEARITY = 0.26;

/** True Δt between snapshots (viewer DB trail); avoids bogus speed when poll cadence ≠ GPS cadence. */
function motionSegmentDtSec(
  prev: RoutePoint | null,
  last: RoutePoint,
  fallbackSec: number,
): number {
  if (!prev) return fallbackSec;
  const ta = prev.recordedAt ? Date.parse(prev.recordedAt) : NaN;
  const tb = last.recordedAt ? Date.parse(last.recordedAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb > ta) {
    return Math.min(120, Math.max(0.08, (tb - ta) / 1000));
  }
  return fallbackSec;
}

function LiveMapInner({
  routePoints,
  className = "",
  interactive = false,
  tileOpacity = 0.36,
  mapCaption,
  turnHint,
  turnHintEtaSec,
  turnHintDistanceM,
  audienceRole = "viewer",
  showCourseArrow = true,
  transportMode,
  rotateWithHeading = false,
  zones = [],
  checkpoints = [],
  selectedZoneId = null,
  currentZoneId = null,
  selectedCheckpointId = null,
  showZones = true,
  showCheckpoints = true,
  onZoneSelect,
  onCheckpointSelect,
  followMode = true,
  onUserInteract,
  turnTarget = null,
  stepPin = null,
  driverPins = null,
  approachLine = null,
  railPhase = "none",
  destination = null,
  destinationRoute = null,
  destinationRouteTraffic = null,
  destinationRouteLabel = "Google suggested route",
  driverRouteBadges = null,
  trafficCameras = null,
  activeCameraId = null,
  leftInsetPx = 0,
  viewerFollowZoom = null,
  viewerFollowLatLngBounds = null,
  viewerFollowBoundsMinZoom = null,
  viewerTargetWidthMeters = null,
  viewerZoomRuleKey = null,
  layoutViewportWidthPx = null,
  zonesVisualStyle = "default" as "default" | "muted" | "pick_zone",
  stepPinPulse = false,
  turnPinPulse = false,
  zonePulseById,
  onPerformanceDegrade,
  zoomLevelBonus = 0,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").TileLayer | null>(null);
  const plRef = useRef<import("leaflet").Polyline | null>(null);
  const dotRef = useRef<import("leaflet").CircleMarker | null>(null);
  const arRef = useRef<import("leaflet").Marker | null>(null);
  const zoneLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const checkpointLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const turnLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const railLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const stepPinLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const destLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const camLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const hasAppliedInitialZoomRef = useRef(false);
  const onUserInteractRef = useRef<(() => void) | undefined>(undefined);
  const motionRafRef = useRef<number | null>(null);
  const lastGpsAtMsRef = useRef<number | null>(null);
  /** Viewer-only: polls are sparse references — integrate smoothed °/s instead of snapping each poll. */
  const viewerSmoothRafRef = useRef<number | null>(null);
  const viewerPollTargetRef = useRef<{ lat: number; lng: number }>({
    lat: 0,
    lng: 0,
  });
  const viewerVelSmoothedRef = useRef<{ vLat: number; vLng: number }>({
    vLat: 0,
    vLng: 0,
  });
  const viewerPoseVelRef = useRef<{ vLat: number; vLng: number }>({
    vLat: 0,
    vLng: 0,
  });
  const viewerPoseSmoothedRef = useRef<{ lat: number; lng: number } | null>(
    null,
  );
  const viewerLastPollTsRef = useRef<number>(0);
  const viewerLoopLastTsRef = useRef<number>(0);
  const routePointsLenRef = useRef(0);
  const followModeRef = useRef(followMode);
  const viewerFollowZoomRef = useRef<number | null>(null);
  /** Zoom implied by last `fitBounds` when `viewerFollowLatLngBounds` is used. */
  const viewerBoundsZoomRef = useRef<number | null>(null);
  /** Viewer: when not using grid bounds, keep zoom at least this high if a turn pin is shown. */
  const viewerTurnNavZoomRef = useRef<number | null>(null);
  /** Grid city bounds framing uses eased zoom; turn/directional bets keep legacy snap zoom. */
  const smoothGridFramingRef = useRef(false);
  /** Width-based zoom: desired visible width in metres (updated each render). */
  const viewerTargetWidthRef = useRef<number>(250);
  /** Set by user zoom events; cleared when viewerTargetWidthMeters prop changes. */
  const userZoomOverrideRef = useRef<number | null>(null);
  /** Single continuous zoom transition (one ease curve, no staged blends). */
  const viewerZoomAnimRef = useRef<{
    fromZ: number;
    toZ: number;
    startMs: number;
    durationMs: number;
  } | null>(null);
  const viewerZoomAnimQueuedWidthRef = useRef<number | null>(null);
  const viewerTargetWidthPrevRef = useRef<number | null>(null);
  const smoothHeadingRef = useRef<number>(0);
  /** CSS wrapper rotation target (degrees); `-vehicleHeading`. Viewer RAF eases toward this. */
  const viewerMapRotationTargetRef = useRef<number>(0);
  const rotateWithHeadingRef = useRef(false);
  const viewerTurnPinRef = useRef<{ lat: number; lng: number } | null>(null);
  /** Ref-shadowed driverPins — lets the viewer RAF loop read the latest value
   *  without being a dep, preventing RAF restarts every 700 ms. */
  const driverPinsRef = useRef(driverPins);
  useEffect(() => { driverPinsRef.current = driverPins; }, [driverPins]);
  const rotationShellRef = useRef<HTMLDivElement | null>(null);
  /**
   * Destination pin elements that must be counter-rotated when the map shell
   * rotates.  Populated once when the destination layer is rebuilt; avoids a
   * querySelectorAll on every RAF frame.
   */
  const destFlatNodesRef = useRef<HTMLElement[]>([]);
  /** Landmark pin flat nodes — counter-rotated the same way as destination labels. */
  const landmarkFlatNodesRef = useRef<HTMLElement[]>([]);
  /** Last rendered heading for the course arrow — skip setIcon when unchanged. */
  const arrowLastHeadingRef = useRef<number | null>(null);
  /**
   * Fingerprint of the last turn/rail render: `"lat,lng|approachLen"`.
   * Lets us skip the clearLayers + recreate cycle when the pin position
   * and approach line haven't actually changed between 700 ms polls.
   */
  const turnLayerFingerprintRef = useRef<string>("");
  const lastMapViewSyncRef = useRef({
    atMs: 0,
    lat: 0,
    lng: 0,
    z: 0,
  });
  const [mapReady, setMapReady] = useState(0);
  const rotationDegRef = useRef(0);

  const applyMapShellRotation = (deg: number) => {
    rotationDegRef.current = deg;
    const shell = rotationShellRef.current;
    if (shell) {
      shell.style.transform = `rotate(${deg}deg)`;
    }
    // Counter-rotate destination pin labels and landmark pins so they stay
    // screen-upright regardless of map rotation.
    const flatDeg = -deg;
    for (const node of destFlatNodesRef.current) {
      node.style.transform = `rotate(${flatDeg}deg)`;
    }
    for (const node of landmarkFlatNodesRef.current) {
      node.style.transform = `rotate(${flatDeg}deg)`;
    }
  };

  const syncMapViewIfNeeded = (
    m: import("leaflet").Map,
    center: { lat: number; lng: number },
    z: number,
    force = false,
  ) => {
    const nowMs = performance.now();
    const prev = lastMapViewSyncRef.current;
    const elapsed = nowMs - prev.atMs;
    const movedM = metersBetween(
      { lat: prev.lat, lng: prev.lng },
      center,
    );
    const zoomDelta = Math.abs(z - prev.z);
    if (
      !force &&
      elapsed < MAP_VIEW_SYNC_MIN_MS &&
      movedM < MAP_VIEW_SYNC_MIN_MOVE_M &&
      zoomDelta < MAP_VIEW_SYNC_MIN_ZOOM_DELTA
    ) {
      return;
    }
    m.setView([center.lat, center.lng], z, { animate: false });
    lastMapViewSyncRef.current = {
      atMs: nowMs,
      lat: center.lat,
      lng: center.lng,
      z,
    };
  };
  const layoutViewportWidthRef = useRef<number | null>(null);
  layoutViewportWidthRef.current = layoutViewportWidthPx ?? null;
  const streamer = audienceRole === "streamer";
  // Keep width ref in sync every render.
  viewerTargetWidthRef.current = viewerTargetWidthMeters ?? 250;
  // When the target width tier changes → queue one zoom animation (handled in RAF).
  useEffect(() => {
    userZoomOverrideRef.current = null;
    if (streamer || viewerTargetWidthMeters == null || viewerTargetWidthMeters <= 0) {
      return;
    }
    const prev = viewerTargetWidthPrevRef.current;
    viewerTargetWidthPrevRef.current = viewerTargetWidthMeters;
    if (prev != null && Math.abs(prev - viewerTargetWidthMeters) > 1) {
      viewerZoomAnimQueuedWidthRef.current = viewerTargetWidthMeters;
    }
  }, [viewerTargetWidthMeters, viewerZoomRuleKey, streamer]);
  useEffect(() => {
    onUserInteractRef.current = onUserInteract;
  }, [onUserInteract]);
  routePointsLenRef.current = routePoints.length;
  followModeRef.current = followMode;
  viewerFollowZoomRef.current = viewerFollowZoom ?? null;
  smoothGridFramingRef.current = viewerFollowLatLngBounds != null;
  rotateWithHeadingRef.current = rotateWithHeading;
  const showHistoryPath = true;
  const smoothMotion = true;
  const col = streamer ? C.streamer : C.viewer;
  const profile = mapProfile(transportMode, streamer ? "streamer" : "viewer");
  const modeMaxZoom = mapMaxZoom(zoomLevelBonus);
  const viewerFollowProfileZoom = streamer
    ? profile.zoom
    : profile.zoom + VIEWER_FOLLOW_ZOOM_EXTRA + zoomLevelBonus;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!rotateWithHeading || !followMode) {
      el.style.setProperty("--camtok-map-rotation", "0deg");
      applyMapShellRotation(0);
      return;
    }
    el.style.setProperty(
      "--camtok-map-rotation",
      `${rotationDegRef.current}deg`,
    );
  }, [rotateWithHeading, followMode, mapReady, destination]);

  useEffect(() => {
    if (!followMode) hasAppliedInitialZoomRef.current = false;
  }, [followMode]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m || streamer || !followMode) return;
    if (viewerFollowLatLngBounds != null) return;
    if (viewerFollowZoom == null || !Number.isFinite(viewerFollowZoom)) return;
    // Viewer motion loop eases zoom; avoid a competing animated setView.
    if (routePoints.length > 0) return;
    const c = m.getCenter();
    if (Math.abs(m.getZoom() - viewerFollowZoom) < 0.05) return;
    m.setView(c, viewerFollowZoom, {
      animate: true,
      duration: 0.45,
      easeLinearity: 0.28,
    });
  }, [
    viewerFollowZoom,
    viewerFollowLatLngBounds,
    followMode,
    streamer,
    routePoints.length,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = mapRef.current;
      if (!m || streamer || !followMode) {
        viewerBoundsZoomRef.current = null;
        return;
      }
      const raw = viewerFollowLatLngBounds;
      if (
        !raw ||
        raw.length !== 2 ||
        raw[0].length !== 2 ||
        raw[1].length !== 2
      ) {
        viewerBoundsZoomRef.current = null;
        return;
      }
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      const bounds = L.latLngBounds(
        [raw[0][0], raw[0][1]] as [number, number],
        [raw[1][0], raw[1][1]] as [number, number],
      );
      if (!bounds.isValid()) {
        viewerBoundsZoomRef.current = null;
        return;
      }
      const latSpan = raw[1][0] - raw[0][0];
      const lngSpan = raw[1][1] - raw[0][1];
      const midLat = (raw[0][0] + raw[1][0]) / 2;
      const heightM = latSpan * 111_320;
      const widthM =
        lngSpan *
        111_320 *
        Math.max(0.12, Math.cos((midLat * Math.PI) / 180));
      const spanM = Math.max(heightM, widthM);
      // Tight padding: large fitBounds padding was the main reason viewer follow stayed too wide.
      const padPx =
        spanM < 900 ? 4 : spanM < 1800 ? 8 : heightM < 700 ? 12 : 6;
      // OSM tiles cap at ~19 — allow +1 for two-wheeled baseline offset.
      const maxZ = modeMaxZoom - 1;
      m.invalidateSize(false);
      const padPt = L.point(padPx, padPx);
      let zFit = m.getBoundsZoom(bounds, false, padPt);
      if (!Number.isFinite(zFit)) {
        viewerBoundsZoomRef.current = null;
        return;
      }
      zFit = Math.min(maxZ, zFit);
      zFit += VIEWER_FIT_BOUNDS_ZOOM_BIAS;
      zFit = Math.min(maxZ, zFit);
      const floor = viewerFollowBoundsMinZoom;
      if (floor != null && Number.isFinite(floor)) {
        zFit = Math.max(floor, zFit);
      }
      zFit = Math.max(VIEWER_FOLLOW_BOUNDS_ZOOM_FLOOR, zFit);
      viewerBoundsZoomRef.current = zFit;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    viewerFollowLatLngBounds,
    viewerFollowBoundsMinZoom,
    followMode,
    streamer,
    mapReady,
  ]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let done = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (done) return;
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      const m = L.map(el, {
        center: [0, 0],
        zoom: 2,
        zoomControl: false,
        dragging: interactive,
        scrollWheelZoom: false,
        touchZoom: interactive ? "center" : false,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        attributionControl: false,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
      });
      if (interactive) {
        m.touchZoom.enable();
        m.doubleClickZoom.enable();
      }
      m.on("dragstart", () => {
        onUserInteractRef.current?.();
      });
      const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
      const style = mapTileStyle(transportMode);
      const tileUrl = maptilerKey
        ? `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${maptilerKey}`
        : mapTileFallbackUrl(transportMode);
      const attribution = maptilerKey
        ? '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        : '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
      const t = L.tileLayer(tileUrl, {
          maxZoom: mapMaxZoom(zoomLevelBonus),
          opacity: 1,
          keepBuffer: 1,
          updateWhenIdle: false,
          updateWhenZooming: false,
          attribution,
        },
      );
      t.addTo(m);
      // MapTiler / Stadia tiles are already colour-balanced — no filter needed.
      zoneLayerRef.current = L.layerGroup().addTo(m);
      checkpointLayerRef.current = L.layerGroup().addTo(m);
      destLayerRef.current = L.layerGroup().addTo(m);
      camLayerRef.current = L.layerGroup().addTo(m);
      railLayerRef.current = L.layerGroup().addTo(m);
      turnLayerRef.current = L.layerGroup().addTo(m);
      stepPinLayerRef.current = L.layerGroup().addTo(m);
      turnLayerFingerprintRef.current = ""; // ensure first draw always runs
      // Vehicle pane sits above all polylines, markers, and turn pins (z-index 640 >
      // marker pane 600 > overlay/SVG pane 400). Only tooltips (650) and popups (700) beat it.
      m.createPane("vehicle");
      const vPane = m.getPane("vehicle");
      if (vPane) vPane.style.zIndex = "640";
      layerRef.current = t;
      mapRef.current = m;
      setMapReady((n) => n + 1);
      setTimeout(() => {
        try {
          m.invalidateSize(false);
        } catch {
          /* noop */
        }
      }, 50);
    })();
    return () => {
      done = true;
      if (motionRafRef.current != null) cancelAnimationFrame(motionRafRef.current);
      hasAppliedInitialZoomRef.current = false;
      lastGpsAtMsRef.current = null;
      plRef.current = null;
      dotRef.current = null;
      arRef.current = null;
      zoneLayerRef.current = null;
      checkpointLayerRef.current = null;
      destLayerRef.current = null;
      camLayerRef.current = null;
      railLayerRef.current = null;
      turnLayerRef.current = null;
      stepPinLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    layerRef.current?.setOpacity(tileOpacity);
  }, [tileOpacity]);

  // Swap tile layer when transport mode switches between car and two-wheeled.
  useEffect(() => {
    const m = mapRef.current;
    const oldLayer = layerRef.current;
    if (!m || !oldLayer) return;
    const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY;
    if (!maptilerKey) return;
    const style = mapTileStyle(transportMode);
    const currentUrl: string = (oldLayer as unknown as { _url: string })._url ?? "";
    if (currentUrl.includes(style)) return; // already correct tiles
    void (async () => {
      const L = (await import("leaflet")).default;
      const newUrl = `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${maptilerKey}`;
      const newLayer = L.tileLayer(newUrl, {
        maxZoom: mapMaxZoom(zoomLevelBonus),
        opacity: tileOpacity,
        keepBuffer: 1,
        updateWhenIdle: false,
        updateWhenZooming: false,
        attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      });
      if (!mapRef.current) return; // unmounted while loading
      newLayer.addTo(mapRef.current);
      oldLayer.remove();
      layerRef.current = newLayer;
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportMode]);

  // FPS monitor: if sustained < 30fps for 3s, notify parent to shed expensive work.
  // One-way trigger; the RAF counter itself costs ~0 CPU.
  const onPerformanceDegradeRef = useRef(onPerformanceDegrade);
  useEffect(() => { onPerformanceDegradeRef.current = onPerformanceDegrade; }, [onPerformanceDegrade]);

  useEffect(() => {
    if (!mapReady) return;
    let frames = 0;
    let lastTs = performance.now();
    let lowCount = 0;
    let fired = false;
    let rafId: number;

    const tick = (now: number) => {
      frames++;
      const elapsed = now - lastTs;
      if (elapsed >= 1000) {
        if (!fired) {
          const fps = (frames / elapsed) * 1000;
          if (fps < 30) {
            lowCount++;
            if (lowCount >= 3) {
              fired = true;
              onPerformanceDegradeRef.current?.();
            }
          } else {
            lowCount = 0;
          }
        }
        frames = 0;
        lastTs = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mapReady]);

  // When heading-rotation mode changes the container expands from viewport → 1.48× viewport.
  // Leaflet must re-measure its container so it loads tiles for the full enlarged area.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReady) return;
    const id = setTimeout(() => {
      try { m.invalidateSize(false); } catch { /* noop */ }
    }, 80);
    return () => clearTimeout(id);
  }, [rotateWithHeading, followMode, mapReady]);

  useEffect(() => {
    const group = zoneLayerRef.current;
    if (!group) return;
    let aborted = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (aborted) return;
        group.clearLayers();
        let added = 0;
        let skipped = 0;
        if (showZones) {
          zones.forEach((zone) => {
            if (!zone.polygon || zone.polygon.length < 3) {
              skipped++;
              return;
            }
            const selected = selectedZoneId === zone.id;
            const isCurrentZone = currentZoneId === zone.id;
            const isActive = zone.isActive !== false;
            const color = zone.color ?? "#60a5fa";
            const latlngs = zone.polygon
              .map((p) => [p.lat, p.lng] as [number, number])
              .filter(
                ([la, ln]) =>
                  Number.isFinite(la) && Number.isFinite(ln),
              );
            if (latlngs.length < 3) {
              skipped++;
              return;
            }
            const muted = zonesVisualStyle === "muted";
            const pickZone = zonesVisualStyle === "pick_zone";
            const bikeMap = isTwoWheeled(transportMode);
            const isHighlighted = selected || isCurrentZone;
            const pulseKind = zonePulseById?.[zone.id];
            const neighborPulseIdx = neighborPulseIndex(pulseKind);
            let strokeColor: string;
            let fillColor = color;
            let strokeWeight: number;
            let fillOp: number;
            let dashArr: string | undefined;
            let strokeOp: number;

            if (bikeMap && !pulseKind) {
              // Two-wheeled: neutral borders, barely-there fills — map detail stays readable.
              strokeColor = isHighlighted
                ? "rgba(71, 85, 105, 0.72)"
                : "rgba(100, 116, 139, 0.38)";
              strokeWeight = isHighlighted ? 2 : 1.2;
              fillOp = isHighlighted ? (selected ? 0.1 : 0.07) : 0.035;
              dashArr = isHighlighted ? undefined : "5 4";
              strokeOp = 1;
              fillColor = isHighlighted
                ? "rgba(148, 163, 184, 0.35)"
                : "rgba(148, 163, 184, 0.2)";
            } else if (pickZone || pulseKind) {
              strokeColor =
                neighborPulseIdx != null
                  ? NEIGHBOR_PULSE_STROKE[neighborPulseIdx]!
                  : color;
              strokeWeight =
                pulseKind === "current"
                  ? 3.4
                  : neighborPulseIdx != null
                    ? 3
                    : isHighlighted
                      ? 2.75
                      : 1.85;
              fillOp =
                pulseKind === "current"
                  ? 0.24
                  : neighborPulseIdx != null
                    ? 0.18
                    : isHighlighted
                      ? selected
                        ? 0.32
                        : 0.22
                      : 0.12;
              dashArr = isHighlighted || pulseKind ? undefined : "7 5";
              strokeOp = pulseKind ? 0.95 : isHighlighted ? 1 : 0.82;
            } else if (muted) {
              strokeColor = color;
              strokeWeight = isHighlighted ? 2.5 : 1.6;
              fillOp = isHighlighted ? (selected ? 0.26 : 0.18) : 0.12;
              dashArr = isHighlighted ? undefined : "6 5";
              strokeOp = isHighlighted ? 0.95 : 0.72;
            } else {
              strokeColor = color;
              strokeWeight = isHighlighted ? 2.75 : 1.85;
              fillOp = isHighlighted ? (selected ? 0.3 : 0.2) : 0.15;
              dashArr = isHighlighted ? undefined : "7 5";
              strokeOp = isHighlighted ? 1 : 0.85;
            }

            if (!isActive) {
              fillOp *= 0.45;
              strokeOp *= 0.5;
              dashArr = dashArr ?? "4 4";
            }

            if (pulseKind === "current") {
              strokeColor = "#fbbf24";
              strokeWeight = Math.max(strokeWeight, 3.4);
              fillOp = Math.max(fillOp, 0.22);
              strokeOp = Math.max(strokeOp, 0.95);
              dashArr = undefined;
            } else if (neighborPulseIdx != null) {
              strokeColor = NEIGHBOR_PULSE_STROKE[neighborPulseIdx]!;
              strokeWeight = Math.max(strokeWeight, 3);
              fillOp = Math.max(fillOp, 0.16);
              strokeOp = Math.max(strokeOp, 0.92);
              dashArr = undefined;
            }

            const poly = L.polygon(latlngs, {
              color: strokeColor,
              weight: strokeWeight,
              fillColor: fillColor,
              fillOpacity: fillOp,
              opacity: strokeOp,
              dashArray: dashArr,
              lineJoin: "round",
              className: zonePulseClassName(pulseKind),
            });
            if (interactive && onZoneSelect) {
              poly.on("click", () => onZoneSelect(selected ? null : zone.id));
            }
            poly.addTo(group);
            added++;
          });
        }
      } catch (err) {
        console.error("[LiveMap] zone render failed", err);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [zones, selectedZoneId, currentZoneId, showZones, interactive, onZoneSelect, mapReady, audienceRole, zonesVisualStyle, transportMode, zonePulseById]);

  useEffect(() => {
    const group = checkpointLayerRef.current;
    if (!group) return;
    let aborted = false;
    (async () => {
      try {
        const L = (await import("leaflet")).default;
        if (aborted) return;
        group.clearLayers();
        if (!showCheckpoints) return;
        checkpoints.forEach((cp) => {
          const selected = selectedCheckpointId === cp.id;
          const isActive = cp.isActive !== false;
          if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lng)) return;
          const marker = L.circleMarker([cp.lat, cp.lng], {
            radius: selected ? 7 : 5,
            color: "#ffffff",
            weight: selected ? 2 : 1,
            fillColor: selected ? "#f59e0b" : "#fb7185",
            fillOpacity: isActive ? 0.95 : 0.3,
            opacity: isActive ? 0.95 : 0.4,
          });
          if (interactive && onCheckpointSelect) {
            marker.on("click", () => onCheckpointSelect(selected ? null : cp.id));
          }
          marker.addTo(group);
        });
      } catch (err) {
        console.error("[LiveMap] checkpoint render failed", err);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [
    checkpoints,
    selectedCheckpointId,
    showCheckpoints,
    interactive,
    onCheckpointSelect,
    mapReady,
    audienceRole,
  ]);

  useEffect(() => {
    const group = destLayerRef.current;
    if (!group) return;
    let aborted = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (aborted) return;
      group.clearLayers();
      destFlatNodesRef.current = []; // clear stale node refs before rebuild

      if (
        destinationRoute &&
        destinationRoute.length >= 2 &&
        destinationRoute.every(
          (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
        )
      ) {
        const drawGoogleRouteLine = (
          pts: Array<[number, number]>,
          color: string,
          weight: number,
        ) => {
          L.polyline(pts, {
            color: "rgba(255,255,255,0.92)",
            weight: weight + 2,
            opacity: 0.45,
            dashArray: "10 8",
            lineCap: "round",
            lineJoin: "round",
          }).addTo(group);
          L.polyline(pts, {
            color,
            weight,
            opacity: 0.72,
            dashArray: "10 8",
            lineCap: "round",
            lineJoin: "round",
          }).addTo(group);
        };

        const segments = destinationRouteTraffic;
        if (segments && segments.length > 0) {
          for (const seg of segments) {
            const slice = trafficSegmentLatLngs(
              destinationRoute,
              seg.startIndex,
              seg.endIndex,
            );
            if (slice.length < 2) continue;
            const pts = slice.map((p) => [p.lat, p.lng] as [number, number]);
            const color =
              GOOGLE_TRAFFIC_COLORS[seg.speed] ?? GOOGLE_TRAFFIC_COLORS.NORMAL;
            const weight =
              seg.speed === "TRAFFIC_JAM" ? 7 : seg.speed === "SLOW" ? 6 : 5;
            drawGoogleRouteLine(pts, color, weight);
          }
        } else {
          const pts = destinationRoute.map(
            (p) => [p.lat, p.lng] as [number, number],
          );
          drawGoogleRouteLine(pts, GOOGLE_TRAFFIC_COLORS.NORMAL, 5);
        }
      }

      if (
        destination &&
        Number.isFinite(destination.lat) &&
        Number.isFinite(destination.lng)
      ) {
        const labelRaw = destination.label?.trim() ?? "";
        const labelHtml = labelRaw
          ? `<div style="box-sizing:border-box;max-width:min(260px,70vw);margin-bottom:4px;padding:2px 8px;border-radius:9999px;background:rgba(239,68,68,0.92);border:1px solid rgba(255,255,255,0.6);color:#fff;font-size:11px;font-weight:600;letter-spacing:0.01em;box-shadow:0 4px 14px rgba(0,0,0,0.45);line-height:1.3;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeDestinationLabel(labelRaw)}</div>`
          : "";
        const pinHtml = `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-2px)">
            <div style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:2px solid white;box-shadow:0 0 8px rgba(0,0,0,0.85)"></div>
            <div style="width:2px;height:10px;background:#ef4444;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>
          </div>`;
        const transitionCss = streamer
          ? "transform 1100ms cubic-bezier(0.22,0.61,0.36,1)"
          : "none";
        const html = `<div class="camtok-dest-screen-flat" style="display:flex;flex-direction:column;align-items:center;transform:rotate(0deg);transform-origin:50% 100%;transition:${transitionCss};will-change:transform">${labelHtml}${pinHtml}</div>`;
        const w = 280;
        const h = (labelRaw ? 30 : 0) + 30;
        const icon = L.divIcon({
          html,
          className: "camtok-destination-pin",
          iconSize: [w, h],
          iconAnchor: [w / 2, h],
        });
        const marker = L.marker([destination.lat, destination.lng], {
          icon,
          interactive: false,
          zIndexOffset: 1000,
        });
        marker.addTo(group);
        // After the marker DOM is inserted, collect its flat-node elements
        // into destFlatNodesRef so applyMapShellRotation never needs to
        // querySelectorAll on the hot RAF path.
        queueMicrotask(() => {
          const root = containerRef.current;
          if (!root) return;
          const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(".camtok-dest-screen-flat"),
          );
          destFlatNodesRef.current = nodes;
          const deg =
            rotateWithHeadingRef.current && followModeRef.current
              ? -rotationDegRef.current
              : 0;
          for (const node of nodes) {
            node.style.transform = `rotate(${deg}deg)`;
            node.style.transformOrigin = "50% 100%";
          }
        });
      }
    })();
    return () => {
      aborted = true;
    };
  }, [
    destination?.lat,
    destination?.lng,
    destination?.label,
    destinationRoute,
    destinationRouteTraffic,
    mapReady,
    streamer,
  ]);

  // ── Traffic camera pins ────────────────────────────────────────────────────
  useEffect(() => {
    const group = camLayerRef.current;
    if (!group) return;
    let aborted = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (aborted) return;
      group.clearLayers();
      if (!trafficCameras || trafficCameras.length === 0) return;

      for (const cam of trafficCameras) {
        if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lng)) continue;
        const isActive = cam.id === activeCameraId;
        const label = cam.name.trim();

        let html: string;
        let w: number, h: number, anchorX: number, anchorY: number;

        if (isActive) {
          // Active camera: pulsing sky-blue dot only — no label.
          html = `<div style="position:relative;width:28px;height:28px;display:flex;align-items:center;justify-content:center;">
            <div style="position:absolute;inset:0;border-radius:50%;background:rgba(14,165,233,0.28);animation:cam-ping 1.4s cubic-bezier(0,0,0.2,1) infinite;"></div>
            <div style="position:relative;z-index:1;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(14,165,233,0.95);border:2px solid #fff;box-shadow:0 0 10px rgba(14,165,233,0.8),0 2px 6px rgba(0,0,0,0.5);font-size:12px;line-height:1;">📷</div>
          </div>
          <style>@keyframes cam-ping{0%{transform:scale(1);opacity:.8}70%{transform:scale(1.9);opacity:0}100%{transform:scale(1.9);opacity:0}}</style>`;
          w = 28; h = 28; anchorX = 14; anchorY = 14;
        } else {
          // Inactive cameras: very small, barely visible dot.
          html = `<div style="display:flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.18);font-size:8px;line-height:1;opacity:0.55;">📷</div>`;
          w = 14; h = 14; anchorX = 7; anchorY = 7;
        }

        const icon = L.divIcon({ html, className: "", iconSize: [w, h], iconAnchor: [anchorX, anchorY] });
        L.marker([cam.lat, cam.lng], {
          icon,
          interactive: false,
          zIndexOffset: isActive ? 2000 : 100,
        }).addTo(group);
      }
    })();
    return () => { aborted = true; };
  }, [trafficCameras, activeCameraId, mapReady]);

  useEffect(() => {
    const group = turnLayerRef.current;
    const rail = railLayerRef.current;
    if (!group || !rail) return;

    // Build a cheap fingerprint — skip the full layer teardown + rebuild when
    // the first pin position and approach line length haven't changed.
    const pin0 = driverPins?.[0] ?? (turnTarget ? { lat: turnTarget.lat, lng: turnTarget.lng } : null);
    const newFingerprint = pin0
      ? `${pin0.lat.toFixed(5)},${pin0.lng.toFixed(5)}|${approachLine?.length ?? 0}|p${turnPinPulse ? 1 : 0}`
      : `none|${approachLine?.length ?? 0}|p${turnPinPulse ? 1 : 0}`;
    if (newFingerprint === turnLayerFingerprintRef.current) return;
    turnLayerFingerprintRef.current = newFingerprint;

    (async () => {
      const L = (await import("leaflet")).default;
      group.clearLayers();
      rail.clearLayers();

      // The backend decides 3 pins ahead for stable lookahead, but the
      // user explicitly asked to *show* only the next one. We render
      // pins[0] only; the rest are kept server-side and used internally.

      const nextPin =
        driverPins && driverPins.length > 0
          ? driverPins[0]!
          : turnTarget
            ? { lat: turnTarget.lat, lng: turnTarget.lng }
            : null;
      const nextDistance = driverPins?.[0]?.distanceMeters ?? null;
      // Keep the blue pin visible from appearance until the backend removes it
      // after the vehicle has passed it.
      const showPin = nextPin;
      const showDriverLine =
        audienceRole === "streamer" &&
        nextDistance != null &&
        nextDistance < 50;

      if (showPin) {
        L.circle([nextPin.lat, nextPin.lng], {
          radius: turnPinPulse ? 24 : 16,
          color: "#2563eb",
          weight: turnPinPulse ? 3 : 2,
          fillColor: "#3b82f6",
          fillOpacity: turnPinPulse ? 0.14 : 0.22,
          opacity: turnPinPulse ? 0.95 : 0.9,
          className: turnPinPulse ? "camtok-turn-pin-ring-pulse" : undefined,
        }).addTo(group);
        L.circleMarker([nextPin.lat, nextPin.lng], {
          radius: turnPinPulse ? 9 : 7,
          color: "#ffffff",
          weight: turnPinPulse ? 3 : 2,
          fillColor: "#2563eb",
          fillOpacity: 1,
          className: turnPinPulse ? "camtok-turn-pin-pulse" : undefined,
        }).addTo(group);
      }

      // Approach line: backend hands us a turn guidance segment
      // (~50 m before + up to ~20 m after the first pin). We draw it directly
      // so it always matches the road and disappears the moment the
      // vehicle moves past the pin.
      if (!showDriverLine || !approachLine || approachLine.length < 2) return;
      const pts = approachLine.map((p) => [p.lat, p.lng] as [number, number]);
      L.polyline(pts, {
        color: "#1d4ed8",
        weight: 12,
        opacity: 0.3,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(rail);
      L.polyline(pts, {
        color: "#3b82f6",
        weight: 7,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(rail);
    })();
  }, [turnTarget, driverPins, approachLine, mapReady, audienceRole, turnPinPulse]);

  // ── Nearby landmark photo marker for active `next_step` bets ─────────────
  //
  // 1. Query Wikipedia's generator+geosearch API for articles within 1 km.
  // 2. Pick the first result that has a thumbnail photo.
  // 3. Render a circular photo-bubble marker (Google Maps POI style) on the map.
  // 4. Fall back to the Marble Arch SVG if Wikipedia returns nothing.
  //
  // Results are cached by a ~100 m grid key so rapid pin updates (every 200 m)
  // don't hammer the API.
  useEffect(() => {
    const group = stepPinLayerRef.current;
    if (!group) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      group.clearLayers();
      landmarkFlatNodesRef.current = [];
      if (!stepPin) return;

      if (cancelled) return;

      // Simple small blue pin — same shape as the destination pin but blue.
      const pulseClass = stepPinPulse ? " camtok-step-pin-head-pulse" : "";
      const ringHtml = stepPinPulse
        ? `<div class="camtok-step-pin-outer-ring"></div>`
        : "";
      const headSize = stepPinPulse ? 18 : 14;
      const html = `
        <div class="camtok-landmark-screen-flat" style="display:flex;flex-direction:column;align-items:center;transform:rotate(0deg);transform-origin:50% 100%;will-change:transform">
          <div style="position:relative;width:${headSize}px;height:${headSize}px;display:flex;align-items:center;justify-content:center">
            ${ringHtml}
            <div class="${pulseClass.trim()}" style="width:${headSize}px;height:${headSize}px;border-radius:50%;background:#3b82f6;border:2.5px solid #fff;box-shadow:0 0 10px rgba(59,130,246,0.85)"></div>
          </div>
          <div style="width:2px;height:8px;background:#3b82f6"></div>
          <div style="width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #3b82f6;margin-top:-1px"></div>
        </div>`;
      const icon = L.divIcon({
        html,
        className: "camtok-landmark-pin",
        iconSize: [headSize, headSize + 16],
        iconAnchor: [headSize / 2, headSize + 16],
      });

      group.clearLayers(); // clear again in case another async settled first
      L.marker([stepPin.lat, stepPin.lng], {
        icon,
        interactive: false,
        zIndexOffset: 900,
      }).addTo(group);

      // Register for counter-rotation so the pin stays upright when map rotates.
      queueMicrotask(() => {
        const root = containerRef.current;
        if (!root) return;
        const nodes = Array.from(
          root.querySelectorAll<HTMLElement>(".camtok-landmark-screen-flat"),
        );
        landmarkFlatNodesRef.current = nodes;
        const deg =
          rotateWithHeadingRef.current && followModeRef.current
            ? -rotationDegRef.current
            : 0;
        for (const node of nodes) {
          node.style.transform = `rotate(${deg}deg)`;
          node.style.transformOrigin = "50% 100%";
        }
      });
    })();
    return () => { cancelled = true; };
  }, [stepPin, stepPinPulse, mapReady]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    (async () => {
      const L = (await import("leaflet")).default;
      if (routePoints.length === 0) {
        if (arRef.current) { m.removeLayer(arRef.current); arRef.current = null; }
        if (plRef.current) { m.removeLayer(plRef.current); plRef.current = null; }
        if (dotRef.current) { m.removeLayer(dotRef.current); dotRef.current = null; }
        // Keep map visible even before first GPS point.
        m.setView([44.8125, 20.4612], 13, { animate: false });
        return;
      }
      const last = routePoints[routePoints.length - 1]!;
      const pos: [number, number] = [last.lat, last.lng];
      const latlngs: [number, number][] = routePoints.map((p) => [p.lat, p.lng]);
      const isFirstFollowFrame = !hasAppliedInitialZoomRef.current;
      // Viewer width-based zoom is AUTHORITATIVE when set: compute initial zoom from
      // the desired visible width so the first frame already matches the target
      // (instead of snapping to profile zoom ~17.3 and blending down for seconds).
      const widthTarget = viewerTargetWidthMeters;
      const widthBasedInitialZoom =
        !streamer &&
        widthTarget != null &&
        widthTarget > 0 &&
        layoutViewportWidthPx != null &&
        layoutViewportWidthPx > 0
          ? (() => {
              const cosLat = Math.max(0.01, Math.cos((last.lat * Math.PI) / 180));
              const z = Math.log2(
                (layoutViewportWidthPx * 40075017 * cosLat) /
                  (256 * widthTarget),
              );
              return Math.max(12, Math.min(modeMaxZoom, z));
            })()
          : null;
      const _dp = driverPinsRef.current;
      const viewerTurnPinActive =
        !streamer &&
        widthBasedInitialZoom == null &&
        viewerFollowLatLngBounds == null &&
        (viewerFollowZoom == null || !Number.isFinite(viewerFollowZoom)) &&
        (turnTarget != null ||
          (_dp != null &&
            _dp.length > 0 &&
            Number.isFinite(_dp[0]?.lat)));
      const navZoomFloor = viewerTurnPinActive
        ? Math.max(viewerFollowProfileZoom, 17.5)
        : viewerFollowProfileZoom;
      viewerTurnNavZoomRef.current = viewerTurnPinActive ? navZoomFloor : null;
      const baseZoom =
        widthBasedInitialZoom != null
          ? widthBasedInitialZoom
          : viewerFollowLatLngBounds
            ? viewerBoundsZoomRef.current ?? viewerFollowProfileZoom
            : viewerFollowZoom ?? navZoomFloor;
      const targetZoom = interactive
        ? hasAppliedInitialZoomRef.current
          ? m.getZoom()
          : baseZoom
        : baseZoom;

      if (showHistoryPath) {
        if (plRef.current) {
          plRef.current.setLatLngs(latlngs);
          plRef.current.setStyle({ color: col.line, weight: profile.lineWeight, opacity: col.lineOp });
        } else {
          plRef.current = L.polyline(latlngs, {
            color: col.line,
            weight: profile.lineWeight,
            opacity: col.lineOp,
          }).addTo(m);
        }
      } else if (plRef.current) {
        m.removeLayer(plRef.current);
        plRef.current = null;
      }
      if (dotRef.current) {
        // Keep position updates inside the RAF interpolator to avoid per-GPS snaps.
        dotRef.current.setStyle({ fillColor: col.fill, color: "rgba(255,255,255,0.85)", fillOpacity: 0.92, weight: 1, radius: col.r });
      } else {
        dotRef.current = L.circleMarker(pos, {
          radius: col.r,
          fillColor: col.fill,
          color: "rgba(255,255,255,0.85)",
          weight: 1,
          fillOpacity: 0.92,
          pane: "vehicle",
        }).addTo(m);
      }
      if (showCourseArrow && last.heading != null) {
        if (arRef.current) {
          // Skip setIcon when heading hasn't changed — avoids a full Leaflet
          // marker DOM rebuild on every GPS poll when the heading is steady.
          const rounded = Math.round(last.heading);
          if (arrowLastHeadingRef.current !== rounded) {
            arrowLastHeadingRef.current = rounded;
            arRef.current.setIcon(headingDivIcon(L, rounded, streamer));
          }
        } else {
          arrowLastHeadingRef.current = Math.round(last.heading);
          arRef.current = L.marker(pos, {
            icon: headingDivIcon(L, last.heading, streamer),
            interactive: false,
            zIndexOffset: 500,
            pane: "vehicle",
          }).addTo(m);
        }
      } else if (arRef.current) {
        m.removeLayer(arRef.current);
        arRef.current = null;
        arrowLastHeadingRef.current = null;
      }
      if (followMode) {
        if (isFirstFollowFrame) {
          const gridFraming = viewerFollowLatLngBounds != null;
          m.setView(pos, targetZoom, {
            animate: true,
            duration: streamer
              ? gridFraming
                ? 0.72
                : 0.55
              : gridFraming
                ? MAP_SET_VIEW_DURATION_SEC
                : 0.45,
            easeLinearity: streamer
              ? gridFraming
                ? 0.26
                : 0.28
              : gridFraming
                ? MAP_SET_VIEW_EASE_LINEARITY
                : 0.28,
          });
        }
        hasAppliedInitialZoomRef.current = true;
      }

      // Rotate map opposite of heading so "forward" remains screen-up.
      // Rotation is applied to an oversized wrapper (see JSX), not the map box,
      // to avoid empty corners while preserving a fully filled frame.
      if (followMode && rotateWithHeading && last.heading != null) {
        const target = -last.heading;
        if (streamer) {
          const delta = normalizeAngleDeg(target - smoothHeadingRef.current);
          const rotationEase = 0.12;
          smoothHeadingRef.current = normalizeAngleDeg(
            smoothHeadingRef.current + delta * rotationEase,
          );
          applyMapShellRotation(smoothHeadingRef.current);
        } else {
          viewerMapRotationTargetRef.current = target;
        }
      } else if (followMode) {
        smoothHeadingRef.current = 0;
        viewerMapRotationTargetRef.current = 0;
        applyMapShellRotation(0);
      }
    })();
  }, [
    routePoints,
    col,
    streamer,
    showCourseArrow,
    col.line,
    col.lineOp,
    col.fill,
    col.r,
    mapReady,
    viewerFollowProfileZoom,
    viewerFollowZoom,
    viewerFollowLatLngBounds,
    profile.lineWeight,
    rotateWithHeading,
    followMode,
    turnTarget,
    // driverPins intentionally omitted — read via driverPinsRef.current; routePoints already triggers this effect often enough.
  ]);

  // Viewer: each poll refreshes target + gently blends measured °/s (poll is guidance, not a snap target).
  useEffect(() => {
    if (streamer || routePoints.length === 0) return;

    const last = routePoints[routePoints.length - 1]!;
    const prev = routePoints.length > 1 ? routePoints[routePoints.length - 2]! : null;

    viewerPollTargetRef.current = { lat: last.lat, lng: last.lng };
    viewerLastPollTsRef.current = performance.now();

    const fallbackDt = 0.9;
    const segmentDtSec = motionSegmentDtSec(prev, last, fallbackDt);

    let measVLat = prev ? (last.lat - prev.lat) / segmentDtSec : 0;
    let measVLng = prev ? (last.lng - prev.lng) / segmentDtSec : 0;

    if (
      last.speedMps != null &&
      last.speedMps > 0.25 &&
      last.heading != null &&
      !Number.isNaN(last.heading)
    ) {
      const h = (last.heading * Math.PI) / 180;
      const latRad = (last.lat * Math.PI) / 180;
      const mPerDegLat = 111_320;
      const mPerDegLng = Math.max(4500, 111_320 * Math.cos(latRad));
      const vn = (last.speedMps * Math.cos(h)) / mPerDegLat;
      const ve = (last.speedMps * Math.sin(h)) / mPerDegLng;
      // Prefer driver-reported speed/heading for viewer motion pacing.
      measVLat = measVLat * 0.2 + vn * 0.8;
      measVLng = measVLng * 0.2 + ve * 0.8;
    }

    const blend = 0.42;
    const vr = viewerVelSmoothedRef.current;
    vr.vLat = vr.vLat * (1 - blend) + measVLat * blend;
    vr.vLng = vr.vLng * (1 - blend) + measVLng * blend;

    // Cap at ~150 km/h equivalent to prevent runaway projection.
    const vmag = Math.hypot(vr.vLat, vr.vLng);
    const maxDegPerSec = 0.005;
    if (vmag > maxDegPerSec) {
      const s = maxDegPerSec / vmag;
      vr.vLat *= s;
      vr.vLng *= s;
    }
  }, [routePoints, streamer]);

  useEffect(() => {
    const m = mapRef.current;
    const dot = dotRef.current;

    const cancelBurst = () => {
      if (motionRafRef.current != null) {
        cancelAnimationFrame(motionRafRef.current);
        motionRafRef.current = null;
      }
    };

    // The viewer smooth-RAF loop is managed exclusively by the effect below
    // (dep: routePoints.length > 0).  This burst effect must never touch it —
    // otherwise its cleanup fires on every routePoints change and kills the
    // viewer loop before the viewer RAF effect can restart it.

    if (!m || !dot || routePoints.length === 0 || !followMode) {
      cancelBurst();
      return cancelBurst;
    }

    if (!streamer) {
      cancelBurst();
      return cancelBurst;
    }

    const last = routePoints[routePoints.length - 1]!;
    const prev = routePoints.length > 1 ? routePoints[routePoints.length - 2]! : null;
    const current = dot.getLatLng();
    const startPos: [number, number] = [current.lat, current.lng];
    const targetPos: [number, number] = [last.lat, last.lng];

    const now = performance.now();
    const sinceLastGpsSec =
      lastGpsAtMsRef.current != null
        ? Math.max(0.4, Math.min(2.8, (now - lastGpsAtMsRef.current) / 1000))
        : 0.8;
    lastGpsAtMsRef.current = now;

    const segmentDtSec = motionSegmentDtSec(prev, last, sinceLastGpsSec);
    const vLatPerSec = prev ? (last.lat - prev.lat) / segmentDtSec : 0;
    const vLngPerSec = prev ? (last.lng - prev.lng) / segmentDtSec : 0;
    const settleMs = Math.round(
      Math.min(900, Math.max(450, sinceLastGpsSec * 1000 * 0.7)),
    );
    const tailMs = Math.round(
      Math.min(1500, Math.max(600, sinceLastGpsSec * 1000 * 1.1)),
    );
    const totalMs = settleMs + tailMs;
    const frameStart = performance.now();

    if (motionRafRef.current != null) cancelAnimationFrame(motionRafRef.current);
    const tick = () => {
      const t = performance.now() - frameStart;
      let lat = targetPos[0];
      let lng = targetPos[1];
      if (t < settleMs) {
        const p = t / settleMs;
        lat = startPos[0] + (targetPos[0] - startPos[0]) * p;
        lng = startPos[1] + (targetPos[1] - startPos[1]) * p;
      } else if (t < totalMs) {
        const k = (t - settleMs) / 1000;
        lat = targetPos[0] + vLatPerSec * k;
        lng = targetPos[1] + vLngPerSec * k;
      }

      const livePos: [number, number] = [lat, lng];
      dot.setLatLng(livePos);
      if (arRef.current) arRef.current.setLatLng(livePos);
      if (followMode) {
        const sz = m.getSize();
        const isMapRotating = rotateWithHeadingRef.current && followModeRef.current;
        const viewportH = isMapRotating ? sz.y / 2.0 : sz.y;
        const S = viewportH * 0.10;
        const rotRad = isMapRotating ? (rotationDegRef.current * Math.PI) / 180 : 0;
        const driverPt = m.latLngToLayerPoint(livePos);
        const cPt = { x: driverPt.x - S * Math.sin(rotRad), y: driverPt.y - S * Math.cos(rotRad) };
        syncMapViewIfNeeded(
          m,
          m.layerPointToLatLng(cPt as import("leaflet").Point),
          m.getZoom(),
        );
      }

      if (t < totalMs) {
        motionRafRef.current = requestAnimationFrame(tick);
      }
    };
    motionRafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelBurst();
    };
  }, [routePoints, followMode, rotateWithHeading, smoothMotion, streamer]);

  useEffect(() => {
    const m = mapRef.current;

    const cancelViewerLoop = () => {
      if (viewerSmoothRafRef.current != null) {
        cancelAnimationFrame(viewerSmoothRafRef.current);
        viewerSmoothRafRef.current = null;
      }
      viewerPoseSmoothedRef.current = null;
      viewerVelSmoothedRef.current = { vLat: 0, vLng: 0 };
      viewerLoopLastTsRef.current = 0;
    };

    if (streamer || !followMode || routePoints.length === 0 || !m) {
      cancelViewerLoop();
      return cancelViewerLoop;
    }
    // dot (dotRef.current) may still be null if the route effect's async IIFE
    // hasn't resolved import("leaflet") yet.  The loop reads dotRef.current
    // dynamically each frame and retries until it appears — don't bail here.

    const BASE_STIFFNESS = 18;
    const PRECISE_STIFFNESS = 30;
    const BASE_PROJECT_SEC = 0.55;
    const PRECISE_PROJECT_SEC = 0.18;
    const NEGATIVE_SPEED_EPS = 1e-8;
    const TURN_PRECISE_PRE_M = 50;
    const TURN_PRECISE_POST_M = 20;

    const loop = (now: number) => {
      const mm = mapRef.current;
      const dd = dotRef.current;
      if (!mm || routePointsLenRef.current === 0 || !followModeRef.current) {
        cancelViewerLoop();
        return;
      }
      // Dot marker may lag behind by one microtask while the route effect's
      // async IIFE finishes import("leaflet").  Retry next frame instead of
      // permanently cancelling the loop.
      if (!dd) {
        viewerSmoothRafRef.current = requestAnimationFrame(loop);
        return;
      }

      let pose = viewerPoseSmoothedRef.current;
      if (!pose) {
        const ll = dd.getLatLng();
        pose = { lat: ll.lat, lng: ll.lng };
        viewerPoseSmoothedRef.current = pose;
        viewerPoseVelRef.current = { vLat: 0, vLng: 0 };
      }

      const lastTs =
        viewerLoopLastTsRef.current > 0 ? viewerLoopLastTsRef.current : now;
      const dt = Math.min(0.055, Math.max(0.008, (now - lastTs) / 1000));
      viewerLoopLastTsRef.current = now;

      if (rotateWithHeadingRef.current) {
        const targetRot = viewerMapRotationTargetRef.current;
        const rotDelta = normalizeAngleDeg(targetRot - smoothHeadingRef.current);
        const rotAlpha = 1 - Math.exp(-dt / VIEWER_MAP_ROTATION_TAU_SEC);
        smoothHeadingRef.current = normalizeAngleDeg(
          smoothHeadingRef.current + rotDelta * rotAlpha,
        );
        applyMapShellRotation(smoothHeadingRef.current);
      }

      const target = viewerPollTargetRef.current;
      const vel = viewerVelSmoothedRef.current;
      const nextPin = driverPinsRef.current?.[0] ?? null;
      if (
        nextPin &&
        nextPin.distanceMeters != null &&
        nextPin.distanceMeters <= TURN_PRECISE_PRE_M
      ) {
        viewerTurnPinRef.current = { lat: nextPin.lat, lng: nextPin.lng };
      }

      let viewerPreciseTurnWindow = false;
      if (
        nextPin &&
        nextPin.distanceMeters != null &&
        nextPin.distanceMeters <= TURN_PRECISE_PRE_M
      ) {
        viewerPreciseTurnWindow = true;
      } else if (viewerTurnPinRef.current) {
        const postTurnDist = metersBetween(
          { lat: pose.lat, lng: pose.lng },
          viewerTurnPinRef.current,
        );
        if (postTurnDist <= TURN_PRECISE_POST_M) {
          viewerPreciseTurnWindow = true;
        } else {
          viewerTurnPinRef.current = null;
        }
      }

      const sincePollSec =
        viewerLastPollTsRef.current > 0
          ? Math.max(0, (now - viewerLastPollTsRef.current) / 1000)
          : 0;
      const projectedWindowSec = Math.min(
        viewerPreciseTurnWindow ? PRECISE_PROJECT_SEC : BASE_PROJECT_SEC,
        sincePollSec,
      );
      const desiredLat = target.lat + vel.vLat * projectedWindowSec;
      const desiredLng = target.lng + vel.vLng * projectedWindowSec;
      const stiffness = viewerPreciseTurnWindow ? PRECISE_STIFFNESS : BASE_STIFFNESS;
      const damping = 2 * Math.sqrt(stiffness);
      const poseVel = viewerPoseVelRef.current;
      const aLat = stiffness * (desiredLat - pose.lat) - damping * poseVel.vLat;
      const aLng = stiffness * (desiredLng - pose.lng) - damping * poseVel.vLng;
      let nextVLat = poseVel.vLat + aLat * dt;
      let nextVLng = poseVel.vLng + aLng * dt;
      let nLat = pose.lat + nextVLat * dt;
      let nLng = pose.lng + nextVLng * dt;

      if (!viewerPreciseTurnWindow) {
        const reverseDot = nextVLat * vel.vLat + nextVLng * vel.vLng;
        if (reverseDot < -NEGATIVE_SPEED_EPS) {
          const velMag2 = vel.vLat * vel.vLat + vel.vLng * vel.vLng;
          if (velMag2 > 1e-12) {
            const reject = reverseDot / velMag2;
            nextVLat -= reject * vel.vLat;
            nextVLng -= reject * vel.vLng;
            nLat = pose.lat + nextVLat * dt;
            nLng = pose.lng + nextVLng * dt;
          }
        }
      }

      // Keep prediction smooth but bounded: never drift too far from
      // the latest road-snapped server point for long periods.
      const maxDriftM = viewerPreciseTurnWindow ? 7 : 11;
      const driftM = metersBetween({ lat: nLat, lng: nLng }, target);
      if (driftM > maxDriftM) {
        const ratio = maxDriftM / Math.max(driftM, 1e-6);
        nLat = target.lat + (nLat - target.lat) * ratio;
        nLng = target.lng + (nLng - target.lng) * ratio;
      }

      viewerPoseSmoothedRef.current = { lat: nLat, lng: nLng };
      viewerPoseVelRef.current = { vLat: nextVLat, vLng: nextVLng };

      dd.setLatLng([nLat, nLng]);
      if (arRef.current) arRef.current.setLatLng([nLat, nLng]);
      // Place vehicle at 60% from top (10% below centre) regardless of map rotation.
      // When the container is CSS-rotated by rotDeg, a screen offset of (0, +S)
      // corresponds to a layer offset of (S·sin(rotDeg), S·cos(rotDeg)).
      // We move the map centre by the negative of that offset so the driver ends up
      // at (screen_cx, screen_cy + S) — horizontally centred, vertically offset.
      const sz = mm.getSize();
      // Container is expanded when rotating; use layout width so zoom matches the phone screen.
      const isMapRotating = rotateWithHeadingRef.current && followModeRef.current;
      const layoutW = layoutViewportWidthRef.current;
      const viewportH = isMapRotating ? sz.y / 2.0 : sz.y;
      const viewportW =
        layoutW != null && layoutW > 0
          ? layoutW
          : isMapRotating
            ? sz.x / 2.6
            : sz.x;
      const S = viewportH * 0.10;                                   // 10% below centre = 60% from top
      const rotRad = isMapRotating ? (smoothHeadingRef.current * Math.PI) / 180 : 0;
      const driverPt = mm.latLngToLayerPoint([nLat, nLng]);
      const cPt = { x: driverPt.x - S * Math.sin(rotRad), y: driverPt.y - S * Math.cos(rotRad) };
      const centerLatLng = mm.layerPointToLatLng(cPt as import("leaflet").Point);

      // Compute target zoom from desired visible width (meters → Leaflet zoom level).
      // Web Mercator: m/px = 156543.03 * cos(lat) / 2^z.
      // Solve for z given target m/px = targetWidthM / viewportW:
      //   z = log2(viewportW * 40075017 * cos(lat) / (256 * targetWidthM))
      const clampedWidthZ = zoomForVisibleWidthM(
        nLat,
        viewportW,
        viewerTargetWidthRef.current,
        modeMaxZoom,
      );

      // When viewerFollowLatLngBounds is active, prefer the bounds-fitted zoom so
      // the map frame stays at the right level to show the whole area (e.g. the
      // full route driver→destination in the overview strip, or the current grid
      // cell in zone-pick mode).  Fall back to width-based zoom when bounds aren't set.
      const boundsZ = smoothGridFramingRef.current ? (viewerBoundsZoomRef.current ?? null) : null;
      const autoZ = boundsZ ?? clampedWidthZ;

      // Start one continuous zoom animation when width tier changes.
      const queuedWidth = viewerZoomAnimQueuedWidthRef.current;
      if (
        followMode &&
        !streamer &&
        queuedWidth != null &&
        queuedWidth > 0 &&
        userZoomOverrideRef.current == null &&
        boundsZ == null
      ) {
        viewerZoomAnimQueuedWidthRef.current = null;
        const toZ = zoomForVisibleWidthM(nLat, viewportW, queuedWidth, modeMaxZoom);
        const fromZ = mm.getZoom();
        if (Math.abs(toZ - fromZ) > 0.02) {
          viewerZoomAnimRef.current = {
            fromZ,
            toZ,
            startMs: performance.now(),
            durationMs: VIEWER_ZOOM_ANIM_MS,
          };
        }
      }

      // If user has manually zoomed, respect their choice; only pan.
      const targetZ = userZoomOverrideRef.current ?? autoZ;
      const curZ = mm.getZoom();
      let z = curZ;
      if (followMode && userZoomOverrideRef.current == null) {
        const anim = viewerZoomAnimRef.current;
        if (anim) {
          const p = Math.min(
            1,
            (performance.now() - anim.startMs) / anim.durationMs,
          );
          const eased = easeInOutCubic(p);
          z = anim.fromZ + (anim.toZ - anim.fromZ) * eased;
          if (p >= 1) {
            z = anim.toZ;
            viewerZoomAnimRef.current = null;
          }
        } else {
          z = targetZ;
        }
      }

      syncMapViewIfNeeded(
        mm,
        centerLatLng,
        z,
        viewerZoomAnimRef.current != null,
      );

      viewerSmoothRafRef.current = requestAnimationFrame(loop);
    };

    // Detect user-initiated zoom gestures (pinch on mobile, wheel on desktop).
    // Single-finger touch is panning — must NOT mark as interacting or every pan
    // will lock auto-zoom via the RAF loop's own zoomend event.
    let userIsInteracting = false;
    let interactTimeout: ReturnType<typeof setTimeout> | null = null;
    const markInteracting = () => {
      userIsInteracting = true;
      if (interactTimeout) clearTimeout(interactTimeout);
      interactTimeout = setTimeout(() => { userIsInteracting = false; }, 600);
    };
    const onTouchStart = (e: TouchEvent) => {
      // Only pinch (2+ fingers) is a zoom gesture on mobile.
      if (e.touches.length >= 2) markInteracting();
    };
    const onZoomEnd = () => {
      if (userIsInteracting) userZoomOverrideRef.current = m.getZoom();
    };
    const container = m.getContainer();
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("wheel", markInteracting, { passive: true });
    m.on("zoomend", onZoomEnd);

    viewerLoopLastTsRef.current = performance.now();
    viewerSmoothRafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelViewerLoop();
      if (interactTimeout) clearTimeout(interactTimeout);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("wheel", markInteracting);
      m.off("zoomend", onZoomEnd);
    };
  // driverPins intentionally omitted — read via driverPinsRef.current.
  }, [followMode, streamer, routePoints.length, viewerFollowZoom, viewerFollowLatLngBounds, transportMode, zoomLevelBonus]);

  return (
    <div className="relative h-full w-full" style={{ background: "transparent" }}>
      <div className="absolute inset-0 overflow-hidden">
        <div
          ref={rotationShellRef}
          style={
            {
              position: "absolute",
              transform: "rotate(0deg)",
              transformOrigin: "50% 50%",
              ...(rotateWithHeading && followMode
                ? {
                    inset: "-30% -50%",
                    transition: streamer
                      ? "transform 1100ms cubic-bezier(0.22,0.61,0.36,1)"
                      : undefined,
                  }
                : { inset: 0 }),
            } as CSSProperties
          }
        >
          <div
            ref={containerRef}
            className={className}
            style={{
              height: "100%",
              width: "100%",
              minHeight: 0,
              opacity: 0.9,
              touchAction: interactive ? "none" : "auto",
              pointerEvents: "auto",
            }}
          />
        </div>
      </div>
      {mapCaption && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[2000] p-1.5">
          <p
            className="text-center text-[8px] font-medium leading-tight [text-shadow:0_0_3px_#000,0_0_5px_#000]"
            style={{ color: "rgba(255,255,255,0.9)" }}
          >
            {mapCaption}
            {profile.showSpeed && routePoints.length > 0 && routePoints[routePoints.length - 1]?.speedMps != null
              ? ` · ${Math.round((routePoints[routePoints.length - 1]!.speedMps ?? 0) * 3.6)} km/h`
              : ""}
          </p>
        </div>
      )}
      <div
        className="pointer-events-none absolute right-2 top-2 z-[2000] flex flex-wrap items-start justify-between gap-1.5 sm:gap-2"
        style={{ left: leftInsetPx + 8 }}
      >
        <div className="flex flex-wrap items-center gap-1">
          {destinationRoute && destinationRoute.length > 1 ? (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-red-400/20 bg-black/65 px-1 py-px text-[7px] font-medium text-white/45 shadow-none"
              title={destinationRouteLabel ?? "Suggested path to destination on map"}
            >
              <span className="whitespace-nowrap">Google Maps</span>
              <span
                className="select-none font-mono text-[8px] font-semibold leading-none tracking-tight text-red-400/70"
                aria-hidden
              >
                − − −
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex max-w-[min(100%,240px)] flex-wrap justify-end gap-0.5 opacity-85 sm:max-w-[min(92%,280px)]">
          {(driverRouteBadges ?? []).map((label) => (
            <span
              key={label}
              className="rounded-full border border-sky-400/35 bg-sky-950/85 px-1.5 py-px text-[8px] font-medium leading-tight text-sky-100/80 shadow-sm"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export const LiveMap = memo(LiveMapInner);
