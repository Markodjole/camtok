import { z } from "zod";

export const continuationOutputSchema = z.object({
  continuation_summary: z.string(),
  accepted_predictions: z.array(z.string()),
  rejected_predictions: z.array(z.string()),
  partially_matched: z.array(z.string()),
  media_prompt: z.string(),
  scene_explanation: z.string(),
  video_prompt: z.string().optional(),
  negative_prompt: z.string().optional(),
  video_duration_seconds: z.number().min(2).max(10).optional(),
});

export type ContinuationOutput = z.infer<typeof continuationOutputSchema>;

/**
 * Mock continuation generator.
 */
export function mockGenerateContinuation(
  _clipContext: string,
  predictions: string[]
): ContinuationOutput {
  const accepted = predictions.slice(0, Math.max(1, Math.floor(predictions.length / 2)));
  const rejected = predictions.slice(accepted.length);

  return {
    continuation_summary: "The scene continues with an unexpected but logical twist based on the most plausible predictions.",
    accepted_predictions: accepted,
    rejected_predictions: rejected,
    partially_matched: [],
    media_prompt: "Continue the scene with dramatic tension building, maintaining the established visual style and tone.",
    scene_explanation: "The continuation follows the most narratively coherent path while incorporating viewer predictions where they enhance the story.",
  };
}

export const DIRECTOR_SYSTEM_PROMPT = `You are the head writer and director of the next scene. Continue the story in a way that is coherent, emotionally readable, engaging to watch, and aligned with the current clip. Do not choose random outcomes only because users bet on them. However, user predictions may be incorporated if they improve the scene.

You may:
- fully accept a prediction
- partially accept a prediction
- reject a prediction
- combine multiple compatible predictions

Return JSON:
{
  continuation_summary: string,
  accepted_predictions: string[],
  rejected_predictions: string[],
  partially_matched: string[],
  media_prompt: string,
  scene_explanation: string
}`;
