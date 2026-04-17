import { describe, expect, it } from "vitest";
import { validateUserMarket } from "../live-markets/marketValidator";
import { policyFor } from "../safety/transportPolicy";

const walk = policyFor("walking");
const car = policyFor("car");

describe("validateUserMarket", () => {
  it("rejects for car mode by default", () => {
    const res = validateUserMarket(
      {
        roomId: "00000000-0000-0000-0000-000000000000",
        title: "Will they continue?",
        options: [
          { id: "a", label: "Yes" },
          { id: "b", label: "No" },
        ],
      },
      car,
    );
    expect(res.ok).toBe(false);
  });

  it("rejects unsafe wording even in walking mode", () => {
    const res = validateUserMarket(
      {
        roomId: "00000000-0000-0000-0000-000000000000",
        title: "Will he speed past?",
        options: [
          { id: "a", label: "Yes" },
          { id: "b", label: "No" },
        ],
      },
      walk,
    );
    expect(res.ok).toBe(false);
  });

  it("accepts clean walking mode market", () => {
    const res = validateUserMarket(
      {
        roomId: "00000000-0000-0000-0000-000000000000",
        title: "Will she enter the shop?",
        options: [
          { id: "yes", label: "Enters" },
          { id: "no", label: "Keeps walking" },
        ],
      },
      walk,
    );
    expect(res.ok).toBe(true);
  });

  it("rejects duplicate option labels", () => {
    const res = validateUserMarket(
      {
        roomId: "00000000-0000-0000-0000-000000000000",
        title: "Where does she go?",
        options: [
          { id: "a", label: "Left" },
          { id: "b", label: "Left" },
        ],
      },
      walk,
    );
    expect(res.ok).toBe(false);
  });
});
