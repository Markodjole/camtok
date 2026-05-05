import { getLiveRoomDetail, type LiveFeedRow } from "@/actions/live-feed";
import { createServiceClient } from "@/lib/supabase/server";
import { metersBetween } from "@/lib/live/routing/geometry";
import { computeDriverRouteInstruction } from "@/lib/live/routing/computeDriverRouteInstruction";
import { BettingEngineV2, type LiveRoundSelectionSnapshot, type RoundPlanV2 } from "@bettok/live";

export type LiveBetRowPublic = {
  id: string;
  market_id: string;
  option_id: string;
  stake_amount: number;
  placed_at: string;
  click_snapshot: unknown;
  status: string;
};

export type ActiveBettingRoundResponse =
  | { error: "not_found" }
  | {
      room: Pick<LiveFeedRow, "roomId" | "characterName" | "phase"> & {
        currentMarket: LiveFeedRow["currentMarket"];
      };
      selectionSnapshot: LiveRoundSelectionSnapshot;
      roundPlan: RoundPlanV2 | null;
      /** Every MVP plan that currently passes gates (for chips / previews). */
      eligibleRoundPlans: RoundPlanV2[];
      driverRouteReason: string | null;
      userBet: LiveBetRowPublic | null;
    };

/** Builds selection snapshot + best round plan. Optionally loads user's current live_bet row. */
export async function getActiveBettingRoundPayload(
  roomId: string,
  userId: string | null | undefined,
): Promise<ActiveBettingRoundResponse> {
  const { room } = await getLiveRoomDetail(roomId);
  if (!room) return { error: "not_found" };

  const driverOut = await computeDriverRouteInstruction(roomId);
  const instruction = driverOut.instruction;
  const planning = "planning" in driverOut ? driverOut.planning : undefined;
  const driverRouteReason = instruction ? null : driverOut.reason;

  const last = room.routePoints[room.routePoints.length - 1];

  let distanceToTurnM: number | null = null;
  const mkt = room.currentMarket;
  if (last && mkt?.turnPointLat != null && mkt.turnPointLng != null) {
    distanceToTurnM = metersBetween(
      { lat: last.lat, lng: last.lng },
      { lat: mkt.turnPointLat, lng: mkt.turnPointLng },
    );
  } else if (last && instruction && instruction.pins.length > 0) {
    const p = instruction.pins[0]!;
    distanceToTurnM = metersBetween(
      { lat: last.lat, lng: last.lng },
      { lat: p.lat, lng: p.lng },
    );
  }

  const firstPinBranches = planning?.meaningfulBranchesPerPin[0];
  const snapshot: LiveRoundSelectionSnapshot = {
    distanceToTurnMeters: distanceToTurnM,
    nextPinHasValidBranches: (firstPinBranches ?? 0) >= 2,
    nextPinId:
      instruction?.pins[0] != null ? String(instruction.pins[0]!.id) : null,
    isInOrNearZone: Boolean(room.regionLabel ?? mkt),
    canBuildNextZoneRound: false,
    canBuildZoneExitRound: Boolean(room.regionLabel && mkt),
    canBuildZoneDurationRound: false,
    canBuildTimeVsGoogleRound: Boolean(
      room.destination && (instruction?.pins?.length ?? 0) > 0,
    ),
    canBuildStopCountRound: last?.speedMps != null,
    canBuildTurnCountRound: (instruction?.pins?.length ?? 0) > 0,
    canBuildTurnsBeforeZoneExitRound: Boolean(room.regionLabel),
    canBuildEtaDriftRound: Boolean(room.destination),
  };

  const roundPlan = BettingEngineV2.selectBestRound(snapshot, { mvpOnly: true });
  const eligibleRoundPlans = BettingEngineV2.listEligibleRounds(snapshot, {
    mvpOnly: true,
  });

  let userBet: LiveBetRowPublic | null = null;
  if (userId && mkt) {
    const svc = await createServiceClient();
    const { data } = await svc
      .from("live_bets")
      .select(
        "id, market_id, option_id, stake_amount, placed_at, click_snapshot, status",
      )
      .eq("market_id", mkt.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (data) userBet = data as LiveBetRowPublic;
  }

  return {
    room: {
      roomId: room.roomId,
      characterName: room.characterName,
      phase: room.phase,
      currentMarket: mkt,
    },
    selectionSnapshot: snapshot,
    roundPlan,
    eligibleRoundPlans,
    driverRouteReason,
    userBet,
  };
}
