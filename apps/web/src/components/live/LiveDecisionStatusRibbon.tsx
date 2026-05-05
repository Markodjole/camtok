"use client";

/**
 * Viewer status: route/decision lifecycle + current engine bet (dominant) + optional pick.
 */

type Phase = "none" | "pending" | "active";

interface LiveDecisionStatusRibbonProps {
  phase: Phase;
  locksAt?: string | null;
  revealAt?: string | null;
  turnPoint?: { lat: number; lng: number } | null;
  driverPos?: { lat: number; lng: number } | null;
  betOptionLabel?: string | null;
  /** Engine headline, e.g. "Count stops bet" — shown most prominently when set. */
  currentBetHeadline?: string | null;
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
  currentBetHeadline,
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
    mainLabel = `Bets open · lock in ${secToLock}s${distLabel}`;
    tone = "open";
  } else if (phase === "pending") {
    mainLabel = `Decision ahead${distLabel}`;
    tone = "open";
  } else if (phase === "active") {
    const secToTurn = revealAt
      ? Math.max(0, Math.round((Date.parse(revealAt) - nowTick) / 1000))
      : null;
    mainLabel = `Locked · reveal ~${secToTurn ?? "?"}s${distLabel}`;
    tone = "closed";
  }

  const statusBg =
    tone === "open"
      ? "bg-emerald-600/85 text-white border-emerald-300/55"
      : tone === "closed"
        ? "bg-amber-500/88 text-black border-amber-200/65"
        : "bg-emerald-950/55 text-emerald-50/95 border-emerald-500/35";

  return (
    <div className="pointer-events-none absolute left-1/2 top-14 z-[60] w-full max-w-[min(94vw,22rem)] -translate-x-1/2 px-2">
      <div className="flex flex-col items-stretch gap-2">
        {currentBetHeadline ? (
          <div className="rounded-2xl border border-violet-400/45 bg-violet-950/75 px-3 py-2.5 text-center shadow-lg backdrop-blur-md">
            <div className="text-[10px] font-bold uppercase tracking-wider text-violet-200/90">
              Current bet
            </div>
            <div className="mt-0.5 text-[15px] font-bold leading-snug tracking-tight text-white">
              {currentBetHeadline}
            </div>
          </div>
        ) : null}

        <div
          className={`flex flex-wrap items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-[13px] font-semibold leading-snug shadow-md backdrop-blur-md ${statusBg}`}
        >
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{
              background:
                tone === "open"
                  ? "#4ade80"
                  : tone === "closed"
                    ? "#fbbf24"
                    : "#6ee7b7",
              boxShadow:
                tone === "open"
                  ? "0 0 10px #4ade80"
                  : tone === "closed"
                    ? "0 0 10px #fbbf24"
                    : "0 0 8px rgba(110,231,183,0.6)",
            }}
          />
          <span className="text-center">{mainLabel}</span>
        </div>

        {betOptionLabel ? (
          <div className="rounded-xl border border-white/20 bg-black/45 px-3 py-1.5 text-center backdrop-blur-md">
            <span className="text-[11px] font-semibold text-white/90">
              Your pick:{" "}
              <span className="font-bold text-violet-200">{betOptionLabel}</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
