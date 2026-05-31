/**
 * Persistent per-room scheduler state (cell dwell, last open time).
 * Stored in live_rooms.bet_scheduler_state (jsonb).
 */

import type { BetOpenContext } from "@/lib/live/betting/betOpenPolicy";
import type { createServiceClient } from "@/lib/supabase/server";

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;

export type BetSchedulerState = {
  cellDwell?: { cellKey: string; enteredAtMs: number };
  lastBetOpenedAtMs?: number;
};

export function parseBetSchedulerState(raw: unknown): BetSchedulerState {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const cellDwellRaw = o.cellDwell;
  let cellDwell: BetSchedulerState["cellDwell"];
  if (
    cellDwellRaw &&
    typeof cellDwellRaw === "object" &&
    typeof (cellDwellRaw as { cellKey?: unknown }).cellKey === "string" &&
    typeof (cellDwellRaw as { enteredAtMs?: unknown }).enteredAtMs === "number"
  ) {
    cellDwell = {
      cellKey: (cellDwellRaw as { cellKey: string }).cellKey,
      enteredAtMs: (cellDwellRaw as { enteredAtMs: number }).enteredAtMs,
    };
  }
  const lastBetOpenedAtMs =
    typeof o.lastBetOpenedAtMs === "number" ? o.lastBetOpenedAtMs : undefined;
  return { cellDwell, lastBetOpenedAtMs };
}

/** Advance cell dwell when the driver moves to a new grid cell. */
export function nextCellDwellState(
  prev: BetSchedulerState,
  cellKey: string | null,
  nowMs: number,
): BetSchedulerState {
  if (!cellKey) {
    return { ...prev, cellDwell: undefined };
  }
  if (prev.cellDwell?.cellKey === cellKey) {
    return prev;
  }
  return {
    ...prev,
    cellDwell: { cellKey, enteredAtMs: nowMs },
  };
}

export function buildBetOpenContext(
  scheduler: BetSchedulerState,
  room: {
    phase: string;
    current_market_id: string | null;
    current_step_market_id: string | null;
  },
  mainMarketType: string | null,
  nowMs: number = Date.now(),
): BetOpenContext {
  return {
    nowMs,
    lastBetOpenedAtMs: scheduler.lastBetOpenedAtMs ?? null,
    cellDwell: scheduler.cellDwell ?? null,
    mainSlot: {
      phase: room.phase,
      marketId: room.current_market_id,
      marketType: mainMarketType,
    },
    stepSlot: {
      marketId: room.current_step_market_id,
    },
  };
}

export async function loadBetSchedulerState(
  service: ServiceClient,
  roomId: string,
): Promise<BetSchedulerState> {
  const { data } = await service
    .from("live_rooms")
    .select("bet_scheduler_state")
    .eq("id", roomId)
    .maybeSingle();
  return parseBetSchedulerState(
    (data as { bet_scheduler_state?: unknown } | null)?.bet_scheduler_state,
  );
}

export async function persistBetSchedulerState(
  service: ServiceClient,
  roomId: string,
  state: BetSchedulerState,
): Promise<void> {
  await service
    .from("live_rooms")
    .update({ bet_scheduler_state: state })
    .eq("id", roomId);
}

export async function syncCellDwellAndPersist(
  service: ServiceClient,
  roomId: string,
  cellKey: string | null,
  nowMs: number = Date.now(),
): Promise<BetSchedulerState> {
  const prev = await loadBetSchedulerState(service, roomId);
  const next = nextCellDwellState(prev, cellKey, nowMs);
  if (
    next.cellDwell?.cellKey !== prev.cellDwell?.cellKey ||
    next.cellDwell?.enteredAtMs !== prev.cellDwell?.enteredAtMs
  ) {
    await persistBetSchedulerState(service, roomId, next);
  }
  return next;
}

export async function recordBetOpened(
  service: ServiceClient,
  roomId: string,
  scheduler: BetSchedulerState,
  openedAtMs: number = Date.now(),
): Promise<BetSchedulerState> {
  const next: BetSchedulerState = {
    ...scheduler,
    lastBetOpenedAtMs: openedAtMs,
  };
  await persistBetSchedulerState(service, roomId, next);
  return next;
}
