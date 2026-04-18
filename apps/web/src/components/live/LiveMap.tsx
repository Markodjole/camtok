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
  audienceRole?: "streamer" | "viewer";
  showCourseArrow?: boolean;
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

export function LiveMap({
  routePoints,
  className = "",
  interactive = false,
  tileOpacity = 0.36,
  mapCaption,
  audienceRole = "viewer",
  showCourseArrow = true,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const layerRef = useRef<import("leaflet").TileLayer | null>(null);
  const plRef = useRef<import("leaflet").Polyline | null>(null);
  const dotRef = useRef<import("leaflet").CircleMarker | null>(null);
  const arRef = useRef<import("leaflet").Marker | null>(null);
  const [mapReady, setMapReady] = useState(0);
  const streamer = audienceRole === "streamer";
  const col = streamer ? C.streamer : C.viewer;

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
        zoomControl: interactive,
        dragging: interactive,
        scrollWheelZoom: false,
        touchZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        attributionControl: false,
      });
      const t = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, opacity: 0.4 });
      t.addTo(m);
      layerRef.current = t;
      mapRef.current = m;
      setMapReady((n) => n + 1);
    })();
    return () => {
      done = true;
      plRef.current = null;
      dotRef.current = null;
      arRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [interactive]);

  useEffect(() => {
    layerRef.current?.setOpacity(tileOpacity);
  }, [tileOpacity]);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    (async () => {
      const L = (await import("leaflet")).default;
      if (routePoints.length === 0) {
        if (arRef.current) { m.removeLayer(arRef.current); arRef.current = null; }
        if (plRef.current) { m.removeLayer(plRef.current); plRef.current = null; }
        if (dotRef.current) { m.removeLayer(dotRef.current); dotRef.current = null; }
        return;
      }
      const last = routePoints[routePoints.length - 1]!;
      const pos: [number, number] = [last.lat, last.lng];
      const latlngs: [number, number][] = routePoints.map((p) => [p.lat, p.lng]);

      if (plRef.current) {
        plRef.current.setLatLngs(latlngs);
        plRef.current.setStyle({ color: col.line, weight: 3, opacity: col.lineOp });
      } else {
        plRef.current = L.polyline(latlngs, { color: col.line, weight: 3, opacity: col.lineOp }).addTo(m);
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
      m.setView(pos, 17, { animate: true, duration: 0.4 });
    })();
  }, [routePoints, col, streamer, showCourseArrow, col.line, col.lineOp, col.fill, col.r, mapReady]);

  return (
    <div className="relative h-full w-full" style={{ background: "rgba(10,10,20,0.4)" }}>
      <div
        ref={containerRef}
        className={className}
        style={{ height: "100%", width: "100%", minHeight: 0, opacity: 0.9 }}
      />
      {mapCaption && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[2000] p-1.5">
          <p
            className="text-center text-[8px] font-medium leading-tight [text-shadow:0_0_3px_#000,0_0_5px_#000]"
            style={{ color: "rgba(255,255,255,0.9)" }}
          >
            {mapCaption}
          </p>
        </div>
      )}
    </div>
  );
}
