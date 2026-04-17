import { createHash } from "node:crypto";

export type LockEvidence = {
  currentNodeId: string;
  candidateOptionIds: string[];
  selectedOptionId: string;
  normalizedSnapshotTs: string;
  etaToDecisionSeconds: number | null;
  confidence: number;
  extra?: Record<string, unknown>;
};

export function computeCommitHash(evidence: LockEvidence): string {
  const canonical = JSON.stringify(evidence, Object.keys(evidence).sort());
  return createHash("sha256").update(canonical).digest("hex");
}
