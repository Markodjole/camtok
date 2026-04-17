import type { ProposeMarketInput } from "../schemas";
import type { TransportPolicy } from "../safety/transportPolicy";

export type MarketValidation =
  | { ok: true; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

const UNSAFE_KEYWORDS = [
  "crash",
  "speed",
  "race",
  "ignore",
  "run red",
  "jump",
  "wrong way",
  "hit",
];

const AMBIGUOUS_PHRASES = ["maybe", "probably", "sort of", "kind of", "later"];

/**
 * Validate a user-proposed market. V1 applies simple lexical rules.
 * Upgradeable later with LLM-based clarity classification.
 */
export function validateUserMarket(
  input: ProposeMarketInput,
  policy: TransportPolicy,
): MarketValidation {
  const notes: string[] = [];

  if (!policy.allowUserMarkets) {
    return {
      ok: false,
      reason: "user_markets_disabled_for_current_mode",
      notes,
    };
  }

  const title = input.title.trim();
  if (title.length < 3) return { ok: false, reason: "title_too_short", notes };
  if (title.length > 120) return { ok: false, reason: "title_too_long", notes };

  const lower = title.toLowerCase();
  for (const kw of UNSAFE_KEYWORDS) {
    if (lower.includes(kw)) {
      return { ok: false, reason: "unsafe_language", notes: [`blocked_keyword:${kw}`] };
    }
  }
  for (const kw of AMBIGUOUS_PHRASES) {
    if (lower.includes(kw)) {
      notes.push(`ambiguous_phrase:${kw}`);
    }
  }

  const optionIds = new Set<string>();
  for (const o of input.options) {
    if (optionIds.has(o.id)) {
      return { ok: false, reason: "duplicate_option_id", notes };
    }
    optionIds.add(o.id);
    if (o.label.trim().length === 0) {
      return { ok: false, reason: "empty_option_label", notes };
    }
  }

  const labels = input.options.map((o) => o.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) {
    return { ok: false, reason: "duplicate_option_labels", notes };
  }

  return { ok: true, notes };
}
