import { describe, expect, it } from "vitest";
import { listEligibleRounds, selectBestRound, canBuildNextTurnRound } from "../betting-engine-v2/selectBestRound";
import { shouldReplaceRound } from "../betting-engine-v2/roundPolicy";
import type { BetRoundV2 } from "../betting-engine-v2/types";

describe("BettingEngineV2 selectBestRound", () => {
  it("prefers next_turn when in distance window with branches", () => {
    const plan = selectBestRound(
      {
        distanceToTurnMeters: 175,
        nextPinHasValidBranches: true,
        canBuildNextZoneRound: true,
      },
      { mvpOnly: true },
    );
    expect(plan?.type).toBe("next_turn");
    expect(plan?.kind).toBe("shared_event");
  });

  it("does not offer next_turn without valid branches", () => {
    expect(
      canBuildNextTurnRound({
        distanceToTurnMeters: 175,
        nextPinHasValidBranches: false,
      }),
    ).toBe(false);
  });

  it("lists eligible plans in priority order (no turn window)", () => {
    const snap = {
      distanceToTurnMeters: 300,
      canBuildNextZoneRound: true,
      canBuildZoneExitRound: true,
    };
    const plans = listEligibleRounds(snap, { mvpOnly: true });
    expect(plans.map((p) => p.type)).toEqual(["next_zone", "zone_exit_time"]);
    expect(selectBestRound(snap, { mvpOnly: true })?.type).toBe("next_zone");
  });

  it("falls through to next_zone when no turn window", () => {
    const plan = selectBestRound(
      {
        distanceToTurnMeters: 300,
        canBuildNextZoneRound: true,
      },
      { mvpOnly: true },
    );
    expect(plan?.type).toBe("next_zone");
  });

  it("falls through to zone_exit_time when next_zone unavailable", () => {
    const plan = selectBestRound(
      {
        distanceToTurnMeters: 300,
        canBuildZoneExitRound: true,
      },
      { mvpOnly: true },
    );
    expect(plan?.type).toBe("zone_exit_time");
  });

  it("returns null when no eligible rounds", () => {
    const plan = selectBestRound(
      { distanceToTurnMeters: 300 },
      { mvpOnly: true },
    );
    expect(plan).toBeNull();
  });
});

describe("shouldReplaceRound", () => {
  const baseRound = (t: BetRoundV2["type"]): BetRoundV2 => ({
    id: "r1",
    streamId: "s1",
    kind: t === "next_turn" ? "shared_event" : "personal_snapshot",
    type: t,
    state: "available",
    title: "",
    question: "",
    options: [],
    createdAt: new Date().toISOString(),
    provisional: {},
    signals: [],
    context: { streamId: "s1" },
  });

  it("does not replace same plan type", () => {
    expect(
      shouldReplaceRound({
        current: baseRound("zone_exit_time"),
        nextPlan: { type: "zone_exit_time", priority: 75, kind: "personal_snapshot" },
        userHasResolvingPersonalBet: false,
        sharedTurnLocked: false,
      }),
    ).toBe(false);
  });

  it("replaces lower priority with next_turn", () => {
    expect(
      shouldReplaceRound({
        current: baseRound("zone_exit_time"),
        nextPlan: { type: "next_turn", priority: 100, kind: "shared_event" },
        userHasResolvingPersonalBet: false,
        sharedTurnLocked: false,
      }),
    ).toBe(true);
  });

  it("blocks replace when user personal bet resolving", () => {
    const r = baseRound("zone_exit_time");
    r.state = "resolving";
    expect(
      shouldReplaceRound({
        current: r,
        nextPlan: { type: "next_turn", priority: 100, kind: "shared_event" },
        userHasResolvingPersonalBet: true,
        sharedTurnLocked: false,
      }),
    ).toBe(false);
  });
});
