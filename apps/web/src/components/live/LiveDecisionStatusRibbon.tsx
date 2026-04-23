"use client";

/**
 * Debug/status ribbon that surfaces the current decision-point lifecycle so
 * viewers and drivers can actually see the chain of events:
 *
 *   Free driving  →  BETS OPEN (dot appears)  →  BETS CLOSED (rails + blink)
 *                 ←  … turn passed, everything disappears …
 *
 * The ribbon is intentionally verbose; it is removed before shipping.
 */

type Phase = "none" | "pending" | "active";

interface LiveDecisionStatusRibbonProps {
  phase: Phase;
  locksAt?: string | null;
  revealAt?: string | null;
  turnPoint?: { lat: number; lng: number } | null;
  driverPos?: { lat: number; lng: number } | null;
  betOptionLabel?: string | null;
  nowTick: number;
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const r = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function LiveDecisionStatusRibbon({
  phase,
  locksAt,
  revealAt,
  turnPoint,
  driverPos,
  betOptionLabel,
  nowTick,
}: LiveDecisionStatusRibbonProps) {
  const distanceM =
    turnPoint && driverPos ? haversineMeters(driverPos, turnPoint) : null;
  const distLabel =
    distanceM != null ? ` · ${Math.round(distanceM)} m ahead` : "";

  let mainLabel = "Free driving · no decision yet";
  let tone: "neutral" | "open" | "closed" | "done" = "neutral";

  if (phase === "pending" && locksAt) {
    const secToLock = Math.max(
      0,
      Math.round((Date.parse(locksAt) - nowTick) / 1000),
    );
    mainLabel = `BETS OPEN · closes in ${secToLock}s${distLabel}`;
    tone = "open";
  } else if (phase === "pending") {
    mainLabel = `Decision point detected${distLabel}`;
    tone = "open";
  } else if (phase === "active") {
    const secToTurn = revealAt
      ? Math.max(0, Math.round((Date.parse(revealAt) - nowTick) / 1000))
      : null;
    mainLabel = `BETS CLOSED · turn in ${secToTurn ?? "?"}s${distLabel}`;
    tone = "closed";
  }

  const bg =
    tone === "open"
      ? "bg-emerald-500/90 text-white border-emerald-300/60"
      : tone === "closed"
        ? "bg-amber-500/90 text-black border-amber-200/70"
        : "bg-white/10 text-white/80 border-white/20";

  return (
    <div className="pointer-events-none absolute left-1/2 top-12 z-[60] -translate-x-1/2">
      <div
        className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold backdrop-blur ${bg}`}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            background:
              tone === "open"
                ? "#22c55e"
                : tone === "closed"
                  ? "#f59e0b"
                  : "#94a3b8",
            boxShadow:
              tone === "open"
                ? "0 0 8px #22c55e"
                : tone === "closed"
                  ? "0 0 8px #f59e0b"
                  : "none",
          }}
        />
        <span className="whitespace-nowrap">{mainLabel}</span>
        {betOptionLabel ? (
          <span className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-bold uppercase">
            your pick: {betOptionLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
