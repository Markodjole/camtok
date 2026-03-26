"use server";

import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  mockNormalize,
  generateAndValidate,
  oddsOutputSchema,
  ODDS_SYSTEM_PROMPT,
  mockGenerateOdds,
} from "@bettok/story-engine";

export async function submitPrediction(input: {
  clip_node_id: string;
  raw_text: string;
}) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  if (!input.raw_text || input.raw_text.length < 3) {
    return { error: "Prediction must be at least 3 characters" };
  }

  if (input.raw_text.length > 300) {
    return { error: "Prediction must be 300 characters or less" };
  }

  const { data: clipNode } = await supabase
    .from("clip_nodes")
    .select("status")
    .eq("id", input.clip_node_id)
    .single();

  if (!clipNode || clipNode.status !== "betting_open") {
    return { error: "Betting is not open for this clip" };
  }

  const normalized = mockNormalize(input.raw_text);

  const { data: existing } = await supabase
    .from("prediction_markets")
    .select("id")
    .eq("clip_node_id", input.clip_node_id)
    .eq("market_key", normalized.market_key)
    .single();

  if (existing) {
    return { data: existing, merged: true };
  }

  const { data: market, error: marketError } = await serviceClient
    .from("prediction_markets")
    .insert({
      clip_node_id: input.clip_node_id,
      raw_creator_input: input.raw_text,
      canonical_text: normalized.canonical_text,
      market_key: normalized.market_key,
      normalization_confidence: normalized.confidence,
      normalization_explanation: normalized.explanation,
      created_by_user_id: user.id,
      status: "open",
    })
    .select()
    .single();

  if (marketError) return { error: "Failed to create market" };

  // Gather all clip context for LLM odds calculation
  const { data: clipFull } = await serviceClient
    .from("clip_nodes")
    .select("scene_summary, genre, tone, blueprint_id, llm_generation_json, video_analysis_text")
    .eq("id", input.clip_node_id)
    .single();

  let blueprintDescription = "";
  let suggestedOutcomes: string[] = [];
  if (clipFull?.blueprint_id) {
    const { data: bp } = await serviceClient
      .from("clip_blueprints")
      .select("description, config_json")
      .eq("id", clipFull.blueprint_id)
      .single();
    if (bp) {
      blueprintDescription = bp.description || "";
      suggestedOutcomes = ((bp.config_json as Record<string, unknown>)?.suggested_outcomes as string[]) ?? [];
    }
  }

  const llmJson = clipFull?.llm_generation_json as Record<string, unknown> | null;
  const llmOutcomes = (llmJson?.obvious_outcomes as string[]) ?? [];
  const allSuggestedOutcomes = [...new Set([...suggestedOutcomes, ...llmOutcomes])];

  const { data: existingMarkets } = await serviceClient
    .from("prediction_markets")
    .select("canonical_text")
    .eq("clip_node_id", input.clip_node_id);

  let yesProbability = 0.5;
  let noProbability = 0.5;

  const isLlmAvailable = process.env.LLM_PROVIDER === "openai" && !!process.env.LLM_API_KEY;

  if (isLlmAvailable) {
    try {
      const scenePrompts = llmJson?.scenes
        ? (llmJson.scenes as any[]).map((s: any) => s?.prompt).filter(Boolean)
        : [];
      const outcomes = (llmJson?.outcomes as string[]) ?? allSuggestedOutcomes;

      const clipContext = {
        scene_summary: clipFull?.scene_summary ?? "Unknown scene",
        genre: clipFull?.genre ?? "unknown",
        tone: clipFull?.tone ?? "unknown",
        scene_prompts_used: scenePrompts,
        designed_outcomes: outcomes,
        video_analysis: (clipFull as Record<string, unknown>)?.video_analysis_text ?? null,
        enhanced_plot: llmJson?.enhanced_plot ?? null,
        negative_prompt: llmJson?.negative_prompt ?? null,
        existing_predictions: (existingMarkets || []).map((m) => (m as Record<string, unknown>).canonical_text),
        new_prediction: normalized.canonical_text,
        market_key: normalized.market_key,
      };

      const messages = [
        { role: "system" as const, content: ODDS_SYSTEM_PROMPT + "\n\nReturn a single JSON object (not an array) for this one prediction." },
        { role: "user" as const, content: JSON.stringify(clipContext) },
      ];

      const { data: oddsResult } = await generateAndValidate(messages, oddsOutputSchema, "Prediction odds");

      yesProbability = Math.max(0.05, Math.min(0.95, oddsResult.side_yes_probability));
      noProbability = Math.max(0.05, Math.min(0.95, oddsResult.side_no_probability));

      console.log(
        `[odds] prediction="${normalized.canonical_text}" yes=${yesProbability} no=${noProbability} reasoning="${oddsResult.reasoning_short}"`,
      );
    } catch (err: unknown) {
      console.error("[odds] LLM failed, using fallback:", (err as Error)?.message);
      const fallback = mockGenerateOdds(normalized.market_key);
      yesProbability = fallback.side_yes_probability;
      noProbability = fallback.side_no_probability;
    }
  } else {
    const fallback = mockGenerateOdds(normalized.market_key);
    yesProbability = fallback.side_yes_probability;
    noProbability = fallback.side_no_probability;
  }

  await serviceClient.from("market_sides").insert([
    {
      prediction_market_id: market.id,
      side_key: "yes",
      current_odds_decimal: Math.round((1 / yesProbability) * 100) / 100,
      probability: yesProbability,
    },
    {
      prediction_market_id: market.id,
      side_key: "no",
      current_odds_decimal: Math.round((1 / noProbability) * 100) / 100,
      probability: noProbability,
    },
  ]);

  await serviceClient
    .from("profiles")
    .update({
      total_predictions: (
        await supabase
          .from("profiles")
          .select("total_predictions")
          .eq("id", user.id)
          .single()
      ).data?.total_predictions + 1 || 1,
    })
    .eq("id", user.id);

  return { data: market, merged: false };
}
