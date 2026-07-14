"use client";

import { useEffect, useState } from "react";
import type { LeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

type Props = {
  liveSessionId: string | null | undefined;
  className?: string;
};

/**
 * Viewer-only overlay: draws lead (green) + other vehicle boxes from
 * character_lead_vehicle_state. Rider app never shows these.
 */
export function LeadVehicleViewerOverlay({ liveSessionId, className }: Props) {
  const [state, setState] = useState<LeadVehicleOverlayState | null>(null);

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

  if (!liveSessionId || detections.length === 0) return null;

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[12] ${className ?? ""}`}
      aria-hidden
    >
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
