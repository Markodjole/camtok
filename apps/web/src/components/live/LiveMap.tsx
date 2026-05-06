"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { RoutePoint } from "@/actions/live-feed";
import { metersBetween } from "@/lib/live/routing/geometry";

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
  /** UI label for destination route badge. */
  destinationRouteLabel?: string | null;
  /** Short labels derived from `driving_route_style` (shown to viewers & streamer). */
  driverRouteBadges?: string[] | null;
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
  /** Muted polygons for engine-highlighted zone overlays. */
  zonesVisualStyle?: "default" | "muted" | "pick_zone";
}

const C = {
  streamer: { line: "#22c55e", lineOp: 0.5, fill: "#4ade80", r: 7 },
  viewer: { line: "#22c55e", lineOp: 0.5, fill: "#4ade80", r: 7 },
};

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
  if (m.includes("bike") || m.includes("cycle")) {
    return { zoom: 17 + bonus, lineWeight: 4, showSpeed: true, speedUnit: "kmh" };
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

/** Zoom target approaches this fraction of the remaining delta per animation frame (~60fps). */
const VIEWER_ZOOM_BLEND_PER_FRAME = 0.06;

/** With `viewerFollowLatLngBounds`, never go wider than this (higher = closer). */
const VIEWER_FOLLOW_BOUNDS_ZOOM_FLOOR = 14;

/**
 * After `getBoundsZoom`, nudge **in** (viewer only) — fitBounds alone kept the
 * camera too loose for navigation-style follow.
 */
const VIEWER_FIT_BOUNDS_ZOOM_BIAS = 0.25;

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

export function LiveMap({
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
  selectedCheckpointId = null,
  showZones = true,
  showCheckpoints = true,
  onZoneSelect,
  onCheckpointSelect,
  followMode = true,
  onUserInteract,
  turnTarget = null,
  driverPins = null,
  approachLine = null,
  railPhase = "none",
  destination = null,
  destinationRoute = null,
  destinationRouteLabel = "Google suggested route",
  driverRouteBadges = null,
  viewerFollowZoom = null,
  viewerFollowLatLngBounds = null,
  viewerFollowBoundsMinZoom = null,
  zonesVisualStyle = "default" as "default" | "muted" | "pick_zone",
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
  const destLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
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
  const smoothHeadingRef = useRef<number>(0);
  /** CSS wrapper rotation target (degrees); `-vehicleHeading`. Viewer RAF eases toward this. */
  const viewerMapRotationTargetRef = useRef<number>(0);
  const rotateWithHeadingRef = useRef(false);
  const viewerTurnPinRef = useRef<{ lat: number; lng: number } | null>(null);
  const [mapReady, setMapReady] = useState(0);
  const [rotationDeg, setRotationDeg] = useState(0);
  const rotationDegRef = useRef(0);
  rotationDegRef.current = rotationDeg;
  useEffect(() => {
    onUserInteractRef.current = onUserInteract;
  }, [onUserInteract]);
  routePointsLenRef.current = routePoints.length;
  followModeRef.current = followMode;
  viewerFollowZoomRef.current = viewerFollowZoom ?? null;
  smoothGridFramingRef.current = viewerFollowLatLngBounds != null;
  rotateWithHeadingRef.current = rotateWithHeading;
  const streamer = audienceRole === "streamer";
  const showHistoryPath = true;
  const smoothMotion = true;
  const col = streamer ? C.streamer : C.viewer;
  const profile = mapProfile(transportMode, streamer ? "streamer" : "viewer");
  const viewerFollowProfileZoom = streamer
    ? profile.zoom
    : profile.zoom + VIEWER_FOLLOW_ZOOM_EXTRA;

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const deg =
      rotateWithHeading && followMode ? -rotationDeg : 0;
    root.querySelectorAll<HTMLElement>(".camtok-dest-screen-flat").forEach((node) => {
      node.style.transform = `rotate(${deg}deg)`;
      node.style.transformOrigin = "50% 100%";
    });
  }, [rotationDeg, rotateWithHeading, followMode, mapReady, destination]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!rotateWithHeading || !followMode) {
      el.style.setProperty("--camtok-map-rotation", "0deg");
      return;
    }
    el.style.setProperty("--camtok-map-rotation", `${rotationDeg}deg`);
  }, [rotationDeg, rotateWithHeading, followMode]);

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
      // OSM tiles cap at ~19 — keep target aligned so we actually reach max detail.
      const maxZ = 19;
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
      const t = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        opacity: 0.4,
        keepBuffer: 8,
        updateWhenIdle: false,
      });
      t.addTo(m);
      zoneLayerRef.current = L.layerGroup().addTo(m);
      checkpointLayerRef.current = L.layerGroup().addTo(m);
      destLayerRef.current = L.layerGroup().addTo(m);
      railLayerRef.current = L.layerGroup().addTo(m);
      turnLayerRef.current = L.layerGroup().addTo(m);
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
      railLayerRef.current = null;
      turnLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    layerRef.current?.setOpacity(tileOpacity);
  }, [tileOpacity]);

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
            // Light strokes + very low fill so roads read; zone hue only hints inside cells.
            let strokeColor: string;
            let strokeWeight: number;
            let fillC: string;
            let fillOp: number;
            let dashArr: string | undefined;
            if (pickZone) {
              // All non-current cells: visible border + subtle pastel tint.
              // Current cell (selected or active): highlighted.
              strokeColor = selected
                ? "rgba(255,255,255,0.90)"
                : "rgba(148,163,184,0.75)";
              strokeWeight = selected ? 2.5 : 1.6;
              fillC = selected ? color : color;
              fillOp = selected ? 0.18 : isActive ? 0.09 : 0.04;
              dashArr = selected ? undefined : undefined;
            } else if (muted) {
              strokeColor = selected
                ? "rgba(255,255,255,0.62)"
                : "rgba(203,213,225,0.42)";
              strokeWeight = selected ? 1.75 : 1.1;
              fillC = "rgba(148,163,184,0.5)";
              fillOp = selected ? 0.06 : isActive ? 0.035 : 0.02;
              dashArr = selected ? undefined : "6 5";
            } else {
              strokeColor = selected
                ? "rgba(255,255,255,0.78)"
                : "rgba(248,250,252,0.38)";
              strokeWeight = selected ? 2.25 : 1.5;
              fillC = color;
              fillOp = selected
                ? isActive ? 0.1 : 0.05
                : isActive ? 0.055 : 0.028;
              dashArr = selected ? undefined : "7 5";
            }
            const poly = L.polygon(latlngs, {
              color: strokeColor,
              weight: strokeWeight,
              fillColor: fillC,
              fillOpacity: fillOp,
              opacity: 1,
              dashArray: dashArr,
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
  }, [zones, selectedZoneId, showZones, interactive, onZoneSelect, mapReady, audienceRole, zonesVisualStyle]);

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

      if (
        destinationRoute &&
        destinationRoute.length >= 2 &&
        destinationRoute.every(
          (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
        )
      ) {
        const pts = destinationRoute.map(
          (p) => [p.lat, p.lng] as [number, number],
        );
        const line = L.polyline(pts, {
          color: "#ef4444",
          weight: 3,
          opacity: 0.38,
          dashArray: "7 9",
          lineCap: "round",
          lineJoin: "round",
        }).addTo(group);
        line.bringToBack?.();
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
        queueMicrotask(() => {
          const root = containerRef.current;
          if (!root) return;
          const deg =
            rotateWithHeadingRef.current && followModeRef.current
              ? -rotationDegRef.current
              : 0;
          root
            .querySelectorAll<HTMLElement>(".camtok-dest-screen-flat")
            .forEach((node) => {
              node.style.transform = `rotate(${deg}deg)`;
              node.style.transformOrigin = "50% 100%";
            });
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
    mapReady,
    streamer,
  ]);

  useEffect(() => {
    const group = turnLayerRef.current;
    const rail = railLayerRef.current;
    if (!group || !rail) return;
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
          radius: 16,
          color: "#2563eb",
          weight: 2,
          fillColor: "#3b82f6",
          fillOpacity: 0.22,
          opacity: 0.9,
        }).addTo(group);
        L.circleMarker([nextPin.lat, nextPin.lng], {
          radius: 7,
          color: "#ffffff",
          weight: 2,
          fillColor: "#2563eb",
          fillOpacity: 1,
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
  }, [turnTarget, driverPins, approachLine, mapReady, audienceRole]);

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
      const viewerTurnPinActive =
        !streamer &&
        viewerFollowLatLngBounds == null &&
        (viewerFollowZoom == null || !Number.isFinite(viewerFollowZoom)) &&
        (turnTarget != null ||
          (driverPins != null &&
            driverPins.length > 0 &&
            Number.isFinite(driverPins[0]?.lat)));
      const navZoomFloor = viewerTurnPinActive
        ? Math.max(viewerFollowProfileZoom, 17.5)
        : viewerFollowProfileZoom;
      viewerTurnNavZoomRef.current = viewerTurnPinActive ? navZoomFloor : null;
      const baseZoom = viewerFollowLatLngBounds
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
          // Do not hard-set marker lat/lng here; RAF loop animates it smoothly.
          arRef.current.setIcon(headingDivIcon(L, last.heading, streamer));
        } else {
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
          setRotationDeg(smoothHeadingRef.current);
          const root = containerRef.current;
          if (root) {
            const deg = -smoothHeadingRef.current;
            root
              .querySelectorAll<HTMLElement>(".camtok-dest-screen-flat")
              .forEach((node) => {
                node.style.transform = `rotate(${deg}deg)`;
                node.style.transformOrigin = "50% 100%";
              });
          }
        } else {
          viewerMapRotationTargetRef.current = target;
        }
      } else if (followMode) {
        smoothHeadingRef.current = 0;
        viewerMapRotationTargetRef.current = 0;
        setRotationDeg(0);
        const root = containerRef.current;
        if (root) {
          root
            .querySelectorAll<HTMLElement>(".camtok-dest-screen-flat")
            .forEach((node) => {
              node.style.transform = "rotate(0deg)";
              node.style.transformOrigin = "50% 100%";
            });
        }
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
    driverPins,
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

    const blend = 0.28;
    const vr = viewerVelSmoothedRef.current;
    vr.vLat = vr.vLat * (1 - blend) + measVLat * blend;
    vr.vLng = vr.vLng * (1 - blend) + measVLng * blend;

    const vmag = Math.hypot(vr.vLat, vr.vLng);
    const maxDegPerSec = 0.0028;
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

    const cancelViewerLoop = () => {
      if (viewerSmoothRafRef.current != null) {
        cancelAnimationFrame(viewerSmoothRafRef.current);
        viewerSmoothRafRef.current = null;
      }
      viewerPoseSmoothedRef.current = null;
      viewerVelSmoothedRef.current = { vLat: 0, vLng: 0 };
      viewerPoseVelRef.current = { vLat: 0, vLng: 0 };
      viewerLastPollTsRef.current = 0;
      viewerLoopLastTsRef.current = 0;
    };

    if (!m || !dot || routePoints.length === 0 || !followMode) {
      cancelBurst();
      cancelViewerLoop();
      return () => {
        cancelBurst();
        cancelViewerLoop();
      };
    }

    if (!streamer) {
      cancelBurst();
      return () => {
        cancelBurst();
      };
    }

    cancelViewerLoop();

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
        const viewportH = isMapRotating ? sz.y / 1.8 : sz.y;
        const S = viewportH * 0.10;
        const rotRad = isMapRotating ? (rotationDegRef.current * Math.PI) / 180 : 0;
        const driverPt = m.latLngToLayerPoint(livePos);
        const cPt = { x: driverPt.x - S * Math.sin(rotRad), y: driverPt.y - S * Math.cos(rotRad) };
        m.setView(m.layerPointToLatLng(cPt as import("leaflet").Point), m.getZoom(), { animate: false });
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
    const dot = dotRef.current;

    const cancelViewerLoop = () => {
      if (viewerSmoothRafRef.current != null) {
        cancelAnimationFrame(viewerSmoothRafRef.current);
        viewerSmoothRafRef.current = null;
      }
      viewerPoseSmoothedRef.current = null;
      viewerVelSmoothedRef.current = { vLat: 0, vLng: 0 };
      viewerLoopLastTsRef.current = 0;
    };

    if (
      streamer ||
      !followMode ||
      routePoints.length === 0 ||
      !m ||
      !dot
    ) {
      cancelViewerLoop();
      return cancelViewerLoop;
    }

    const BASE_STIFFNESS = 10.5;
    const PRECISE_STIFFNESS = 26;
    const BASE_PROJECT_SEC = 0.75;
    const PRECISE_PROJECT_SEC = 0.2;
    const NEGATIVE_SPEED_EPS = 1e-8;
    const TURN_PRECISE_PRE_M = 50;
    const TURN_PRECISE_POST_M = 20;

    const loop = (now: number) => {
      const mm = mapRef.current;
      const dd = dotRef.current;
      if (
        !mm ||
        !dd ||
        routePointsLenRef.current === 0 ||
        !followModeRef.current
      ) {
        cancelViewerLoop();
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
        setRotationDeg(smoothHeadingRef.current);
        const root = containerRef.current;
        if (root) {
          const deg = -smoothHeadingRef.current;
          root
            .querySelectorAll<HTMLElement>(".camtok-dest-screen-flat")
            .forEach((node) => {
              node.style.transform = `rotate(${deg}deg)`;
              node.style.transformOrigin = "50% 100%";
            });
        }
      }

      const target = viewerPollTargetRef.current;
      const vel = viewerVelSmoothedRef.current;
      const nextPin = driverPins?.[0] ?? null;
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
      const targetZ =
        viewerBoundsZoomRef.current ??
        viewerFollowZoomRef.current ??
        viewerTurnNavZoomRef.current;
      const curZ = mm.getZoom();
      let z = curZ;
      if (followMode && targetZ != null && Number.isFinite(targetZ)) {
        // Always blend smoothly regardless of smoothGridFramingRef.
        const dz = targetZ - curZ;
        if (Math.abs(dz) < 0.01) {
          z = targetZ;
        } else {
          z = curZ + dz * VIEWER_ZOOM_BLEND_PER_FRAME;
        }
      }
      // Place vehicle at 60% from top (10% below centre) regardless of map rotation.
      // When the container is CSS-rotated by rotDeg, a screen offset of (0, +S)
      // corresponds to a layer offset of (S·sin(rotDeg), S·cos(rotDeg)).
      // We move the map centre by the negative of that offset so the driver ends up
      // at (screen_cx, screen_cy + S) — horizontally centred, vertically offset.
      const sz = mm.getSize();
      // Container is expanded 24% on each side when rotating; recover viewport height.
      const isMapRotating = rotateWithHeadingRef.current && followModeRef.current;
      const viewportH = isMapRotating ? sz.y / 1.8 : sz.y;
      const S = viewportH * 0.10;                                   // 10% below centre = 60% from top
      const rotRad = isMapRotating ? (smoothHeadingRef.current * Math.PI) / 180 : 0;
      const driverPt = mm.latLngToLayerPoint([nLat, nLng]);
      const cPt = { x: driverPt.x - S * Math.sin(rotRad), y: driverPt.y - S * Math.cos(rotRad) };
      const centerLatLng = mm.layerPointToLatLng(cPt as import("leaflet").Point);
      mm.setView(centerLatLng, z, { animate: false });

      viewerSmoothRafRef.current = requestAnimationFrame(loop);
    };

    viewerLoopLastTsRef.current = performance.now();
    viewerSmoothRafRef.current = requestAnimationFrame(loop);

    return cancelViewerLoop;
  }, [followMode, streamer, routePoints.length, driverPins, viewerFollowZoom, viewerFollowLatLngBounds]);

  return (
    <div className="relative h-full w-full" style={{ background: "rgba(10,10,20,0.4)" }}>
      <div className="absolute inset-0 overflow-hidden">
        <div
          style={
            {
              position: "absolute",
              "--camtok-map-rotation":
                rotateWithHeading && followMode ? `${rotationDeg}deg` : "0deg",
              ...(rotateWithHeading && followMode
                ? {
                    inset: "-40%",
                    transform: `rotate(${rotationDeg}deg)`,
                    transformOrigin: "50% 50%",
                    transition: streamer
                      ? "transform 1100ms cubic-bezier(0.22,0.61,0.36,1), --camtok-map-rotation 1100ms cubic-bezier(0.22,0.61,0.36,1)"
                      : "none",
                  }
                : { inset: 0 }),
            } as CSSProperties & { "--camtok-map-rotation"?: string }
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
      <div className="pointer-events-none absolute left-2 right-2 top-2 z-[2000] flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {destinationRoute && destinationRoute.length > 1 ? (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-red-400/20 bg-black/30 px-1 py-px text-[7px] font-medium text-white/45 shadow-none backdrop-blur-[2px]"
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
        <div className="flex max-w-[min(92%,280px)] flex-wrap justify-end gap-0.5 opacity-85">
          {(driverRouteBadges ?? []).map((label) => (
            <span
              key={label}
              className="rounded-full border border-sky-400/35 bg-sky-950/55 px-1.5 py-px text-[8px] font-medium leading-tight text-sky-100/80 shadow-sm backdrop-blur-sm"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
