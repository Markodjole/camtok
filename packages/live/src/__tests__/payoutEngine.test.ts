import { describe, expect, it } from "vitest";
import { computeParimutuelPayouts } from "../live-markets/payoutEngine";

describe("computeParimutuelPayouts", () => {
  it("refunds all when no winners", () => {
    const res = computeParimutuelPayouts(
      [
        { userId: "u1", optionId: "a", stakeAmount: 10 },
        { userId: "u2", optionId: "a", stakeAmount: 20 },
      ],
      "b",
    );
    expect(res.every((r) => !r.won)).toBe(true);
    expect(res.map((r) => r.payoutAmount)).toEqual([10, 20]);
  });

  it("splits pool proportionally among winners", () => {
    const res = computeParimutuelPayouts(
      [
        { userId: "u1", optionId: "a", stakeAmount: 10 },
        { userId: "u2", optionId: "b", stakeAmount: 30 },
        { userId: "u3", optionId: "a", stakeAmount: 10 },
      ],
      "a",
    );
    // total = 50, winners share = 20, each 'a' bet gets 25
    expect(res[0]).toMatchObject({ userId: "u1", won: true, payoutAmount: 25 });
    expect(res[1]).toMatchObject({ userId: "u2", won: false, payoutAmount: 0 });
    expect(res[2]).toMatchObject({ userId: "u3", won: true, payoutAmount: 25 });
  });
});
