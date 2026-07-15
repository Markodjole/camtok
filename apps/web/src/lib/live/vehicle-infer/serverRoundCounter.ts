/**
 * Server-side round counter — mirrors mobile VehicleCountRoundCounter logic.
 */

export type ServerVehicleDetection = {
  vehicleType: "vehicle";
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
};

const VEHICLE_COUNT_NEAR_FIELD_Y = 0.5;
const VEHICLE_COUNT_MIN_DOWNWARD_TRAVEL = 0.06;
const ROUND_TRACK_MATCH_IOU = 0.15;
const ROUND_TRACK_MATCH_DIST = 0.14;
const ROUND_TRACK_MAX_MISSES = 6;
const ROUND_MIN_HITS = 3;
const ROUND_MIN_CONFIDENCE = 0.5;

type Box = { x: number; y: number; width: number; height: number };

type RoundTrack = {
  id: string;
  hits: number;
  misses: number;
  counted: boolean;
  peakConfidence: number;
  minBottomY: number;
  maxBottomY: number;
  lastBox: Box;
};

let nextTrackId = 1;

function boxCenter(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function bottomY(box: Box): number {
  return box.y + box.height;
}

function centerDistance(a: Box, b: Box): number {
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

function iou(a: Box, b: Box): number {
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

function associationScore(track: RoundTrack, det: ServerVehicleDetection): number {
  const overlap = iou(track.lastBox, det.boundingBox);
  if (overlap >= ROUND_TRACK_MATCH_IOU) return 1 + overlap;
  const dist = centerDistance(track.lastBox, det.boundingBox);
  if (dist <= ROUND_TRACK_MATCH_DIST) return 1 - dist / ROUND_TRACK_MATCH_DIST;
  return 0;
}

export class ServerVehicleCountRoundCounter {
  private roundId: string | null = null;
  private count = 0;
  private tracks = new Map<string, RoundTrack>();

  beginRound(roundId: string): void {
    if (this.roundId === roundId) return;
    this.roundId = roundId;
    this.count = 0;
    this.tracks.clear();
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
        const score = associationScore(track, det);
        if (score > 0) pairs.push({ trackId, detIdx, score });
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
      const by = bottomY(det.boundingBox);
      const id = `srv_${nextTrackId++}`;
      const track: RoundTrack = {
        id,
        hits: 1,
        misses: 0,
        counted: false,
        peakConfidence: det.confidence,
        minBottomY: by,
        maxBottomY: by,
        lastBox: det.boundingBox,
      };
      this.tracks.set(id, track);
      this.tryCount(track);
    });

    return this.count;
  }

  private bump(track: RoundTrack, det: ServerVehicleDetection): void {
    const by = bottomY(det.boundingBox);
    track.hits += 1;
    track.misses = 0;
    track.peakConfidence = Math.max(track.peakConfidence, det.confidence);
    track.lastBox = det.boundingBox;
    track.minBottomY = Math.min(track.minBottomY, by);
    track.maxBottomY = Math.max(track.maxBottomY, by);
    this.tryCount(track);
  }

  private tryCount(track: RoundTrack): void {
    if (track.counted) return;
    if (track.hits < ROUND_MIN_HITS) return;
    if (track.peakConfidence < ROUND_MIN_CONFIDENCE) return;
    if (track.maxBottomY < VEHICLE_COUNT_NEAR_FIELD_Y) return;
    if (track.maxBottomY - track.minBottomY < VEHICLE_COUNT_MIN_DOWNWARD_TRAVEL) {
      return;
    }
    track.counted = true;
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
