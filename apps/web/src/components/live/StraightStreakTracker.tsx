"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { metersBetween } from "@/lib/live/routing/geometry";
import {
  STRAIGHT_STREAK_COMMITTED_TURN_DEG,
  STREAK_CROSSROAD_PROXIMITY_M,
} from "@/lib/live/betting/betWindowConstants";
import type { StraightStreakSubtitle } from "@/lib/live/routing/straightStreakAnalyzer";
import {
  hasCommittedTurn,
  scoreIntersectionPassage,
  type GpsSample,
} from "@/lib/live/routing/straightStreakPassage";

type Props = {
  marketMeta: Record<string, unknown> | null;
  marketId: string;
  vehiclePosition: { lat: number; lng: number; heading?: number } | null;
};

const IN_RANGE_M = STREAK_CROSSROAD_PROXIMITY_M + 35;
const EXITED_M = STREAK_CROSSROAD_PROXIMITY_M + 45;
const HISTORY_SIZE = 40;

export function StraightStreakTracker({ marketMeta, marketId, vehiclePosition }: Props) {
  const streakData = useMemo<StraightStreakSubtitle | null>(() => {
    if (!marketMeta) return null;
    const { expectedStreak, streakKey, intersections } =
      marketMeta as Partial<StraightStreakSubtitle>;
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

  const [passedCount, setPassedCount] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [floatTokens, setFloatTokens] = useState<number[]>([]);

  const gpsHistoryRef = useRef<GpsSample[]>([]);
  const passedRef = useRef<Set<number>>(new Set());
  const tokenCounterRef = useRef(0);
  const gameOverRef = useRef(false);

  useEffect(() => {
    setPassedCount(0);
    setGameOver(false);
    setFloatTokens([]);
    gpsHistoryRef.current = [];
    passedRef.current = new Set();
    tokenCounterRef.current = 0;
    gameOverRef.current = false;
  }, [marketId]);

  useEffect(() => {
    if (!streakData || !vehiclePosition || gameOverRef.current) return;

    const sample: GpsSample = {
      lat: vehiclePosition.lat,
      lng: vehiclePosition.lng,
      heading:
        vehiclePosition.heading != null && Number.isFinite(vehiclePosition.heading)
          ? vehiclePosition.heading
          : null,
    };

    gpsHistoryRef.current = [
      ...gpsHistoryRef.current.slice(-(HISTORY_SIZE - 1)),
      sample,
    ];

    const history = gpsHistoryRef.current;

    if (hasCommittedTurn(history, STRAIGHT_STREAK_COMMITTED_TURN_DEG)) {
      gameOverRef.current = true;
      setGameOver(true);
      return;
    }

    let newPassed = 0;
    const newTokens: number[] = [];

    for (const intersection of streakData.intersections) {
      const nodeId = intersection.nodeId;
      if (passedRef.current.has(nodeId)) continue;

      const currentDist = metersBetween(vehiclePosition, intersection);
      const wasNear = history.some(
        (p) => metersBetween(p, intersection) <= IN_RANGE_M,
      );

      if (!wasNear || currentDist < EXITED_M) continue;

      const passage = scoreIntersectionPassage(history, intersection, IN_RANGE_M);

      passedRef.current.add(nodeId);

      if (passage === "turn") {
        gameOverRef.current = true;
        setGameOver(true);
        return;
      }

      if (passage === "straight") {
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

  useEffect(() => {
    if (floatTokens.length === 0) return;
    const id = setTimeout(() => {
      setFloatTokens((prev) => prev.slice(floatTokens.length));
    }, 1100);
    return () => clearTimeout(id);
  }, [floatTokens.length]);

  if (!streakData) return null;

  const { expectedStreak } = streakData;
  const isDone = !gameOver && passedCount >= expectedStreak;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-28 z-[195] flex flex-col items-center gap-0">
      <div className="relative flex justify-center" style={{ height: 64 }}>
        {floatTokens.map((token) => (
          <span
            key={token}
            className="absolute bottom-0 animate-float-up select-none text-4xl font-black text-emerald-400 drop-shadow"
            style={{ textShadow: "0 0 14px rgba(52,211,153,0.9)" }}
          >
            +1
          </span>
        ))}
      </div>

      <div
        className={[
          "flex animate-pop-in items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-lg",
          gameOver
            ? "bg-red-500/90 text-white"
            : isDone
              ? "bg-emerald-500 text-white"
              : "bg-black/70 text-white backdrop-blur-sm",
        ].join(" ")}
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="size-4 shrink-0 opacity-80"
        >
          {gameOver ? (
            <>
              <line x1="5" y1="5" x2="15" y2="15" />
              <line x1="15" y1="5" x2="5" y2="15" />
            </>
          ) : (
            <>
              <line x1="10" y1="2" x2="10" y2="18" />
              <line x1="6" y1="6" x2="10" y2="2" />
              <line x1="14" y1="6" x2="10" y2="2" />
            </>
          )}
        </svg>

        {gameOver ? (
          <span>
            Turn — streak over at {passedCount}
            <span className="opacity-70"> / {expectedStreak}</span>
          </span>
        ) : (
          <span>
            {passedCount}
            <span className="opacity-50"> / {expectedStreak}</span>
            <span className="ml-1.5 font-normal opacity-70">
              {passedCount === 1 ? "straight" : "straights"}
            </span>
          </span>
        )}

        {isDone && (
          <svg viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0">
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
