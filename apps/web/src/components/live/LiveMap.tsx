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

function mapProfile(mode?: string): {
  zoom: number;
  lineWeight: number;
  showSpeed: boolean;
  speedUnit: "kmh" | "none";
} {
  const m = (mode ?? "").toLowerCase();
  if (m.includes("car") || m.includes("drive")) {
    return { zoom: 16, lineWeight: 4, showSpeed: true, speedUnit: "kmh" };
  }
  if (m.includes("bike") || m.includes("cycle")) {
    return { zoom: 17, lineWeight: 4, showSpeed: true, speedUnit: "kmh" };
  }
  // walking / default
  return { zoom: 18, lineWeight: 3, showSpeed: false, speedUnit: "none" };
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
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").TileLayer | null>(null);
  const plRef = useRef<import("leaflet").Polyline | null>(null);
  const dotRef = useRef<import("leaflet").CircleMarker | null>(null);
  const arRef = useRef<import("leaflet").Marker | null>(null);
  const zoneLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const checkpointLayerRef = useRef<import("leaflet").LayerGroup | null>(null);
  const hasAppliedInitialZoomRef = useRef(false);
  const onUserInteractRef = useRef<(() => void) | undefined>(undefined);
  const motionRafRef = useRef<number | null>(null);
  const lastGpsAtMsRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(0);
  const [rotationDeg, setRotationDeg] = useState(0);
  useEffect(() => {
    onUserInteractRef.current = onUserInteract;
  }, [onUserInteract]);
  const streamer = audienceRole === "streamer";
  const col = streamer ? C.streamer : C.viewer;
  const profile = mapProfile(transportMode);

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
      layerRef.current = t;
      mapRef.current = m;
      setMapReady((n) => n + 1);
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
    (async () => {
      const L = (await import("leaflet")).default;
      group.clearLayers();
      if (!showZones) return;
      zones.forEach((zone) => {
        const selected = selectedZoneId === zone.id;
        const isActive = zone.isActive !== false;
        const color = zone.color ?? "#60a5fa";
        const poly = L.polygon(
          zone.polygon.map((p) => [p.lat, p.lng] as [number, number]),
          {
            color: selected ? "#ffffff" : color,
            weight: selected ? 3 : 2,
            fillColor: color,
            fillOpacity: isActive ? (selected ? 0.35 : 0.2) : 0.08,
            opacity: isActive ? 0.9 : 0.35,
          },
        );
        if (interactive && onZoneSelect) {
          poly.on("click", () => onZoneSelect(selected ? null : zone.id));
        }
        poly.addTo(group);
      });
    })();
  }, [zones, selectedZoneId, showZones, interactive, onZoneSelect, mapReady]);

  useEffect(() => {
    const group = checkpointLayerRef.current;
    if (!group) return;
    (async () => {
      const L = (await import("leaflet")).default;
      group.clearLayers();
      if (!showCheckpoints) return;
      checkpoints.forEach((cp) => {
        const selected = selectedCheckpointId === cp.id;
        const isActive = cp.isActive !== false;
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
    })();
  }, [
    checkpoints,
    selectedCheckpointId,
    showCheckpoints,
    interactive,
    onCheckpointSelect,
    mapReady,
  ]);

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
      if (dotRef.current) {
        dotRef.current.setLatLng(pos);
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
      if (arRef.current) { m.removeLayer(arRef.current); arRef.current = null; }
      if (showCourseArrow && last.heading != null) {
        arRef.current = L.marker(pos, {
          icon: headingDivIcon(L, last.heading, streamer),
          interactive: false,
          zIndexOffset: 500,
        }).addTo(m);
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
        setRotationDeg(-last.heading);
      } else if (followMode) {
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
    const heading = last.heading ?? 0;

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
        if (rotateWithHeading) setRotationDeg(-heading);
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
  }, [routePoints, followMode, rotateWithHeading]);

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
                  transition: "transform 240ms linear",
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
      {turnHint ? (
        <div className="pointer-events-none absolute left-1/2 top-1 z-[2001] -translate-x-1/2">
          <div
            className={[
              "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide [text-shadow:0_0_3px_#000,0_0_5px_#000]",
              turnHintEtaSec == null || turnHintEtaSec > 12
                ? "border-emerald-300/55 bg-emerald-500/20 text-emerald-100"
                : turnHintEtaSec > 6
                  ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
                  : "border-rose-300/65 bg-rose-500/30 text-rose-100",
            ].join(" ")}
          >
            AI next: {turnHint}
            {turnHintEtaSec != null ? ` · ETA ${Math.max(0, Math.round(turnHintEtaSec))}s` : ""}
            {turnHintDistanceM != null ? ` · ~${Math.max(0, Math.round(turnHintDistanceM))}m` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}
