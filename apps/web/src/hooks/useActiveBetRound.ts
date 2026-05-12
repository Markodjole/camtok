"use client";

import { useEffect, useState } from "react";
import type { RoundPlanV2 } from "@bettok/live";
import { viewerLiveLog, viewerLiveWarn } from "@/lib/live/viewerLiveConsole";

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
          viewerLiveWarn("active_round_http", { status: r.status });
          return;
        }
        const j = (await r.json()) as ActiveBettingRoundClient;
        if (!cancelled) {
          viewerLiveLog("active_round_poll", {
            roundPlanType: j.roundPlan?.type ?? null,
            eligibleTypes: (j.eligibleRoundPlans ?? []).map((p) => p.type),
            driverRouteReason: j.driverRouteReason,
          });
          setData({
            roundPlan: j.roundPlan,
            eligibleRoundPlans: j.eligibleRoundPlans ?? [],
            driverRouteReason: j.driverRouteReason,
          });
          setError(null);
        }
      } catch {
        if (!cancelled) setError("network");
        viewerLiveWarn("active_round_network", "fetch failed");
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
