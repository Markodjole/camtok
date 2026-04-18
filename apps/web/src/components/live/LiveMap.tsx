"use client";

import { useEffect, useRef } from "react";
import type { RoutePoint } from "@/actions/live-feed";

interface LiveMapProps {
  routePoints: RoutePoint[];
  /** Extra CSS classes — used to size and position the map */
  className?: string;
  /** Show zoom/drag controls. Default false (overlay mode) */
  interactive?: boolean;
}

/**
 * Leaflet map rendered inside a plain div.
 * Uses a dynamic import so leaflet's window-dependent code never runs on the server.
 * The map auto-pans to the latest GPS point whenever `routePoints` changes.
 */
export function LiveMap({ routePoints, className, interactive = false }: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep stable references that effects can read without re-running.
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const polylineRef = useRef<import("leaflet").Polyline | null>(null);
  const markerRef = useRef<import("leaflet").CircleMarker | null>(null);
  const headingMarkerRef = useRef<import("leaflet").Marker | null>(null);

  // Init map once.
  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let map: import("leaflet").Map | null = null;

    void (async () => {
      const L = (await import("leaflet")).default;

      // Inject leaflet CSS once.
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }

      if (cancelled || !containerRef.current) return;

      const center: [number, number] =
        routePoints.length > 0
          ? [routePoints[routePoints.length - 1].lat, routePoints[routePoints.length - 1].lng]
          : [48.8566, 2.3522]; // Paris fallback

      map = L.map(containerRef.current, {
        center,
        zoom: 17,
        zoomControl: interactive,
        dragging: interactive,
        scrollWheelZoom: false,
        touchZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        attributionControl: false,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      // Path polyline.
      const latlngs: [number, number][] = routePoints.map((p) => [p.lat, p.lng]);
      polylineRef.current = L.polyline(latlngs, {
        color: "#6366f1",
        weight: 4,
        opacity: 0.85,
      }).addTo(map);

      // Current position dot.
      if (routePoints.length > 0) {
        const last = routePoints[routePoints.length - 1];
        markerRef.current = L.circleMarker([last.lat, last.lng], {
          radius: 8,
          fillColor: "#ef4444",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);
      }

      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      polylineRef.current = null;
      markerRef.current = null;
      headingMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  // Update path + re-pan whenever routePoints change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || routePoints.length === 0) return;

    void (async () => {
      const L = (await import("leaflet")).default;
      const latlngs: [number, number][] = routePoints.map((p) => [p.lat, p.lng]);

      if (polylineRef.current) {
        polylineRef.current.setLatLngs(latlngs);
      }

      const last = routePoints[routePoints.length - 1];
      const pos: [number, number] = [last.lat, last.lng];

      if (markerRef.current) {
        markerRef.current.setLatLng(pos);
      } else {
        markerRef.current = L.circleMarker(pos, {
          radius: 8,
          fillColor: "#ef4444",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);
      }

      map.panTo(pos, { animate: true, duration: 0.5 });
    })();
  }, [routePoints]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ background: "#1a1a2e" }}
    />
  );
}
