"use client";

import { useEffect, useState } from "react";
import type { RoundPlanV2 } from "@bettok/live";

export type ActiveBettingRoundClient = {
  roundPlan: RoundPlanV2 | null;
  eligibleRoundPlans: RoundPlanV2[];
  driverRouteReason: string | null;
};

/**
 * Polls Engine V2 active-round endpoint so the UI can reflect server-selected plan.
 */
export function useActiveBetRound(roomId: string | undefined, intervalMs = 4000) {
  const [data, setData] = useState<ActiveBettingRoundClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    setData(null);
    setError(null);
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/live/rooms/${roomId}/betting/active-round`, {
          cache: "no-store",
        });
        if (!r.ok) {
          if (!cancelled) setError(r.status === 404 ? "not_found" : "request_failed");
          return;
        }
        const j = (await r.json()) as ActiveBettingRoundClient;
        if (!cancelled) {
          setData({
            roundPlan: j.roundPlan,
            eligibleRoundPlans: j.eligibleRoundPlans ?? [],
            driverRouteReason: j.driverRouteReason,
          });
          setError(null);
        }
      } catch {
        if (!cancelled) setError("network");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId, intervalMs]);

  return { data, error };
}
