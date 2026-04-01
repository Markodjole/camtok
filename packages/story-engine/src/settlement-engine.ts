import { z } from "zod";
import { generateAndValidate } from "./llm-adapter";

export const settlementScoreSchema = z.object({
  market_key: z.string(),
  yes_correctness: z.number().min(0).max(1),
  no_correctness: z.number().min(0).max(1),
  explanation_short: z.string(),
  explanation_long: z.string().nullable(),
  evidence_bullets: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type SettlementScore = z.infer<typeof settlementScoreSchema>;

/**
 * Mock settlement scoring — only used when LLM is unavailable.
 */
export function mockScoreSettlement(
  marketKey: string,
  _continuationSummary: string
): SettlementScore {
  const yesScore = Math.round((0.3 + Math.random() * 0.4) * 100) / 100;

  return {
    market_key: marketKey,
    yes_correctness: yesScore,
    no_correctness: Math.round((1 - yesScore) * 100) / 100,
    explanation_short: `The prediction "${marketKey}" was ${yesScore > 0.5 ? "largely" : "not sufficiently"} reflected in the continuation.`,
    explanation_long: null,
    evidence_bullets: [
      "Analyzed continuation scene against prediction",
      `Score: ${Math.round(yesScore * 100)}% match`,
    ],
    confidence: 0.8,
  };
}

export const SETTLEMENT_SYSTEM_PROMPT = `You are a fair and precise story-outcome judge.

Given:
1. The original scene context (what was happening before resolution)
2. A user's prediction (the "market_key" / "canonical_text")
3. The actual continuation that occurred (continuation_summary + selected_actions)

Determine whether the prediction came TRUE or NOT.

Score yes_correctness from 0.0 to 1.0:
- 1.0 = the predicted event fully and clearly occurred in the continuation
- 0.7-0.9 = the event mostly occurred, with minor differences in wording
- 0.4-0.6 = ambiguous — something related happened but not exactly this
- 0.1-0.3 = the predicted event did NOT occur, something different happened
- 0.0 = the predicted event clearly did not occur / the opposite happened

CRITICAL RULES:
- Compare the prediction against the SELECTED ACTIONS and CONTINUATION SUMMARY — these describe what ACTUALLY happened.
- If the prediction says "woman picks up baguette" but the continuation says "woman places pineapple in cart", that is 0.0 for yes_correctness.
- Be STRICT: partial matches (right character, wrong action) should score 0.2-0.3, not 0.5.
- Synonyms count: "puts in cart" ≈ "adds to basket" ≈ "places in shopping cart" → high match.
- Different objects = different events: "baguette" ≠ "pineapple", "black dress" ≠ "floral dress".

no_correctness = 1 - yes_correctness

Return JSON:
{
  "market_key": string,
  "yes_correctness": number (0-1),
  "no_correctness": number (0-1),
  "explanation_short": string (one sentence explaining the ruling),
  "explanation_long": string | null,
  "evidence_bullets": string[] (2-4 specific reasons),
  "confidence": number (0-1)
}`;

/**
 * LLM-based settlement scoring. Compares each prediction market against
 * what actually happened in the continuation to determine correctness.
 */
export async function scoreSettlementWithLlm(
  marketKey: string,
  canonicalText: string,
  continuationSummary: string,
  selectedActions: Array<{ label: string; weight?: number }>,
  sceneExplanation: string | null,
): Promise<SettlementScore> {
  const userMessage = `PREDICTION TO JUDGE:
market_key: "${marketKey}"
canonical_text: "${canonicalText}"

WHAT ACTUALLY HAPPENED IN THE CONTINUATION:
continuation_summary: "${continuationSummary}"

selected_actions (chosen by fair selection algorithm — these are what the video shows):
${selectedActions.map((a) => `- "${a.label}" (weight: ${a.weight?.toFixed(3) ?? "?"})`).join("\n")}

scene_explanation: "${sceneExplanation ?? "none"}"

Did the prediction come true? Score it.`;

  try {
    const { data } = await generateAndValidate(
      [
        { role: "system", content: SETTLEMENT_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      settlementScoreSchema,
      "SettlementScoring",
    );
    return { ...data, market_key: marketKey };
  } catch (err) {
    console.error(`[settlement] LLM scoring failed for "${marketKey}", using mock:`, (err as Error)?.message);
    return mockScoreSettlement(marketKey, continuationSummary);
  }
}
