"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PickedDestination = {
  lat: number;
  lng: number;
  label: string;
  placeId: string | null;
};

type Suggestion = {
  placeId: string;
  primary: string;
  secondary: string | null;
  fullText: string;
};

function newSessionToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/**
 * Driver-facing destination input. Text autocomplete is the primary UX
 * (typing "town hall" pulls the right place near the current GPS), with
 * a fallback "Pick on map" mode for when the driver wants to drop a pin
 * at an arbitrary location.
 */
export function DestinationPicker({
  value,
  onChange,
  bias,
  variant = "full",
  noTopLabel = false,
}: {
  value: PickedDestination | null;
  onChange: (next: PickedDestination | null) => void;
  bias?: { lat: number; lng: number } | null;
  /** `searchOnly` — text autocomplete only (no map pin mode). */
  variant?: "full" | "searchOnly";
  /** Parent already rendered a section title. */
  noTopLabel?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pickerMode, setPickerMode] = useState<"none" | "map">("none");
  const [mapPin, setMapPin] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionTokenRef = useRef<string>(newSessionToken());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const biasParam = useMemo(() => {
    if (!bias) return "";
    return `&lat=${bias.lat.toFixed(6)}&lng=${bias.lng.toFixed(6)}`;
  }, [bias]);

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const url =
          `/api/live/places/autocomplete?input=${encodeURIComponent(query.trim())}` +
          `&sessionToken=${sessionTokenRef.current}${biasParam}`;
        const r = await fetch(url, { cache: "no-store", signal: ac.signal });
        if (!r.ok) {
          setSuggestions([]);
          return;
        }
        const j = (await r.json()) as { suggestions: Suggestion[] };
        setSuggestions(j.suggestions ?? []);
      } catch {
        /* aborted/transient */
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, biasParam]);

  async function pickFromSuggestion(s: Suggestion) {
    setShowSuggestions(false);
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/live/places/details?placeId=${encodeURIComponent(s.placeId)}` +
          `&sessionToken=${sessionTokenRef.current}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as { destination: PickedDestination | null };
      if (!j.destination) {
        setError("Couldn't load that place. Try another.");
        return;
      }
      onChange(j.destination);
      setQuery(j.destination.label);
      sessionTokenRef.current = newSessionToken();
    } catch {
      setError("Network error while loading the place.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmMapPin() {
    if (!mapPin) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/live/places/details?lat=${mapPin.lat.toFixed(6)}&lng=${mapPin.lng.toFixed(6)}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as { destination: PickedDestination | null };
      if (!j.destination) {
        setError("Couldn't reverse-geocode that point.");
        return;
      }
      onChange(j.destination);
      setQuery(j.destination.label);
      setPickerMode("none");
      setMapPin(null);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {!noTopLabel ? (
        <label className="text-xs text-white/40">
          {variant === "searchOnly" ? "Search place" : "Destination"}
        </label>
      ) : null}

      {value ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5">
          <span className="text-base leading-none">📍</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">
              {value.label}
            </p>
            <p className="text-[10px] text-white/40">
              {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setSuggestions([]);
              setError(null);
            }}
            className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/70 active:bg-white/25"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Address, place, or part of city"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/20"
              autoComplete="off"
            />
            {loading && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-white/40">
                Loading…
              </span>
            )}
            {showSuggestions && suggestions.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-xl border border-white/15 bg-black/90 backdrop-blur shadow-2xl">
                {suggestions.map((s) => (
                  <li key={s.placeId}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void pickFromSuggestion(s)}
                      className="flex w-full flex-col items-start gap-0.5 border-b border-white/5 px-3 py-2 text-left last:border-b-0 hover:bg-white/10 active:bg-white/15"
                    >
                      <span className="text-sm text-white">{s.primary}</span>
                      {s.secondary && (
                        <span className="text-[11px] text-white/45">
                          {s.secondary}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {variant === "full" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setPickerMode((m) => (m === "map" ? "none" : "map"))
              }
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                pickerMode === "map"
                  ? "bg-red-500/30 text-red-100"
                  : "bg-white/10 text-white/70"
              }`}
            >
              {pickerMode === "map" ? "Cancel map" : "Pick on map"}
            </button>
          </div>
          ) : null}

          {variant === "full" && pickerMode === "map" && (
            <div className="space-y-2">
              <div className="relative h-64 overflow-hidden rounded-xl border border-white/10">
                <DestinationMapPicker
                  bias={bias ?? undefined}
                  pin={mapPin}
                  onPinChange={setMapPin}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-white/40">
                  {mapPin
                    ? `${mapPin.lat.toFixed(5)}, ${mapPin.lng.toFixed(5)}`
                    : "Tap the map to drop a pin"}
                </p>
                <button
                  type="button"
                  disabled={!mapPin || loading}
                  onClick={() => void confirmMapPin()}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Use this pin
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <div className="text-[11px] text-red-300">{error}</div>}
    </div>
  );
}

function DestinationMapPicker({
  bias,
  pin,
  onPinChange,
}: {
  bias?: { lat: number; lng: number };
  pin: { lat: number; lng: number } | null;
  onPinChange: (next: { lat: number; lng: number } | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("leaflet").Map | null>(null);
  const markerRef = useRef<import("leaflet").Marker | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let aborted = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (aborted) return;
      if (!document.getElementById("leaflet-css")) {
        const link = document.createElement("link");
        link.id = "leaflet-css";
        link.rel = "stylesheet";
        link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        document.head.appendChild(link);
      }
      const center: [number, number] = bias
        ? [bias.lat, bias.lng]
        : [44.8125, 20.4612];
      const m = L.map(el, {
        center,
        zoom: bias ? 14 : 12,
        zoomControl: true,
        attributionControl: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(m);
      m.on("click", (ev: import("leaflet").LeafletMouseEvent) => {
        const next = { lat: ev.latlng.lat, lng: ev.latlng.lng };
        onPinChange(next);
        if (markerRef.current) {
          markerRef.current.setLatLng([next.lat, next.lng]);
        } else {
          const icon = L.divIcon({
            html:
              '<div style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.7)"></div>',
            className: "camtok-dest-pin",
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          markerRef.current = L.marker([next.lat, next.lng], { icon }).addTo(
            m,
          );
        }
      });
      mapRef.current = m;
    })();
    return () => {
      aborted = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [bias?.lat, bias?.lng, onPinChange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pin && markerRef.current && mapRef.current) {
      mapRef.current.removeLayer(markerRef.current);
      markerRef.current = null;
    }
  }, [pin]);

  return (
    <div ref={containerRef} className="absolute inset-0" style={{ touchAction: "none" }} />
  );
}
