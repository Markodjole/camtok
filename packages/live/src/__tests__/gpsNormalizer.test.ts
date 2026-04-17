import { describe, expect, it } from "vitest";
import { normalizeGpsBatch } from "../route-state/gpsNormalizer";

function t(offsetSec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSec)).toISOString();
}

describe("normalizeGpsBatch", () => {
  it("keeps plausible walking points", () => {
    const res = normalizeGpsBatch(null, "walking", [
      { recordedAt: t(0), lat: 40.7128, lng: -74.006, speedMps: 1.2, accuracyMeters: 5 },
      { recordedAt: t(1), lat: 40.71281, lng: -74.00599, speedMps: 1.3, accuracyMeters: 5 },
      { recordedAt: t(2), lat: 40.71283, lng: -74.00598, speedMps: 1.3, accuracyMeters: 5 },
    ]);
    expect(res.every((p) => !p.discarded)).toBe(true);
  });

  it("discards low-accuracy points", () => {
    const res = normalizeGpsBatch(null, "walking", [
      { recordedAt: t(0), lat: 40.7128, lng: -74.006, accuracyMeters: 500 },
    ]);
    expect(res[0].discarded).toBe(true);
    expect(res[0].discardReason).toBe("low_accuracy");
  });

  it("discards implausible jumps for walking", () => {
    const res = normalizeGpsBatch(null, "walking", [
      { recordedAt: t(0), lat: 40.7128, lng: -74.006, accuracyMeters: 5 },
      { recordedAt: t(1), lat: 40.8, lng: -74.006, accuracyMeters: 5 },
    ]);
    expect(res[1].discarded).toBe(true);
  });
});
