import { describe, expect, it } from "vitest";
import { listEligibleRounds, selectBestRound, canBuildNextTurnRound } from "../betting-engine-v2/selectBestRound";
import { shouldReplaceRound } from "../betting-engine-v2/roundPolicy";
import type { BetRoundV2 } from "../betting-engine-v2/types";

describe("BettingEngineV2 selectBestRound", () => {
  it("prefers next_turn when in distance window with branches", () => {
    const plan = selectBestRound(
      {
        distanceToTurnMeters: 120,
        nextPinHasValidBranches: true,
        canBuildTimeVsGoogleRound: true,
      },
      { mvpOnly: true },
    );
    expect(plan?.type).toBe("next_turn");
    expect(plan?.kind).toBe("shared_event");
  });

  it("does not offer next_turn without valid branches", () => {
    expect(
      canBuildNextTurnRound({
        distanceToTurnMeters: 100,
        nextPinHasValidBranches: false,
      }),
    ).toBe(false);
  });

  it("lists all eligible MVP plans in priority order", () => {
    const snap = {
      distanceToTurnMeters: 120,
      nextPinHasValidBranches: true,
      canBuildTimeVsGoogleRound: true,
      canBuildTurnCountRound: true,
      canBuildEtaDriftRound: true,
    };
    const plans = listEligibleRounds(snap, { mvpOnly: true });
    expect(plans.map((p) => p.type)).toEqual([
      "next_turn",
      "time_vs_google",
      "eta_drift",
    ]);
    expect(selectBestRound(snap, { mvpOnly: true })?.type).toBe("next_turn");
  });

  it("falls through to time_vs_google when no turn window (MVP)", () => {
    const plan = selectBestRound(
      {
        distanceToTurnMeters: 300,
        canBuildTimeVsGoogleRound: true,
        canBuildEtaDriftRound: true,
      },
      { mvpOnly: true },
    );
    expect(plan?.type).toBe("time_vs_google");
  });

  it("respects mvpOnly for non-mvp types", () => {
    const full = selectBestRound(
      {
        distanceToTurnMeters: 400,
        canBuildNextZoneRound: true,
        canBuildTimeVsGoogleRound: true,
      },
      { mvpOnly: false },
    );
    expect(full?.type).toBe("next_zone");

    const mvp = selectBestRound(
      {
        distanceToTurnMeters: 400,
        canBuildNextZoneRound: true,
        canBuildTimeVsGoogleRound: true,
      },
      { mvpOnly: true },
    );
    expect(mvp?.type).toBe("time_vs_google");
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
        current: baseRound("time_vs_google"),
        nextPlan: { type: "time_vs_google", priority: 70, kind: "personal_snapshot" },
        userHasResolvingPersonalBet: false,
        sharedTurnLocked: false,
      }),
    ).toBe(false);
  });

  it("replaces lower priority with next_turn", () => {
    expect(
      shouldReplaceRound({
        current: baseRound("eta_drift"),
        nextPlan: { type: "next_turn", priority: 100, kind: "shared_event" },
        userHasResolvingPersonalBet: false,
        sharedTurnLocked: false,
      }),
    ).toBe(true);
  });

  it("blocks replace when user personal bet resolving", () => {
    const r = baseRound("time_vs_google");
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
