/**
 * Collapse labels that describe the same action but phrased differently
 * (e.g. nextStepCandidates vs availableOptions: "kitten drinks the milk" vs "drink milk").
 * Used before LLM plausibility scoring so we don't pay twice or double-count the same idea.
 */
export function candidateDedupeKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/\b(kitten|kittens|cat|cats|kitty|puppy|puppies|dog|dogs)\b/g, "")
    .replace(/\b(drinks?|drinking|drank)\b/g, "drink")
    .replace(/\b(eats?|eating|ate)\b/g, "eat")
    .replace(/\b(looks?|looking|looked)\b/g, "look")
    .replace(/\b(sniffs?|sniffing|sniffed)\b/g, "sniff")
    .replace(/\b(walks?|walking|walked)\b/g, "walk")
    .replace(/\b(picks?|picking|picked)\b/g, "pick")
    .replace(/\b(grabs?|grabbing|grabbed)\b/g, "grab")
    .replace(/\b(around|room)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * One representative label per cluster (prefer longest / most specific).
 * Also returns a resolver so every original label maps to its representative for score lookup.
 */
export function clusterCandidateLabels(labels: string[]): {
  representatives: string[];
  resolve: (label: string) => string;
} {
  const unique = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  const sorted = unique.sort((a, b) => b.length - a.length);
  const keyToRep = new Map<string, string>();

  for (const label of sorted) {
    const k = candidateDedupeKey(label);
    if (!k) continue;
    if (!keyToRep.has(k)) keyToRep.set(k, label);
  }

  const representatives = [...keyToRep.values()];

  function resolve(label: string): string {
    const k = candidateDedupeKey(label);
    return keyToRep.get(k) ?? label;
  }

  return { representatives, resolve };
}

/**
 * Copy plausibility scores from representatives onto every original label in the same cluster.
 */
export function expandPlausibilityScores<T extends { score: number; reasoning: string }>(
  scores: Record<string, T>,
  allOriginalLabels: string[],
  resolve: (label: string) => string,
): Record<string, T> {
  const out: Record<string, T> = { ...scores };
  for (const orig of allOriginalLabels) {
    const rep = resolve(orig);
    const s = scores[rep];
    if (s && !out[orig]) out[orig] = s;
  }
  return out;
}
