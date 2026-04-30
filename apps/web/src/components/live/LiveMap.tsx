"use client";

import { useEffect, useRef, useState } from "react";
import type { RoutePoint } from "@/actions/live-feed";

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
}

const C = {
  streamer: { line: "#22c55e", lineOp: 0.5, fill: "#4ade80", r: 7 },
  viewer: { line: "#a78bfa", lineOp: 0.4, fill: "#fb7185", r: 6 },
};

function headingDivIcon(L: { divIcon: (o: object) => import("leaflet").DivIcon }, deg: number, streamer: boolean) {
  const m = streamer ? 24 : 19;
  const c = streamer ? "#4ade80" : "#c4b5fd";
  const html = `<div style="width:52px;height:52px;display:flex;align-items:center;justify-content:center;transform:rotate(${deg}deg)">
    <div style="width:0;height:0;border-left:${m * 0.35}px solid transparent;border-right:${m * 0.35}px solid transparent;
      border-bottom:${m * 0.8}px solid ${c};filter:drop-shadow(0 0 2px #000)"></div></div>`;
  return L.divIcon({ html, className: "camtok-h", iconSize: [52, 52], iconAnchor: [26, 26] });
}

function mapProfile(
  mode?: string,
  role: "streamer" | "viewer" = "viewer",
): {
  zoom: number;
  lineWeight: number;
  showSpeed: boolean;
  speedUnit: "kmh" | "none";
} {
  const m = (mode ?? "").toLowerCase();
  const bonus = role === "streamer" ? 1 : 0;
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
  const smoothHeadingRef = useRef<number>(0);
  const [mapReady, setMapReady] = useState(0);
  const [rotationDeg, setRotationDeg] = useState(0);
  useEffect(() => {
    onUserInteractRef.current = onUserInteract;
  }, [onUserInteract]);
  const streamer = audienceRole === "streamer";
  const showHistoryPath = true;
  const smoothMotion = true;
  const col = streamer ? C.streamer : C.viewer;
  const profile = mapProfile(transportMode, streamer ? "streamer" : "viewer");

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
      const t = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, opacity: 0.4 });
      t.addTo(m);
      zoneLayerRef.current = L.layerGroup().addTo(m);
      checkpointLayerRef.current = L.layerGroup().addTo(m);
      destLayerRef.current = L.layerGroup().addTo(m);
      railLayerRef.current = L.layerGroup().addTo(m);
      turnLayerRef.current = L.layerGroup().addTo(m);
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
            const poly = L.polygon(latlngs, {
              color: selected ? "#ffffff" : color,
              weight: selected ? 5 : 4,
              fillColor: color,
              fillOpacity: isActive ? (selected ? 0.55 : 0.4) : 0.15,
              opacity: 1,
              dashArray: selected ? undefined : "6 4",
            });
            if (interactive && onZoneSelect) {
              poly.on("click", () => onZoneSelect(selected ? null : zone.id));
            }
            poly.addTo(group);
            if (/^[A-Z][A-Z]*\d+$/.test(zone.name) && zones.length <= 140) {
              poly.bindTooltip(zone.name, {
                permanent: true,
                direction: "center",
                className: "camtok-grid-cell-lbl",
              });
            }
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
  }, [zones, selectedZoneId, showZones, interactive, onZoneSelect, mapReady, audienceRole]);

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
        L.polyline(pts, {
          color: "#000000",
          weight: 9,
          opacity: 0.25,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(group);
        L.polyline(pts, {
          color: "#ef4444",
          weight: 6,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(group);
      }

      if (
        destination &&
        Number.isFinite(destination.lat) &&
        Number.isFinite(destination.lng)
      ) {
        const html =
          `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-2px)">
            <div style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:2px solid white;box-shadow:0 0 8px rgba(0,0,0,0.85)"></div>
            <div style="width:2px;height:10px;background:#ef4444;box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>
          </div>`;
        const icon = L.divIcon({
          html,
          className: "camtok-destination-pin",
          iconSize: [22, 32],
          iconAnchor: [11, 30],
        });
        const marker = L.marker([destination.lat, destination.lng], {
          icon,
          interactive: false,
          zIndexOffset: 1000,
        });
        if (destination.label) {
          marker.bindTooltip(destination.label, {
            permanent: true,
            direction: "top",
            offset: [0, -28],
            className: "camtok-destination-tip",
          });
        }
        marker.addTo(group);
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

      // Approach line: backend hands us the exact 50 m road segment that
      // ends at the first pin. We draw it directly (no client-side trim)
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
      const targetZoom = interactive
        ? hasAppliedInitialZoomRef.current
          ? m.getZoom()
          : profile.zoom
        : profile.zoom;

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
          }).addTo(m);
        }
      } else if (arRef.current) {
        m.removeLayer(arRef.current);
        arRef.current = null;
      }
      if (followMode) {
        if (isFirstFollowFrame) {
          m.setView(pos, targetZoom, { animate: true, duration: 0.45 });
        }
        hasAppliedInitialZoomRef.current = true;
      }

      // Rotate map opposite of heading so "forward" remains screen-up.
      // Rotation is applied to an oversized wrapper (see JSX), not the map box,
      // to avoid empty corners while preserving a fully filled frame.
      if (followMode && rotateWithHeading && last.heading != null) {
        const target = -last.heading;
        if (!hasAppliedInitialZoomRef.current) {
          smoothHeadingRef.current = target;
        } else {
          const delta = normalizeAngleDeg(target - smoothHeadingRef.current);
          // Lower coefficient = slower rotation. This eases the map into the new
          // heading over several GPS updates so turns feel gradual.
          smoothHeadingRef.current = normalizeAngleDeg(
            smoothHeadingRef.current + delta * 0.12,
          );
        }
        setRotationDeg(smoothHeadingRef.current);
      } else if (followMode) {
        smoothHeadingRef.current = 0;
        setRotationDeg(0);
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
    profile.zoom,
    profile.lineWeight,
    rotateWithHeading,
    followMode,
  ]);

  useEffect(() => {
    const m = mapRef.current;
    const dot = dotRef.current;
    if (!m || !dot || routePoints.length === 0) return;

    const last = routePoints[routePoints.length - 1]!;
    const prev = routePoints.length > 1 ? routePoints[routePoints.length - 2]! : null;
    const current = dot.getLatLng();
    const startPos: [number, number] = [current.lat, current.lng];
    const targetPos: [number, number] = [last.lat, last.lng];

    const now = performance.now();
    const sinceLastGpsSec = lastGpsAtMsRef.current != null ? Math.max(0.7, Math.min(2.8, (now - lastGpsAtMsRef.current) / 1000)) : 1.2;
    lastGpsAtMsRef.current = now;

    const vLatPerSec = prev ? (last.lat - prev.lat) / sinceLastGpsSec : 0;
    const vLngPerSec = prev ? (last.lng - prev.lng) / sinceLastGpsSec : 0;
    const settleMs = 800;
    const tailMs = 1400;
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
        m.setView(livePos, m.getZoom(), { animate: false });
        // Rotation is smoothed in the GPS-update effect and eased by CSS;
        // avoid per-frame snaps here so turns feel gradual.
      }

      if (t < totalMs) {
        motionRafRef.current = requestAnimationFrame(tick);
      }
    };
    motionRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (motionRafRef.current != null) cancelAnimationFrame(motionRafRef.current);
      motionRafRef.current = null;
    };
  }, [routePoints, followMode, rotateWithHeading, smoothMotion]);

  return (
    <div className="relative h-full w-full" style={{ background: "rgba(10,10,20,0.4)" }}>
      <div className="absolute inset-0 overflow-hidden">
        <div
          style={
            rotateWithHeading && followMode
              ? {
                  position: "absolute",
                  inset: "-24%",
                  transform: `rotate(${rotationDeg}deg)`,
                  transformOrigin: "50% 50%",
                  transition: "transform 1100ms cubic-bezier(0.22,0.61,0.36,1)",
                }
              : {
                  position: "absolute",
                  inset: 0,
                }
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
      {destinationRoute && destinationRoute.length > 1 ? (
        <div className="pointer-events-none absolute left-2 top-2 z-[2000]">
          <span className="rounded-full border border-red-300/60 bg-red-500/80 px-2 py-1 text-[10px] font-semibold tracking-wide text-white shadow-md">
            Google suggested route
          </span>
        </div>
      ) : null}
    </div>
  );
}
