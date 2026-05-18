"use client";

/**
 * Viewer status: route countdown + engine headline + optional bet-type chips when several rounds are eligible.
 */

import type { BetTypeV2, RoundPlanV2 } from "@bettok/live";
import { betTypeV2Label } from "@/lib/live/betting/betTypeV2Label";

type Phase = "none" | "pending" | "active";

interface LiveDecisionStatusRibbonProps {
  phase: Phase;
  locksAt?: string | null;
  revealAt?: string | null;
  turnPoint?: { lat: number; lng: number } | null;
  driverPos?: { lat: number; lng: number } | null;
  betOptionLabel?: string | null;
  currentBetHeadline?: string | null;
  nowTick: number;
  eligibleRoundPlans?: RoundPlanV2[];
  highlightedEngineType?: BetTypeV2 | null;
  onSelectEngineType?: (type: BetTypeV2) => void;
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
  currentBetHeadline,
  nowTick,
  eligibleRoundPlans = [],
  highlightedEngineType = null,
  onSelectEngineType,
}: LiveDecisionStatusRibbonProps) {
  const distanceM =
    turnPoint && driverPos ? haversineMeters(driverPos, turnPoint) : null;
  const distLabel =
    distanceM != null ? ` · ${Math.round(distanceM)} m` : "";

  let mainLabel = "Free driving · no decision yet";
  let dotTone: "muted" | "open" | "closed" = "muted";

  if (phase === "pending" && locksAt) {
    const secToLock = Math.max(
      0,
      Math.round((Date.parse(locksAt) - nowTick) / 1000),
    );
    mainLabel = `Bets open · lock ${secToLock}s${distLabel}`;
    dotTone = "open";
  } else if (phase === "pending") {
    mainLabel = `Decision ahead${distLabel}`;
    dotTone = "open";
  } else if (phase === "active") {
    const secToTurn = revealAt
      ? Math.max(0, Math.round((Date.parse(revealAt) - nowTick) / 1000))
      : null;
    mainLabel = `Locked · ~${secToTurn ?? "?"}s${distLabel}`;
    dotTone = "closed";
  }

  const dotColor =
    dotTone === "open"
      ? "#4ade80"
      : dotTone === "closed"
        ? "#fbbf24"
        : "rgba(148,163,184,0.95)";

  const dedupedPlans = (() => {
    const seen = new Set<BetTypeV2>();
    return eligibleRoundPlans.filter((p) => {
      if (seen.has(p.type)) return false;
      seen.add(p.type);
      return true;
    });
  })();

  return (
    <div className="pointer-events-none absolute left-1/2 top-[6.75rem] z-[60] w-full max-w-[min(94vw,20rem)] -translate-x-1/2 px-2">
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex max-w-full items-center justify-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-[9px] font-medium leading-snug text-emerald-50/80 shadow-sm backdrop-blur-sm [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]">
          <span
            className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background: dotColor,
              boxShadow:
                dotTone === "open"
                  ? "0 0 5px #4ade8055"
                  : dotTone === "closed"
                    ? "0 0 5px #fbbf2455"
                    : "none",
            }}
          />
          <span className="text-center">{mainLabel}</span>
        </div>

        {currentBetHeadline ? (
          <div className="max-w-full truncate rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-center text-[10px] font-semibold leading-tight text-white/90 shadow-sm backdrop-blur-sm [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]">
            {currentBetHeadline}
          </div>
        ) : null}

        {highlightedEngineType && onSelectEngineType ? (
          <button
            type="button"
            onClick={() => {
              const idx = dedupedPlans.findIndex((p) => p.type === highlightedEngineType);
              if (dedupedPlans.length > 1) {
                const next = dedupedPlans[(idx + 1) % dedupedPlans.length];
                if (next) onSelectEngineType(next.type);
              }
            }}
            className="pointer-events-auto rounded-full border border-violet-400/60 bg-violet-600/35 px-2.5 py-0.5 text-[9px] font-semibold text-white"
          >
            {betTypeV2Label(highlightedEngineType)}
            {dedupedPlans.length > 1 ? " ›" : ""}
          </button>
        ) : null}

        {betOptionLabel ? (
          <div className="text-[9px] font-medium leading-tight text-white/75 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
            Pick:{" "}
            <span className="font-bold text-violet-200/90">{betOptionLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
