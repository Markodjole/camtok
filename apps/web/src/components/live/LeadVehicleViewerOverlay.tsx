"use client";

import { useEffect, useState } from "react";
import type { LeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

type Props = {
  liveSessionId: string | null | undefined;
  className?: string;
};

/**
 * Viewer-only overlay: draws a very thin green square around every vehicle the
 * broadcaster's on-device detector currently sees. No labels, no counting.
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
        return (
          <div
            key={d.trackId ?? `det-${i}`}
            className="absolute"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
              border: "1px solid #22c55e",
              borderRadius: 2,
            }}
          />
        );
      })}
    </div>
  );
}
