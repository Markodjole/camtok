import type { LiveMarketStatus, LiveRoomPhase } from "../types";

export type PhaseTransition = {
  from: LiveRoomPhase;
  to: LiveRoomPhase;
  reason: string;
  allowed: boolean;
};

const ALLOWED: Record<LiveRoomPhase, LiveRoomPhase[]> = {
  idle: ["waiting_for_next_market"],
  waiting_for_next_market: ["market_open", "idle"],
  market_open: ["market_locked", "waiting_for_next_market"], // cancelled → back to waiting
  market_locked: ["reveal_pending", "waiting_for_next_market"],
  reveal_pending: ["revealed", "waiting_for_next_market"],
  revealed: ["settled", "waiting_for_next_market"],
  settled: ["waiting_for_next_market", "idle"],
};

export function canTransitionRoom(
  from: LiveRoomPhase,
  to: LiveRoomPhase,
): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

const MARKET_ALLOWED: Record<LiveMarketStatus, LiveMarketStatus[]> = {
  draft: ["open", "cancelled"],
  open: ["locked", "cancelled"],
  locked: ["revealed", "cancelled"],
  revealed: ["settled"],
  settled: [],
  cancelled: [],
};

export function canTransitionMarket(
  from: LiveMarketStatus,
  to: LiveMarketStatus,
): boolean {
  return MARKET_ALLOWED[from]?.includes(to) ?? false;
}
