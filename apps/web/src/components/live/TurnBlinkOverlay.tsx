"use client";

import { useEffect, useState } from "react";

export type TurnDirection = "left" | "right" | null;

export function TurnBlinkOverlay({
  direction,
  etaSec,
  distanceM,
  label,
  urgent,
}: {
  direction: TurnDirection;
  etaSec: number | null;
  distanceM: number | null;
  label?: string | null;
  urgent?: boolean;
}) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!direction) return;
    const interval = urgent ? 320 : 600;
    const id = setInterval(() => setOn((v) => !v), interval);
    return () => clearInterval(id);
  }, [direction, urgent]);

  if (!direction) return null;

  const color = urgent ? "rgba(34,197,94,0.62)" : "rgba(16,185,129,0.5)";
  const glow = urgent ? "0 0 80px rgba(34,197,94,0.8)" : "0 0 60px rgba(16,185,129,0.6)";

  return (
    <div className="pointer-events-none absolute inset-0 z-[45]">
      <div
        className="absolute top-0 bottom-0 flex items-center justify-center transition-opacity duration-200"
        style={{
          left: direction === "left" ? 0 : "50%",
          right: direction === "right" ? 0 : "50%",
          background: `linear-gradient(${direction === "left" ? "90deg" : "270deg"}, ${color} 0%, rgba(0,0,0,0) 100%)`,
          opacity: on ? 1 : 0.1,
          boxShadow: glow,
        }}
      >
        <div
          className="flex flex-col items-center gap-2"
          style={{
            transform: direction === "left" ? "translateX(-10%)" : "translateX(10%)",
          }}
        >
          <div className="relative flex h-28 w-28 items-center justify-center rounded-full border border-emerald-200/60 bg-emerald-900/35 shadow-[0_0_40px_rgba(16,185,129,0.65)]">
            <div
              className="relative h-10 w-14"
              style={{
                transform: direction === "left" ? "scaleX(-1)" : "none",
              }}
            >
              <div className="absolute left-0 top-1/2 h-2 w-8 -translate-y-1/2 rounded-full bg-emerald-100 [filter:drop-shadow(0_0_4px_rgba(255,255,255,0.55))]" />
              <div
                className="absolute right-0 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[12px] border-l-[20px] border-y-transparent"
                style={{ borderLeftColor: urgent ? "#ecfdf5" : "#d1fae5" }}
              />
            </div>
          </div>
          <div
            className="rounded-full border border-emerald-300/40 bg-emerald-950/75 px-3 py-1 text-xs font-extrabold uppercase tracking-widest text-emerald-100 [text-shadow:0_0_4px_#000]"
          >
            {label ?? (direction === "left" ? "Turn left" : "Turn right")}
            {etaSec != null ? ` \u00b7 ${Math.max(0, Math.round(etaSec))}s` : ""}
            {distanceM != null ? ` \u00b7 ~${Math.max(0, Math.round(distanceM))}m` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
