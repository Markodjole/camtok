"use client";

import { useEffect, useRef, useState } from "react";
import type { LeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

type Props = {
  liveSessionId: string | null | undefined;
  className?: string;
};

type Flash = { key: number; delta: 1 | -1 };

/**
 * Viewer-only overlay: vehicle boxes + signed Passed score
 * (+ we passed them, − they passed us).
 */
export function LeadVehicleViewerOverlay({ liveSessionId, className }: Props) {
  const [state, setState] = useState<LeadVehicleOverlayState | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const prevPassed = useRef(0);
  const flashKey = useRef(0);

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
  const isCountRound = !!state?.countRoundId;
  useEffect(() => {
    if (isCountRound) return;
    const prev = prevPassed.current;
    if (vehiclesPassed !== prev) {
      const fromPayload = state?.lastPass?.delta;
      const delta: 1 | -1 =
        fromPayload === 1 || fromPayload === -1
          ? fromPayload
          : vehiclesPassed > prev
            ? 1
            : -1;
      flashKey.current += 1;
      setFlash({ key: flashKey.current, delta });
    }
    prevPassed.current = vehiclesPassed;
  }, [vehiclesPassed, state?.lastPass?.delta, isCountRound]);

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

  const showHud =
    liveSessionId && (detections.length > 0 || vehiclesPassed !== 0);

  if (!liveSessionId || !showHud) return null;

  const scoreColor = isCountRound
    ? "text-emerald-400"
    : vehiclesPassed > 0
      ? "text-emerald-400"
      : vehiclesPassed < 0
        ? "text-rose-400"
        : "text-white";

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[12] ${className ?? ""}`}
      aria-hidden
    >
      <div className="absolute left-3 top-3 flex items-center gap-2">
        <div className="rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm backdrop-blur-sm">
          <span className="text-white/70">
            {isCountRound ? "Vehicles " : "Passed "}
          </span>
          <span className={`tabular-nums ${scoreColor}`}>
            {isCountRound
              ? vehiclesPassed
              : vehiclesPassed > 0
                ? `+${vehiclesPassed}`
                : vehiclesPassed}
          </span>
          {isCountRound && state?.countRoundCounting ? (
            <span className="ml-2 text-[10px] font-bold text-amber-300">LIVE</span>
          ) : null}
        </div>
        {!isCountRound && flash ? (
          <span
            key={flash.key}
            className={`camtok-pass-plus-one rounded-md px-2 py-1 text-xs font-bold text-black ${
              flash.delta === 1 ? "bg-emerald-500" : "bg-rose-500"
            }`}
          >
            {flash.delta === 1 ? "+1" : "−1"}
          </span>
        ) : null}
      </div>

      {detections.map((d, i) => {
        const box = d.normalizedBoundingBox;
        if (!box || box.width <= 0 || box.height <= 0) return null;
        const isLead = d.isLead === true;
        const color = isLead ? "#22c55e" : "#f59e0b";
        const label = isCountRound
          ? "vehicle"
          : isLead
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
