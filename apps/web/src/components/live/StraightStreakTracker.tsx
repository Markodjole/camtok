"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { metersBetween } from "@/lib/live/routing/geometry";
import { STREAK_CROSSROAD_PROXIMITY_M } from "@/lib/live/betting/betWindowConstants";
import type { StraightStreakSubtitle } from "@/lib/live/routing/straightStreakAnalyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  /**
   * The raw `meta` field from `currentMarket` (pre-parsed subtitle JSON).
   * This component only renders when `marketType === "straight_streak"`.
   */
  marketMeta: Record<string, unknown> | null;
  /** Market ID — used to reset state when the market changes. */
  marketId: string;
  /** Latest vehicle position. Updated on every GPS tick (~1 Hz). */
  vehiclePosition: { lat: number; lng: number } | null;
};

// ─── Proximity thresholds ─────────────────────────────────────────────────────

/** Distance (m) at which the vehicle is considered to be "in" an intersection. */
const IN_RANGE_M = STREAK_CROSSROAD_PROXIMITY_M; // 45 m — same as resolver

/** Distance (m) past which the vehicle has clearly left the intersection. */
const EXITED_M = IN_RANGE_M + 20; // 65 m

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Overlay that tracks and animates straight-intersection passages while a
 * `straight_streak` market is active.
 *
 * Renders a counter pill ("2 / 3 straights") and a "+1" float-up animation
 * each time the vehicle passes through an expected crossroad without turning.
 *
 * The passage detection is purely distance-based on the client: we detect
 * "vehicle entered intersection proximity zone, then exited".  Heading
 * classification (straight vs turn) is left to the server-side resolver at
 * settlement — the client optimistically counts every passage as "+1" and lets
 * the market outcome correct any miscount.
 */
export function StraightStreakTracker({ marketMeta, marketId, vehiclePosition }: Props) {
  // ── Parse subtitle ─────────────────────────────────────────────────────────
  const streakData = useMemo<StraightStreakSubtitle | null>(() => {
    if (!marketMeta) return null;
    const { expectedStreak, streakKey, intersections } = marketMeta as Partial<StraightStreakSubtitle>;
    if (
      typeof expectedStreak !== "number" ||
      typeof streakKey !== "string" ||
      !Array.isArray(intersections) ||
      intersections.length === 0
    ) {
      return null;
    }
    return { expectedStreak, streakKey, intersections };
  }, [marketMeta]);

  // ── Passage tracking state ─────────────────────────────────────────────────
  const [passedCount, setPassedCount] = useState(0);

  /**
   * Float-up "+1" tokens.  Each entry is a unique key so React keeps separate
   * DOM nodes for concurrent animations (multiple rapid passages).
   */
  const [floatTokens, setFloatTokens] = useState<number[]>([]);

  /** Node IDs currently within the proximity radius. */
  const approachingRef = useRef<Set<number>>(new Set());
  /** Node IDs that have already been counted this market. */
  const passedRef = useRef<Set<number>>(new Set());
  const tokenCounterRef = useRef(0);

  // Reset everything when the market changes.
  useEffect(() => {
    setPassedCount(0);
    setFloatTokens([]);
    approachingRef.current = new Set();
    passedRef.current = new Set();
    tokenCounterRef.current = 0;
  }, [marketId]);

  // ── Proximity detection ────────────────────────────────────────────────────
  useEffect(() => {
    if (!streakData || !vehiclePosition) return;

    let newPassed = 0;
    const newTokens: number[] = [];

    for (const intersection of streakData.intersections) {
      const nodeId = intersection.nodeId;
      if (passedRef.current.has(nodeId)) continue; // already counted

      const dist = metersBetween(vehiclePosition, intersection);

      if (dist <= IN_RANGE_M) {
        // Vehicle is inside the proximity zone.
        approachingRef.current.add(nodeId);
      } else if (approachingRef.current.has(nodeId) && dist >= EXITED_M) {
        // Vehicle was inside the zone and has now clearly exited → passage!
        approachingRef.current.delete(nodeId);
        passedRef.current.add(nodeId);
        newPassed++;
        tokenCounterRef.current++;
        newTokens.push(tokenCounterRef.current);
      }
    }

    if (newPassed > 0) {
      setPassedCount((prev) => prev + newPassed);
      setFloatTokens((prev) => [...prev, ...newTokens]);
    }
  }, [vehiclePosition, streakData]);

  // Remove float tokens after the animation completes (900 ms + small buffer).
  useEffect(() => {
    if (floatTokens.length === 0) return;
    const id = setTimeout(() => {
      setFloatTokens((prev) => prev.slice(floatTokens.length));
    }, 1100);
    return () => clearTimeout(id);
  }, [floatTokens.length]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!streakData) return null;

  const { expectedStreak } = streakData;
  const isDone = passedCount >= expectedStreak;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-[195] flex flex-col items-center gap-0">
      {/* Float-up "+1" tokens */}
      <div className="relative flex justify-center" style={{ height: 44 }}>
        {floatTokens.map((token) => (
          <span
            key={token}
            className="absolute bottom-0 animate-float-up select-none text-lg font-black text-emerald-400 drop-shadow"
            style={{ textShadow: "0 0 8px rgba(52,211,153,0.8)" }}
          >
            +1
          </span>
        ))}
      </div>

      {/* Counter pill */}
      <div
        className={[
          "flex animate-pop-in items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-lg",
          isDone
            ? "bg-emerald-500 text-white"
            : "bg-black/70 text-white backdrop-blur-sm",
        ].join(" ")}
      >
        {/* Straight-road icon */}
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="size-4 shrink-0 opacity-80"
        >
          <line x1="10" y1="2" x2="10" y2="18" />
          <line x1="6" y1="6" x2="10" y2="2" />
          <line x1="14" y1="6" x2="10" y2="2" />
        </svg>

        <span>
          {passedCount}
          <span className="opacity-50"> / {expectedStreak}</span>
          <span className="ml-1.5 font-normal opacity-70">
            {passedCount === 1 ? "straight" : "straights"}
          </span>
        </span>

        {isDone && (
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="size-4 shrink-0"
          >
            <path
              fillRule="evenodd"
              d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
