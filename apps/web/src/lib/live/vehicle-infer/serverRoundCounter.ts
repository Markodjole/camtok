/**
 * Server-side round counter — mirrors mobile VehicleCountRoundCounter logic.
 */

export type ServerVehicleDetection = {
  vehicleType: "vehicle";
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
};

const VEHICLE_COUNT_ZONE_TOP = 0.22;
const VEHICLE_COUNT_ZONE_BOTTOM = 0.9;
const VEHICLE_COUNT_LINE_Y = 0.55;
const ROUND_TRACK_MATCH_IOU = 0.18;
const ROUND_TRACK_MAX_MISSES = 6;
const ROUND_MIN_HITS = 1;
const ROUND_MIN_HITS_LOW_CONF = 2;
const ROUND_MIN_CONFIDENCE = 0.42;
const ROUND_HIGH_CONFIDENCE = 0.62;

type RoundTrack = {
  id: string;
  hits: number;
  misses: number;
  wasAboveLine: boolean;
  crossed: boolean;
  inZone: boolean;
  peakConfidence: number;
  lastBox: { x: number; y: number; width: number; height: number };
};

let nextTrackId = 1;

function boxCenter(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function boxBottomCenter(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height };
}

function iou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function minHitsFor(confidence: number): number {
  return confidence >= ROUND_HIGH_CONFIDENCE
    ? ROUND_MIN_HITS
    : ROUND_MIN_HITS_LOW_CONF;
}

function centerInCountZone(centerY: number): boolean {
  return centerY >= VEHICLE_COUNT_ZONE_TOP && centerY <= VEHICLE_COUNT_ZONE_BOTTOM;
}

export class ServerVehicleCountRoundCounter {
  private roundId: string | null = null;
  private count = 0;
  private tracks = new Map<string, RoundTrack>();
  private countedIds = new Set<string>();

  beginRound(roundId: string): void {
    if (this.roundId === roundId) return;
    this.roundId = roundId;
    this.count = 0;
    this.tracks.clear();
    this.countedIds.clear();
    nextTrackId = 1;
  }

  observe(detections: ServerVehicleDetection[]): number {
    if (!this.roundId) return this.count;

    const usable = detections.filter((d) => d.confidence >= ROUND_MIN_CONFIDENCE);
    const unmatched = new Set(this.tracks.keys());
    const used = new Set<number>();
    const pairs: { trackId: string; detIdx: number; score: number }[] = [];

    for (const [trackId, track] of this.tracks) {
      usable.forEach((det, detIdx) => {
        const score = iou(track.lastBox, det.boundingBox);
        if (score >= ROUND_TRACK_MATCH_IOU) {
          pairs.push({ trackId, detIdx, score });
        }
      });
    }
    pairs.sort((a, b) => b.score - a.score);

    for (const pair of pairs) {
      if (!unmatched.has(pair.trackId) || used.has(pair.detIdx)) continue;
      unmatched.delete(pair.trackId);
      used.add(pair.detIdx);
      this.bump(this.tracks.get(pair.trackId)!, usable[pair.detIdx]!);
    }

    for (const trackId of unmatched) {
      const track = this.tracks.get(trackId)!;
      track.misses += 1;
      if (track.misses >= ROUND_TRACK_MAX_MISSES) {
        this.tracks.delete(trackId);
      }
    }

    usable.forEach((det, idx) => {
      if (used.has(idx)) return;
      const center = boxCenter(det.boundingBox);
      const id = `srv_${nextTrackId++}`;
      this.tracks.set(id, {
        id,
        hits: 1,
        misses: 0,
        wasAboveLine: center.y < VEHICLE_COUNT_LINE_Y,
        crossed: false,
        inZone: centerInCountZone(center.y),
        peakConfidence: det.confidence,
        lastBox: det.boundingBox,
      });
    });

    return this.count;
  }

  private bump(track: RoundTrack, det: ServerVehicleDetection): void {
    const center = boxCenter(det.boundingBox);
    const bottom = boxBottomCenter(det.boundingBox);
    track.hits += 1;
    track.misses = 0;
    track.peakConfidence = Math.max(track.peakConfidence, det.confidence);
    track.lastBox = det.boundingBox;
    track.inZone = centerInCountZone(center.y);

    const aboveNow = bottom.y < VEHICLE_COUNT_LINE_Y;
    if (track.wasAboveLine && !aboveNow && bottom.y >= VEHICLE_COUNT_LINE_Y) {
      this.tryCount(track);
    }
    if (!track.crossed && track.inZone) {
      this.tryCount(track);
    }
    track.wasAboveLine = aboveNow || center.y < VEHICLE_COUNT_LINE_Y;
  }

  private tryCount(track: RoundTrack): void {
    if (track.crossed || this.countedIds.has(track.id)) return;
    if (track.hits < minHitsFor(track.peakConfidence)) return;
    if (track.peakConfidence < ROUND_MIN_CONFIDENCE) return;
    if (!track.inZone && track.hits < ROUND_MIN_HITS_LOW_CONF) return;
    track.crossed = true;
    this.countedIds.add(track.id);
    this.count += 1;
  }
}

const counters = new Map<string, ServerVehicleCountRoundCounter>();

export function getServerRoundCounter(
  sessionId: string,
  roundId: string,
): ServerVehicleCountRoundCounter {
  const key = `${sessionId}:${roundId}`;
  let counter = counters.get(key);
  if (!counter) {
    counter = new ServerVehicleCountRoundCounter();
    counter.beginRound(roundId);
    counters.set(key, counter);
  }
  return counter;
}

export function clearServerRoundCounter(sessionId: string, roundId: string): void {
  counters.delete(`${sessionId}:${roundId}`);
}
