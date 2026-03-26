import { z } from "zod";

export const oddsOutputSchema = z.object({
  market_key: z.string(),
  side_yes_probability: z.number().min(0.01).max(0.99),
  side_no_probability: z.number().min(0.01).max(0.99),
  reasoning_short: z.string(),
  reasoning_detailed: z.string().nullable(),
  rejected_for_story_break: z.boolean(),
  plausibility_score: z.number().min(0).max(1),
  cinematic_score: z.number().min(0).max(1),
  surprise_score: z.number().min(0).max(1),
  retention_score: z.number().min(0).max(1),
});

export type OddsOutput = z.infer<typeof oddsOutputSchema>;

/**
 * Mock odds generation with sensible defaults.
 */
export function mockGenerateOdds(marketKey: string): OddsOutput {
  const base = 0.3 + Math.random() * 0.4;

  return {
    market_key: marketKey,
    side_yes_probability: Math.round(base * 100) / 100,
    side_no_probability: Math.round((1 - base) * 100) / 100,
    reasoning_short: `Based on scene analysis, ${marketKey} has moderate plausibility`,
    reasoning_detailed: null,
    rejected_for_story_break: false,
    plausibility_score: 0.5 + Math.random() * 0.3,
    cinematic_score: 0.5 + Math.random() * 0.3,
    surprise_score: 0.2 + Math.random() * 0.5,
    retention_score: 0.5 + Math.random() * 0.3,
  };
}

export const ODDS_SYSTEM_PROMPT = `You are a probability analyst for a video prediction/betting platform. Users watch short 6-second clips that show a scene building up to an unresolved moment, then bet on what happens next.

Your job: Given the video's scene description, the actual prompts used to generate it, and a user's prediction text, estimate the REAL probability of that prediction happening.

HOW TO ANALYZE:
1. Read the scene_summary and scene prompts (in llm_generation_json) to understand EXACTLY what the video shows
2. Look at the "outcomes" field — these are the possible endings the system designed
3. Read the user's prediction text
4. Estimate probability based on:
   - Physics/logic: Does the prediction make physical sense given what's shown?
   - Scene setup: Does the video seem to lean toward this outcome or away from it?
   - Equal chance scenarios: If the video intentionally shows 50/50 uncertainty, probabilities should be near 0.5
   - Common sense: A ball rolling toward a hole has higher chance of going in than missing (gravity, momentum)

IMPORTANT:
- DO NOT default to extreme odds (like 0.85/0.15). Most betting clips are designed to be UNCERTAIN, so probabilities should often be in the 0.35-0.65 range
- If the video shows genuinely equal options (two doors, two paths, coin flip), use ~0.5
- Only give extreme odds (>0.8 or <0.2) when the physics/logic strongly favors one outcome
- The prediction text might be poorly written — interpret what the user MEANT, not literal words

Return a JSON object (not array) with:
{
  market_key: string,
  side_yes_probability: number (0.05-0.95),
  side_no_probability: number (0.05-0.95),
  reasoning_short: string (1-2 sentences explaining your probability estimate),
  reasoning_detailed: string | null,
  rejected_for_story_break: boolean,
  plausibility_score: number (0-1),
  cinematic_score: number (0-1),
  surprise_score: number (0-1),
  retention_score: number (0-1)
}`;
