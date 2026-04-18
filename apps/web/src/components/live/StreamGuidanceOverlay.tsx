"use client";

import { computeStreamGuidance } from "@/lib/live/streamGuidance";
import type { RoutePoint } from "@/actions/live-feed";
import { useEffect, useState } from "react";

export function StreamGuidanceOverlay({ points }: { points: RoutePoint[] }) {
  const [g, setG] = useState(() => computeStreamGuidance(points));
  useEffect(() => { setG(computeStreamGuidance(points)); }, [points]);

  const { kind, label, rotationDeg } = g;
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/3 z-30 -translate-x-1/2 -translate-y-1/2 text-center">
      <div
        className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-emerald-500/50 bg-emerald-500/15 shadow-[0_0_20px_rgba(34,197,94,0.35)] backdrop-blur-sm"
        style={{ transform: `rotate(${arrowRotateScreen(kind, rotationDeg)}deg)` }}
      >
        {kind === "brake" ? (
          <span className="text-2xl font-bold text-amber-300 [text-shadow:0_0_4px_#000]">■</span>
        ) : (
          <div className="h-0 w-0 border-x-[20px] border-b-[34px] border-x-transparent border-b-[#4ade80] [filter:drop-shadow(0_0_2px_#000)]" />
        )}
      </div>
      <div className="mt-1 rounded-full bg-black/50 px-3 py-0.5 text-center text-xs font-bold uppercase tracking-wider text-emerald-200 [text-shadow:0_0_4px_#000]">
        {label}
      </div>
    </div>
  );
}

/** Screen space: 0=up, positive=cw. Combine hint with GPS course so “straight” means along your heading. */
function arrowRotateScreen(k: string, courseDeg: number) {
  const base = courseDeg; // 0=North
  if (k === "brake") return 0;
  if (k === "back") return base + 180;
  if (k === "left") return base - 90;
  if (k === "right") return base + 90;
  return base;
}
