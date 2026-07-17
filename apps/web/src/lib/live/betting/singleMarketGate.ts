/**
 * ONE bet at a time, with breathing room between bets.
 *
 * Product rule: viewers can only ever see/track a single active bet; the next
 * bet may open no sooner than MIN_GAP_AFTER_CLOSE_MS after the previous one
 * closed (settled or cancelled). This gate is the single source of truth for
 * that rule — every market-open path (tick triggers, step fillers, overtake,
 * vehicle count rounds) must pass it.
 */

import type { createServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;

export const MIN_GAP_AFTER_CLOSE_MS = 10_000;

export type SingleMarketGate = {
  /** An unsettled market (open/locked/revealed) of ANY type, if one exists. */
  activeMarketId: string | null;
  activeMarketType: string | null;
  /** Ms since the most recent market settled/cancelled; null = none ever. */
  msSinceLastClose: number | null;
};

export type SingleMarketGateResult = {
  allowed: boolean;
  code?: "MARKET_ACTIVE" | "CLOSE_GAP";
  retryAfterMs?: number;
};

export async function loadSingleMarketGate(
  service: ServiceClient,
  liveSessionId: string,
  nowMs: number = Date.now(),
): Promise<SingleMarketGate> {
  const { data: active } = await service
    .from("live_betting_markets")
    .select("id, market_type")
    .eq("live_session_id", liveSessionId)
    .in("status", ["open", "locked", "revealed"])
    .limit(1);

  const activeRow = (active ?? [])[0] as
    | { id: string; market_type: string }
    | undefined;

  const { data: closed } = await service
    .from("live_betting_markets")
    .select("reveal_at, updated_at")
    .eq("live_session_id", liveSessionId)
    .in("status", ["settled", "cancelled"])
    .order("updated_at", { ascending: false })
    .limit(3);

  let lastCloseMs: number | null = null;
  for (const row of (closed ?? []) as {
    reveal_at: string | null;
    updated_at: string | null;
  }[]) {
    for (const ts of [row.updated_at, row.reveal_at]) {
      if (!ts) continue;
      const ms = new Date(ts).getTime();
      if (Number.isFinite(ms) && (lastCloseMs == null || ms > lastCloseMs)) {
        lastCloseMs = ms;
      }
    }
  }

  return {
    activeMarketId: activeRow?.id ?? null,
    activeMarketType: activeRow?.market_type ?? null,
    msSinceLastClose: lastCloseMs != null ? nowMs - lastCloseMs : null,
  };
}

export function singleMarketGateAllows(
  gate: SingleMarketGate,
): SingleMarketGateResult {
  if (gate.activeMarketId) {
    return { allowed: false, code: "MARKET_ACTIVE" };
  }
  if (
    gate.msSinceLastClose != null &&
    gate.msSinceLastClose < MIN_GAP_AFTER_CLOSE_MS
  ) {
    return {
      allowed: false,
      code: "CLOSE_GAP",
      retryAfterMs: MIN_GAP_AFTER_CLOSE_MS - gate.msSinceLastClose,
    };
  }
  return { allowed: true };
}
