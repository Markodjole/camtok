"use client";

import { useEffect, useRef, useState } from "react";
import type { LeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

type Props = {
  liveSessionId: string | null | undefined;
  className?: string;
};

/**
 * Viewer-only overlay: draws lead (green) + other vehicle boxes from
 * character_lead_vehicle_state, plus on-screen / passed counters.
 * Rider app never shows these.
 */
export function LeadVehicleViewerOverlay({ liveSessionId, className }: Props) {
  const [state, setState] = useState<LeadVehicleOverlayState | null>(null);
  const [plusOneKey, setPlusOneKey] = useState(0);
  const prevPassed = useRef(0);

  useEffect(() => {
    if (!liveSessionId) {
      setState(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/live/sessions/${liveSessionId}/lead-vehicle`,
          { cache: "no-store" },
        );
        if (!res.ok || stopped) return;
        const json = (await res.json()) as {
          state: LeadVehicleOverlayState | null;
        };
        if (!stopped) setState(json.state);
      } catch {
        // soft-fail
      }
    };
    void tick();
    const id = setInterval(tick, 400);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [liveSessionId]);

  const vehiclesPassed = state?.vehiclesPassed ?? 0;
  useEffect(() => {
    if (vehiclesPassed > prevPassed.current) {
      setPlusOneKey((k) => k + 1);
    }
    prevPassed.current = vehiclesPassed;
  }, [vehiclesPassed]);

  const detections =
    state?.detections?.length && state.detections.length > 0
      ? state.detections
      : state?.normalizedBoundingBox
        ? [
            {
              trackId: state.trackId ?? undefined,
              vehicleType: state.vehicleType ?? undefined,
              confidence: state.confidence ?? undefined,
              isLead: true,
              normalizedBoundingBox: state.normalizedBoundingBox,
            },
          ]
        : [];

  const vehiclesOnScreen =
    state?.vehiclesOnScreen ??
    detections.filter((d) => d.normalizedBoundingBox?.width > 0).length;
  const showHud = liveSessionId && (detections.length > 0 || vehiclesPassed > 0);

  if (!liveSessionId || !showHud) return null;

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[12] ${className ?? ""}`}
      aria-hidden
    >
      <div className="absolute left-3 top-3 flex items-center gap-2">
        <div className="rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm backdrop-blur-sm">
          <span className="text-white/70">Ahead </span>
          <span className="tabular-nums text-amber-300">{vehiclesOnScreen}</span>
          <span className="mx-1.5 text-white/30">·</span>
          <span className="text-white/70">Passed </span>
          <span className="tabular-nums text-emerald-400">{vehiclesPassed}</span>
        </div>
        {plusOneKey > 0 ? (
          <span
            key={plusOneKey}
            className="camtok-pass-plus-one rounded-md bg-emerald-500 px-2 py-1 text-xs font-bold text-black"
          >
            +1
          </span>
        ) : null}
      </div>

      {detections.map((d, i) => {
        const box = d.normalizedBoundingBox;
        if (!box || box.width <= 0 || box.height <= 0) return null;
        const isLead = d.isLead === true;
        const color = isLead ? "#22c55e" : "#f59e0b";
        const label = isLead
          ? `LEAD ${(d.vehicleType ?? "vehicle").replace("_", " ")}`
          : (d.vehicleType ?? "vehicle").replace("_", " ");
        return (
          <div
            key={d.trackId ?? `det-${i}`}
            className="absolute"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
              border: `2px solid ${color}`,
              boxShadow: isLead
                ? `0 0 0 1px rgba(0,0,0,0.35), 0 0 12px ${color}66`
                : `0 0 0 1px rgba(0,0,0,0.35)`,
              borderRadius: 4,
            }}
          >
            <span
              className="absolute left-0 top-0 -translate-y-full truncate px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{
                backgroundColor: color,
                color: "#0a0a0a",
                maxWidth: "140%",
              }}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
