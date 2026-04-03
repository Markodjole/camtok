"use server";

import { createServiceClient } from "@/lib/supabase/server";
import {
  mockGenerateContinuation,
  generateAndValidate,
  continuationOutputSchema,
  DIRECTOR_SYSTEM_PROMPT,
} from "@bettok/story-engine";
import {
  selectMultiple,
  buildVerificationSummary,
  selectOne,
} from "@bettok/fair-selection";
import type { SelectionCandidate, MultiSelectionResult } from "@bettok/fair-selection";
import { getContinuationContext } from "@/video-intelligence/pipeline";
import type { ContinuationContext } from "@/video-intelligence/types";
import { settleClipNode } from "@/actions/settlement";
import {
  clusterCandidateLabels,
  expandPlausibilityScores,
} from "@/lib/candidate-label-dedupe";

export async function startContinuation(clipNodeId: string) {
  const supabase = await createServiceClient();

  const { data: clipNode } = await supabase
    .from("clip_nodes")
    .select("*")
    .eq("id", clipNodeId)
    .single();

  if (!clipNode) return { error: "Clip not found" };

  if (
    clipNode.status !== "betting_locked" &&
    clipNode.status !== "betting_open"
  ) {
    return { error: "Clip is not in a lockable state" };
  }

  await supabase
    .from("clip_nodes")
    .update({ status: "betting_locked" })
    .eq("id", clipNodeId);

  await supabase
    .from("bets")
    .update({ status: "locked", locked_at: new Date().toISOString() })
    .eq("clip_node_id", clipNodeId)
    .eq("status", "active");

  await supabase
    .from("prediction_markets")
    .update({ status: "locked" })
    .eq("clip_node_id", clipNodeId)
    .in("status", ["open", "normalized"]);

  const { data: markets } = await supabase
    .from("prediction_markets")
    .select("canonical_text, market_key")
    .eq("clip_node_id", clipNodeId);

  const predictions = (markets || []).map(
    (m) => m.canonical_text
  );

  const { data: job, error: jobError } = await supabase
    .from("continuation_jobs")
    .insert({
      clip_node_id: clipNodeId,
      status: "queued",
    })
    .select()
    .single();

  if (jobError) return { error: "Failed to create job" };

  await supabase
    .from("clip_nodes")
    .update({ status: "continuation_generating" })
    .eq("id", clipNodeId);

  await supabase
    .from("continuation_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", job.id);

  // ── Run the full continuation pipeline ──────────────────────────────────

  const result = await runContinuationPipeline(
    clipNodeId,
    clipNode,
    predictions,
    String(job.id),
  );

  if (result.error) {
    await supabase
      .from("continuation_jobs")
      .update({ status: "failed", error_message: result.error, completed_at: new Date().toISOString() })
      .eq("id", job.id);
    await supabase
      .from("clip_nodes")
      .update({ status: "betting_open" })
      .eq("id", clipNodeId);
    await supabase
      .from("prediction_markets")
      .update({ status: "open" })
      .eq("clip_node_id", clipNodeId)
      .in("status", ["locked"]);
    await supabase
      .from("bets")
      .update({ status: "active", locked_at: null })
      .eq("clip_node_id", clipNodeId)
      .eq("status", "locked");
    return { error: result.error };
  }

  const { continuation, selectionData } = result;

  if (!result.videoStoragePath) {
    console.error("[continuation] Pipeline succeeded but no video was generated — rolling back");
    await supabase
      .from("continuation_jobs")
      .update({ status: "failed", error_message: "Video generation produced no file", completed_at: new Date().toISOString() })
      .eq("id", job.id);
    await supabase
      .from("clip_nodes")
      .update({ status: "betting_open" })
      .eq("id", clipNodeId);
    await supabase
      .from("prediction_markets")
      .update({ status: "open" })
      .eq("clip_node_id", clipNodeId)
      .in("status", ["locked"]);
    await supabase
      .from("bets")
      .update({ status: "active", locked_at: null })
      .eq("clip_node_id", clipNodeId)
      .eq("status", "locked");
    return { error: "Video generation failed — clip restored to betting" };
  }

  const selectedLabels = (selectionData?.selected as Array<Record<string, unknown>> | undefined)
    ?.map((s) => String(s.label ?? ""))
    .filter(Boolean) ?? [];
  let availableOptionsCount: number | null = null;
  let nextStepCandidatesCount: number | null = null;
  try {
    const contextForReason = await getContinuationContext(clipNodeId);
    if (contextForReason) {
      availableOptionsCount = contextForReason.availableOptions.length;
      nextStepCandidatesCount = contextForReason.nextStepCandidates.length;
    }
  } catch {
    // Ignore context fetch failures for reason text enrichment.
  }
  const decisionReasonText = [
    availableOptionsCount !== null
      ? `Video analysis found ${availableOptionsCount} visible options`
      : null,
    nextStepCandidatesCount !== null
      ? `${nextStepCandidatesCount} likely next-step candidates`
      : null,
    selectedLabels.length > 0
      ? `Fair selection chose: ${selectedLabels.join(" and ")}`
      : null,
    continuation.scene_explanation,
  ].filter(Boolean).join(". ");

  const { data: continuationClip } = await supabase
    .from("clip_nodes")
    .insert({
      story_id: clipNode.story_id,
      parent_clip_node_id: clipNodeId,
      depth: clipNode.depth + 1,
      creator_user_id: clipNode.creator_user_id,
      source_type: "continuation",
      status: "betting_open",
      scene_summary: continuation.continuation_summary,
      video_storage_path: result.videoStoragePath ?? null,
      genre: clipNode.genre,
      tone: clipNode.tone,
      realism_level: clipNode.realism_level,
      // Keep continuation node as internal branch state; feed renders continuation
      // through original clip's part2_video_storage_path instead of a new post card.
      published_at: null,
      betting_deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  await supabase
    .from("continuation_jobs")
    .update({
      status: "published",
      continuation_summary: continuation.continuation_summary,
      accepted_predictions: continuation.accepted_predictions,
      rejected_predictions: continuation.rejected_predictions,
      partially_matched: continuation.partially_matched,
      media_prompt: continuation.media_prompt,
      scene_explanation: continuation.scene_explanation,
      result_clip_node_id: continuationClip?.id,
      completed_at: new Date().toISOString(),
      ...(selectionData ? {
        selection_seed: selectionData.seed,
        selection_proof: selectionData.proofs,
        selected_candidates: selectionData.selected,
        video_generation_model: selectionData.videoModel,
      } : {}),
    })
    .eq("id", job.id);

  // Move parent clip into continuation_ready then settle it with the
  // normal settlement pipeline (markets, bets, wallet payouts, notifications).
  await supabase
    .from("clip_nodes")
    .update({
      status: "continuation_ready",
      part2_video_storage_path: result.videoStoragePath ?? null,
      winning_outcome_text: continuation.accepted_predictions?.[0] ?? continuation.continuation_summary,
      resolution_reason_text: decisionReasonText,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", clipNodeId);

  const settlementResult = await settleClipNode(clipNodeId);
  if ("error" in settlementResult) {
    console.error("[continuation] settleClipNode failed:", settlementResult.error);
    // Fallback: don't leave it in continuation_ready forever
    await supabase
      .from("clip_nodes")
      .update({
        status: "settled",
        winning_outcome_text: continuation.accepted_predictions?.[0] ?? continuation.continuation_summary,
        resolution_reason_text: decisionReasonText,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", clipNodeId);
  }

  await supabase
    .from("stories")
    .update({
      max_depth: clipNode.depth + 1,
      total_clips: (clipNode.total_clips || 1) + 1,
    })
    .eq("id", clipNode.story_id);

  // Trigger video analysis on the new clip
  if (continuationClip?.id && result.videoStoragePath) {
    import("@/video-intelligence/pipeline")
      .then((m) => m.analyzeClipVideo(continuationClip.id))
      .catch(() => {});
  }

  const { data: bettors } = await supabase
    .from("bets")
    .select("user_id")
    .eq("clip_node_id", clipNodeId)
    .eq("status", "locked");

  const uniqueUsers = [...new Set((bettors || []).map((b) => b.user_id))];

  for (const userId of uniqueUsers) {
    await supabase.from("notifications").insert({
      user_id: userId,
      type: "continuation_live",
      title: "Continuation is live!",
      body: "The story continues — see what happened and check your bets.",
      link: `/clip/${clipNodeId}`,
      reference_type: "clip_node",
      reference_id: clipNodeId,
    });
  }

  return { data: { jobId: job.id, continuationClipId: continuationClip?.id } };
}

// ─── Full continuation pipeline ──────────────────────────────────────────────

interface PipelineResult {
  continuation: {
    continuation_summary: string;
    accepted_predictions: string[];
    rejected_predictions: string[];
    partially_matched: string[];
    media_prompt: string;
    scene_explanation: string;
  };
  selectionData?: {
    seed: string;
    proofs: unknown[];
    selected: unknown[];
    videoModel: string;
  };
  videoStoragePath?: string;
  error?: string;
}

async function runContinuationPipeline(
  clipNodeId: string,
  clipNode: Record<string, unknown>,
  predictions: string[],
  jobId: string,
): Promise<PipelineResult> {
  const isLlmAvailable = process.env.LLM_PROVIDER === "openai" && !!process.env.LLM_API_KEY;
  const isFalAvailable = !!process.env.FAL_KEY;

  // Step 1: Get video analysis context
  let ctx: ContinuationContext | null = null;
  try {
    ctx = await getContinuationContext(clipNodeId);
  } catch (err) {
    console.error("[continuation] Failed to get video analysis:", (err as Error)?.message);
  }

  // Step 2: Real-world plausibility scoring + wildcard generation
  let plausibilityScores: Record<string, { score: number; reasoning: string }> = {};
  let wildcards: Array<{ label: string; weight: number; reasoning: string }> = [];

  if (ctx && isLlmAvailable) {
    const allCandidateLabels = [
      ...ctx.nextStepCandidates.map((c) => c.label),
      ...ctx.availableOptions.map((o) => o.label),
    ];
    const { representatives: plausibilityRepresentatives, resolve: resolvePlausibilityLabel } =
      clusterCandidateLabels(allCandidateLabels);

    if (plausibilityRepresentatives.length > 0) {
      try {
        const plausResult = await scoreRealWorldPlausibility(
          plausibilityRepresentatives,
          ctx.mainStory,
          ctx.characters,
          ctx.environment,
        );
        plausibilityScores = expandPlausibilityScores(
          plausResult.scores,
          allCandidateLabels,
          resolvePlausibilityLabel,
        );
        wildcards = plausResult.wildcards;

        console.log("[continuation][plausibility] Real-world scores:");
        for (const [label, data] of Object.entries(plausibilityScores)) {
          console.log(`  ${label}: ${data.score.toFixed(2)} — ${data.reasoning}`);
        }
        if (wildcards.length > 0) {
          console.log("[continuation][wildcards] Long-shot scenarios generated:");
          for (const w of wildcards) {
            console.log(`  ${w.label}: weight=${w.weight.toFixed(3)} — ${w.reasoning}`);
          }
        }
      } catch (err) {
        console.error("[continuation] Plausibility scoring failed, using video-only weights:", (err as Error)?.message);
      }
    }
  }

  // Step 3: Fair selection with blended weights (video confidence + real-world plausibility + wildcards)
  const VIDEO_WEIGHT_FACTOR = 0.6;
  const PLAUSIBILITY_WEIGHT_FACTOR = 0.4;

  let selection: MultiSelectionResult | null = null;
  let seed = "";

  if (ctx && ctx.nextStepCandidates.length > 0) {
    seed = `${clipNodeId}:job:${jobId}:ts:${Date.now()}`;

    // Build a lookup from availableOptions so we can assign conflict tags to candidates.
    // object_choice items conflict with each other (can only pick ONE item),
    // path_choice items conflict with each other (can only go ONE direction).
    const optionCategoryByLabel = new Map<string, string>();
    for (const opt of ctx.availableOptions) {
      optionCategoryByLabel.set(opt.label.toLowerCase(), opt.category);
    }

    function getConflictTags(label: string, category?: string): string[] | undefined {
      const cat = category ?? optionCategoryByLabel.get(label.toLowerCase());
      if (!cat) {
        const lbl = label.toLowerCase();
        for (const [optLabel, optCat] of optionCategoryByLabel) {
          if (lbl.includes(optLabel) || optLabel.includes(lbl)) return getConflictTags(optLabel, optCat);
        }
        return undefined;
      }
      if (cat === "object_choice") return ["object_pick"];
      if (cat === "path_choice") return ["path_direction"];
      return undefined;
    }

    const candidates: SelectionCandidate[] = ctx.nextStepCandidates.map((c) => {
      const videoW = c.probabilityScore;
      const plausW = plausibilityScores[c.label]?.score ?? 0.5;
      const blended = (videoW * VIDEO_WEIGHT_FACTOR) + (plausW * PLAUSIBILITY_WEIGHT_FACTOR);
      return {
        id: c.candidateId,
        label: c.label,
        weight: blended,
        conflictTags: getConflictTags(c.label),
        metadata: {
          source: "video_candidate",
          rationale: c.rationale,
          basedOn: c.basedOn,
          videoWeight: videoW,
          plausibilityWeight: plausW,
          plausibilityReasoning: plausibilityScores[c.label]?.reasoning ?? "no data",
        },
      };
    });

    for (const opt of ctx.availableOptions) {
      if (!candidates.some((c) => c.label.toLowerCase().includes(opt.label.toLowerCase()))) {
        const videoW = (opt.confidence ?? 0.3) * 0.5;
        const plausW = plausibilityScores[opt.label]?.score ?? 0.5;
        const blended = (videoW * VIDEO_WEIGHT_FACTOR) + (plausW * PLAUSIBILITY_WEIGHT_FACTOR);
        candidates.push({
          id: opt.optionId,
          label: opt.label,
          weight: blended,
          conflictTags: getConflictTags(opt.label, opt.category),
          metadata: {
            source: "available_option",
            videoWeight: videoW,
            plausibilityWeight: plausW,
            plausibilityReasoning: plausibilityScores[opt.label]?.reasoning ?? "no data",
          },
        });
      }
    }

    // Inject scored user predictions as low-weight candidates.
    // Users can type any prediction — the LLM rates each one for plausibility
    // and story interest, then they enter the fair selection pool.
    if (predictions.length > 0 && isLlmAvailable) {
      try {
        const novelPredictions = predictions.filter(
          (p) => !candidates.some((c) => c.label.toLowerCase() === p.toLowerCase()),
        );
        if (novelPredictions.length > 0) {
          const scored = await scoreUserPredictions(
            novelPredictions,
            ctx.mainStory,
            ctx.characters,
            ctx.environment,
            ctx.availableOptions.map((o) => o.label),
            ctx.nextStepCandidates.map((c) => c.label),
          );
          console.log("[continuation][user-predictions] Scored user predictions:");
          for (const sp of scored) {
            console.log(`  👤 "${sp.label}": weight=${sp.weight.toFixed(3)} — ${sp.reasoning}`);
          }
          for (let i = 0; i < scored.length; i++) {
            const sp = scored[i];
            if (sp.weight >= 0.01 && !candidates.some((c) => c.label.toLowerCase() === sp.label.toLowerCase())) {
              candidates.push({
                id: `user_pred_${i}`,
                label: sp.label,
                weight: sp.weight,
                conflictTags: getConflictTags(sp.label),
                metadata: {
                  source: "user_prediction",
                  videoWeight: 0,
                  plausibilityWeight: sp.weight,
                  plausibilityReasoning: sp.reasoning,
                },
              });
            }
          }
        }
      } catch (err) {
        console.error("[continuation] User prediction scoring failed:", (err as Error)?.message);
      }
    }

    // Inject wildcard long-shot scenarios
    for (let i = 0; i < wildcards.length; i++) {
      const w = wildcards[i];
      if (!candidates.some((c) => c.label.toLowerCase() === w.label.toLowerCase())) {
        candidates.push({
          id: `wildcard_${i}`,
          label: w.label,
          weight: w.weight,
          metadata: {
            source: "wildcard",
            videoWeight: 0,
            plausibilityWeight: w.weight,
            plausibilityReasoning: w.reasoning,
          },
        });
      }
    }

    console.log("[continuation][blended-weights] All candidates (video + options + wildcards):");
    for (const c of candidates) {
      const meta = c.metadata as Record<string, unknown>;
      const src = meta.source as string;
      if (src === "wildcard") {
        console.log(`  🎲 ${c.label}: final=${c.weight.toFixed(3)} [WILDCARD] — ${meta.plausibilityReasoning}`);
      } else {
        const conflict = c.conflictTags ? ` conflict=[${c.conflictTags.join(",")}]` : "";
        console.log(`  ${c.label}: final=${c.weight.toFixed(3)} (video=${Number(meta.videoWeight ?? 0).toFixed(2)} × ${VIDEO_WEIGHT_FACTOR} + plausibility=${Number(meta.plausibilityWeight ?? 0).toFixed(2)} × ${PLAUSIBILITY_WEIGHT_FACTOR}) [${src}]${conflict}`);
      }
    }

    try {
      selection = selectMultiple(candidates, {
        seed,
        maxSelections: 2,
        respectConflicts: true,
        minWeight: 0.02,
      });

      console.log("[continuation] Fair selection completed:");
      for (const s of selection.selected) {
        const singleResult = selectOne(candidates, { seed: `${seed}:verify:${s.id}` });
        console.log(buildVerificationSummary(singleResult, candidates));
      }
      console.log("[continuation] Selected:", selection.selected.map((s) => {
        const meta = s.metadata as Record<string, unknown> | undefined;
        return `${s.label} [${meta?.source ?? "?"}]`;
      }));
      if (selection.excludedByConflict.length > 0) {
        console.log("[continuation] Excluded by conflict:", selection.excludedByConflict.map((e) => e.label));
      }
    } catch (err) {
      console.error("[continuation] Fair selection failed:", (err as Error)?.message);
    }
  }

  // Log full resolution data
  console.log(
    `[continuation][resolve-dump] ${JSON.stringify({
      clipNodeId,
      jobId,
      hasVideoAnalysis: !!ctx,
      mainStory: ctx?.mainStory ?? null,
      currentState: ctx?.currentStateSummary ?? null,
      availableOptions: ctx?.availableOptions?.map((o) => ({ label: o.label, category: o.category, confidence: o.confidence })) ?? [],
      nextStepCandidates: ctx?.nextStepCandidates?.map((n) => ({ label: n.label, probability: n.probabilityScore, rationale: n.rationale })) ?? [],
      plausibilityScores: Object.fromEntries(
        Object.entries(plausibilityScores).map(([k, v]) => [k, { score: v.score, reasoning: v.reasoning }]),
      ),
      weightFormula: `final = video × ${VIDEO_WEIGHT_FACTOR} + plausibility × ${PLAUSIBILITY_WEIGHT_FACTOR}`,
      fairSelection: {
        seed,
        selectedActions: selection?.selected.map((s) => {
          const meta = s.metadata as Record<string, unknown> | undefined;
          return {
            id: s.id,
            label: s.label,
            finalWeight: s.weight,
            videoWeight: meta?.videoWeight,
            plausibilityWeight: meta?.plausibilityWeight,
            plausibilityReasoning: meta?.plausibilityReasoning,
          };
        }) ?? [],
        excludedByConflict: selection?.excludedByConflict.map((e) => ({ id: e.id, label: e.label })) ?? [],
        proofCount: selection?.proofs.length ?? 0,
      },
      wildcards: wildcards.map((w) => ({ label: w.label, weight: w.weight, reasoning: w.reasoning })),
      totalCandidates: (ctx?.nextStepCandidates.length ?? 0) + (ctx?.availableOptions.length ?? 0) + wildcards.length,
      predictions,
    }, null, 2)}`,
  );

  // Step 3: LLM generates the continuation narrative + video prompt
  const continuation = await generateContinuationNarrative(
    ctx,
    selection,
    String(clipNode.scene_summary ?? ""),
    predictions,
    isLlmAvailable,
  );

  console.log(
    `[continuation][narrative-result] ${JSON.stringify({
      continuation_summary: continuation.continuation_summary,
      accepted_predictions: continuation.accepted_predictions,
      rejected_predictions: continuation.rejected_predictions,
      partially_matched: continuation.partially_matched,
      scene_explanation: continuation.scene_explanation,
      video_prompt: continuation.video_prompt?.slice(0, 300),
      negative_prompt: continuation.negative_prompt,
    }, null, 2)}`,
  );

  // Step 4: Generate the continuation video
  let videoStoragePath: string | undefined;

  if (isFalAvailable && continuation.video_prompt) {
    try {
      videoStoragePath = await generateContinuationVideo(
        clipNodeId,
        clipNode,
        continuation.video_prompt,
        continuation.negative_prompt,
        ctx,
        continuation.video_duration_seconds,
      );
    } catch (err) {
      console.error("[continuation] Video generation failed:", (err as Error)?.message);
    }
  }

  return {
    continuation,
    selectionData: selection ? {
      seed,
      proofs: selection.proofs,
      selected: selection.selected,
      videoModel: "fal-ai/kling-video/v3/pro/image-to-video",
    } : undefined,
    videoStoragePath,
  };
}

// ─── Real-world plausibility scoring ─────────────────────────────────────────

interface PlausibilityResult {
  scores: Record<string, { score: number; reasoning: string }>;
  wildcards: Array<{ label: string; weight: number; reasoning: string }>;
}

async function scoreRealWorldPlausibility(
  candidateLabels: string[],
  mainStory: string,
  characters: ContinuationContext["characters"],
  environment: ContinuationContext["environment"],
): Promise<PlausibilityResult> {
  const characterDesc = characters.map((c) => {
    const parts = [c.label];
    if (c.ageGroup && c.ageGroup !== "unknown") parts.push(`age group: ${c.ageGroup}`);
    if (c.dominantEmotion) parts.push(c.dominantEmotion);
    if (c.clothingTop) parts.push(c.clothingTop);
    return parts.join(", ");
  }).join("; ");

  const envDesc = [
    environment.locationType,
    ...(environment.settingTags ?? []),
    environment.economicContext,
  ].filter(Boolean).join(", ");

  const systemPrompt = `You are a real-world statistics and behavioral logic analyst. You have two jobs:

JOB 1 — PLAUSIBILITY SCORING:
Given a scene with specific characters and environment, score how likely each candidate action is IN THE REAL WORLD — not based on what's visible in the video, but based on demographics, behavioral statistics, common sense, and cultural norms.

For each candidate, return:
- score: 0.0–1.0 (how likely this action is in real life given the people and context)
- reasoning: one sentence explaining why (cite demographics, statistics, or common sense)

Examples:
- "Young children rarely choose diet drinks; they prefer sweet/sugary options (pediatric dietary studies)" → score: 0.15
- "Coca-Cola is the #1 most chosen soda worldwide, especially among children" → score: 0.85

JOB 2 — WILDCARD SCENARIOS:
Generate 3–5 additional unlikely-but-possible scenarios that are NOT in the candidate list.
These are long-shot events that COULD realistically happen in this scene but nobody would expect.

Each wildcard must have:
- label: short action description (same format as existing candidates)
- weight: 0.02–0.12 (very low — these are unlikely events)
- reasoning: why this could happen despite being unlikely

Wildcard categories to consider:
- DISRUPTION: something unexpected interrupts (machine jams, power flickers, someone bumps into character)
- CHANGE OF MIND: character hesitates, walks away, picks something else entirely
- SOCIAL: another person enters the scene, speaks to character, takes the item first
- ENVIRONMENTAL: weather change, noise distraction, something falls
- EMOTIONAL: character gets distracted, scared, excited by something off-screen

Rules:
- Wildcards must be physically plausible for the scene
- No fantasy/supernatural events
- Each should feel like "that could happen 1 in 50 times"
- Don't duplicate existing candidates

Return JSON:
{
  "scores": [ { "label": string, "score": number, "reasoning": string } ],
  "wildcards": [ { "label": string, "weight": number, "reasoning": string } ]
}`;

  const userMessage = `Scene: ${mainStory}
Characters: ${characterDesc}
Environment: ${envDesc}

Existing candidates to score for plausibility:
${candidateLabels.map((l, i) => `${i + 1}. "${l}"`).join("\n")}

Now score each candidate AND generate 3-5 wildcard scenarios.`;

  const { generateAndValidate: gen } = await import("@bettok/story-engine");
  const { z } = await import("zod");

  const schema = z.object({
    scores: z.array(z.object({
      label: z.string(),
      score: z.number().min(0).max(1),
      reasoning: z.string(),
    })),
    wildcards: z.array(z.object({
      label: z.string(),
      weight: z.number().min(0.01).max(0.15),
      reasoning: z.string(),
    })),
  });

  const { data } = await gen(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    schema,
    "PlausibilityScoring",
  );

  const scores: Record<string, { score: number; reasoning: string }> = {};
  for (const item of data.scores) {
    const matchedLabel = candidateLabels.find(
      (l) => l.toLowerCase() === item.label.toLowerCase(),
    ) ?? item.label;
    scores[matchedLabel] = { score: item.score, reasoning: item.reasoning };
  }

  const wildcards = data.wildcards.map((w) => ({
    label: w.label,
    weight: Math.min(w.weight, 0.12),
    reasoning: w.reasoning,
  }));

  return { scores, wildcards };
}

// ─── User prediction scoring ─────────────────────────────────────────────────

async function scoreUserPredictions(
  userPredictions: string[],
  mainStory: string,
  characters: ContinuationContext["characters"],
  environment: ContinuationContext["environment"],
  existingOptions: string[],
  existingCandidates: string[],
): Promise<Array<{ label: string; weight: number; reasoning: string }>> {
  const characterDesc = characters.map((c) => {
    const parts = [c.label];
    if (c.ageGroup && c.ageGroup !== "unknown") parts.push(`age group: ${c.ageGroup}`);
    if (c.dominantEmotion) parts.push(c.dominantEmotion);
    return parts.join(", ");
  }).join("; ");

  const envDesc = [
    environment.locationType,
    ...(environment.settingTags ?? []),
  ].filter(Boolean).join(", ");

  const systemPrompt = `You score USER-WRITTEN predictions for a video continuation betting platform.

Users write free-text predictions about what will happen next in a video clip. These are NOT from AI analysis — they come from real users watching the video.

Your job: rate each prediction on TWO axes and produce a final weight.

AXIS 1 — PHYSICAL PLAUSIBILITY (0.0–1.0):
Can this actually happen given the scene, characters, and environment?
- 1.0 = perfectly natural/expected in this setting
- 0.5 = possible but requires some coincidence
- 0.1 = barely possible, very unlikely
- 0.0 = physically impossible or contradicts the scene

AXIS 2 — STORY INTEREST (0.0–1.0):
Would this make the continuation video more engaging/surprising/entertaining?
- 1.0 = would make a great twist, viewers would love it
- 0.5 = reasonable and watchable
- 0.1 = boring or redundant with obvious outcomes

FINAL WEIGHT formula: plausibility × 0.6 + interest × 0.4, then cap at 0.15 max.
If plausibility < 0.1, set weight to 0 regardless of interest (impossible events aren't interesting).

Existing AI-generated options (for reference — don't duplicate):
${existingOptions.map((o) => `- ${o}`).join("\n")}

Existing AI-generated candidates:
${existingCandidates.map((c) => `- ${c}`).join("\n")}

If a user prediction is essentially the same as an existing option/candidate (just worded differently), set weight to 0 and explain it's a duplicate.

Return JSON:
{
  "scored_predictions": [
    { "label": string (the user's original text), "plausibility": number, "interest": number, "weight": number, "reasoning": string }
  ]
}`;

  const userMessage = `Scene: ${mainStory}
Characters: ${characterDesc}
Environment: ${envDesc}

User predictions to score:
${userPredictions.map((p, i) => `${i + 1}. "${p}"`).join("\n")}`;

  const { generateAndValidate: gen } = await import("@bettok/story-engine");
  const { z } = await import("zod");

  const schema = z.object({
    scored_predictions: z.array(z.object({
      label: z.string(),
      plausibility: z.number().min(0).max(1),
      interest: z.number().min(0).max(1),
      weight: z.number().min(0).max(0.2),
      reasoning: z.string(),
    })),
  });

  const { data } = await gen(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    schema,
    "UserPredictionScoring",
  );

  return data.scored_predictions.map((sp) => ({
    label: sp.label,
    weight: Math.min(sp.weight, 0.15),
    reasoning: sp.reasoning,
  }));
}

// ─── LLM narrative generation ────────────────────────────────────────────────

async function generateContinuationNarrative(
  ctx: ContinuationContext | null,
  selection: MultiSelectionResult | null,
  sceneSummaryFallback: string,
  predictions: string[],
  isLlmAvailable: boolean,
) {
  type ContinuationResult = {
    continuation_summary: string;
    accepted_predictions: string[];
    rejected_predictions: string[];
    partially_matched: string[];
    media_prompt: string;
    scene_explanation: string;
    video_prompt?: string;
    negative_prompt?: string;
    video_duration_seconds?: number;
  };

  if (!isLlmAvailable) {
    return mockGenerateContinuation(sceneSummaryFallback, predictions) as ContinuationResult;
  }

  const selectedActions = selection?.selected.map((s) => {
    const meta = s.metadata as Record<string, unknown> | undefined;
    return {
      action: s.label,
      finalWeight: s.weight,
      videoWeight: meta?.videoWeight ?? null,
      plausibilityWeight: meta?.plausibilityWeight ?? null,
      plausibilityReasoning: meta?.plausibilityReasoning ?? null,
      rationale: meta?.rationale ?? "",
    };
  }) ?? [];

  const contextPayload = ctx ? {
    main_story: ctx.mainStory,
    current_state: ctx.currentStateSummary,
    characters: ctx.characters.map((c) => ({
      id: c.characterId,
      label: c.label,
      age_group: c.ageGroup,
      gender_presentation: c.genderPresentation,
      body_build: c.bodyBuild,
      hair: c.hairDescription,
      clothing_top: c.clothingTop,
      clothing_bottom: c.clothingBottom,
      accessories: c.accessories,
      emotion: c.dominantEmotion,
      posture: c.posture,
    })),
    objects: ctx.objects.map((o) => ({
      id: o.objectId,
      label: o.label,
      category: o.category,
      state: o.state,
      color: o.color,
      location_in_frame: o.locationInFrame,
      brand: o.brandOrTextVisible,
      price: o.priceIfVisible,
    })),
    environment: {
      location: ctx.environment.locationType,
      setting: ctx.environment.settingTags,
      lighting: ctx.environment.lighting,
      visible_text: ctx.environment.visibleText,
      price_range: ctx.environment.priceRange,
      economic_context: ctx.environment.economicContext,
    },
    continuity_anchors: ctx.continuityAnchors,
    available_options: ctx.availableOptions.map((o) => ({
      label: o.label,
      category: o.category,
      source: o.source,
      price: o.priceIfVisible,
      confidence: o.confidence,
    })),
    preference_signals: ctx.preferenceSignals.map((p) => ({
      character: p.characterId,
      domain: p.domain,
      value: p.value,
      basis: p.basis,
      strength: p.strength,
    })),
    selected_next_actions: selectedActions,
    all_next_step_candidates: ctx.nextStepCandidates.map((n) => ({
      action: n.label,
      probability: n.probabilityScore,
      rationale: n.rationale,
    })),
    unresolved_questions: ctx.unresolvedQuestions,
    predictions,
  } : {
    scene_summary: sceneSummaryFallback,
    predictions,
    selected_next_actions: selectedActions,
  };

  const systemPrompt = `${DIRECTOR_SYSTEM_PROMPT}

ADDITIONAL RULES FOR EVIDENCE-BASED CONTINUATION:
You have structured video analysis data below. USE IT as your primary source of truth.

FAIR SELECTION:
The "selected_next_actions" were chosen by a provably fair algorithm (SHA-256 weighted selection) with blended weights from video analysis AND real-world plausibility scoring.
You MUST incorporate ALL selected actions into the continuation — every single one, not just the first.
If 2 actions were selected, the scene must show BOTH happening in sequence (action 1, then action 2).
BUT if only 1 object/item pick was selected, the video must CLEARLY and UNAMBIGUOUSLY show that ONE choice being made — not the character vaguely handling multiple items.
For example: if fair selection chose "picks up black dress", the video must show her clearly choosing the black dress, putting down the other, or walking away with it. The viewer must be able to tell WHICH item won.
You may embellish, add detail, and weave in predictions — but every selected action must visibly occur.

The weights include a "plausibilityReasoning" field explaining the real-world logic behind each choice.
You should reference this in scene_explanation so users understand the decision considered both video evidence and real-world logic.

Priority order:
1. ALL selected actions from fair selection (MANDATORY — these define what happens, ALL must appear)
2. What was visibly happening in the clip (observed facts)
3. What options are visibly available (from video analysis)
4. What the character has shown preference for (from evidence, not guessing)
5. User predictions that are compatible with the selected actions

CONTINUITY IS CRITICAL — CHARACTER IDENTITY:
- The continuation is an image-to-video that starts from the LAST FRAME of the original clip.
- Characters MUST be described with their EXACT appearance from the video analysis: hair color/style, clothing (top AND bottom), body build, age group, accessories.
- The video_prompt MUST begin with a full character description that matches the analysis data EXACTLY. Do NOT use vague terms like "a person" or "a man" — be specific: "a young adult male with [hair], wearing [top] and [bottom], [build] build".
- If hair description is "unknown", describe what IS known (age, build, clothing).
- NEVER change clothing, hair, or physical features between Part 1 and Part 2.
- Objects must maintain their state AND their location. Check each object's "state" and "location_in_frame" fields.
  - If an object state is "held", do NOT say the character "picks it up" — they already have it.
  - If pineapple location is "produce section", don't show it near the bread shelf.
- Environment must not change.
- Economic consistency: a person in a $1000 car does not suddenly have luxury items.

OBJECT STATE AWARENESS:
- Read the "objects" data carefully. Each object has a "state" field telling you its current condition.
- "held" = character is already holding it → actions: put down, examine, hand to someone, put in cart
- "in shopping cart" = already in the cart → actions: take out, rearrange, keep
- "on shelf" / "whole" = untouched on display → actions: reach for, pick up, examine
- NEVER describe a character picking up something they already hold. This is nonsensical.

EXAMPLE of correct video_prompt opening (starts with action, brief character anchor):
"The young man in the dark hoodie extends his right hand toward the shelf, grabs the bottle of olive oil, and places it in the cart."

EXAMPLE of WRONG video_prompt opening (re-describes static scene, wastes time):
"A young adult male with short brown curly hair, wearing a dark hoodie and jeans, average build, stands in a grocery store aisle looking at products on the shelf. He seems interested. He extends his right hand toward..."

VIDEO PROMPT — CRITICAL RULES FOR KLING AI IMAGE-TO-VIDEO:
You MUST return "video_prompt" and "negative_prompt" fields.

The video_prompt is sent to Kling AI **image-to-video** model. The START IMAGE already shows the full scene (characters, environment, objects). Follow these rules:

RULE 0 — THIS IS A CONTINUATION (PART 2). IT MUST SHOW THE RESOLUTION.
Part 1 already showed the setup/tension/anticipation with NO resolution.
Part 2 (this video) MUST show THE DECISIVE ACTION CLEARLY AND UNMISTAKABLY.
The viewer must see the outcome happen — not just "about to happen" or "beginning to happen."

RULE 1 — DO NOT RE-DESCRIBE THE STATIC SCENE.
The start image already contains the characters, setting, and objects. Kling sees it.
If you describe "a kitten sits on the floor next to two bowls" — Kling will spend the first 2-3 seconds showing exactly that static scene, wasting video time.
Instead, START WITH MOVEMENT. The very first words should describe what CHANGES from the start image.

BAD (wastes time on static re-description):
"A small curious kitten with soft fur sits on a cozy living room floor. The kitten looks around the room. Then the kitten steps forward and begins to eat."

GOOD (starts with action immediately):
"The kitten steps forward toward the brown bowl. Its head lowers into the bowl and it eats eagerly, chewing the cat food. Its tail sways contentedly."

RULE 2 — FRONT-LOAD THE RESOLUTION ACTION.
The most important action must happen in the FIRST HALF of the video, not the last second.
If the resolution is "kitten eats cat food", that action must START within the first 2 seconds.
Any secondary actions (looking around, pausing) come BEFORE the resolution, kept very brief (1-2 words, not a whole sentence).

BAD: "The kitten pauses. The kitten looks left. The kitten looks right. The kitten sniffs. The kitten steps forward. The kitten begins to eat." (resolution buried at end, will get cut off)
GOOD: "The kitten glances around briefly, then lowers its head into the brown bowl and eats the cat food eagerly." (resolution is the main event)

RULE 3 — USE STRONG, COMPLETED ACTION VERBS.
Kling interprets "begins to", "starts to", "about to" as APPROACHING but not doing.
Use verbs that describe the COMPLETED or ONGOING action:
BAD: "begins to eat", "starts picking up", "about to drink"
GOOD: "eats eagerly", "picks up and holds", "drinks from the bowl", "chews the food"

RULE 4 — ONLY mention the target object/brand. NEVER mention competing items in the prompt.
BAD: "boy at Coca-Cola machine picks up Diet Coke" (model sees both brands, gets confused)
GOOD: "boy reaches into the machine, grabs a Diet Coke can, pulls it out and smiles"

RULE 5 — Describe PHYSICAL ACTION as body movements:
BAD: "picks up a can"
GOOD: "extends right hand, fingers wrap around the can, lifts it from the shelf"

RULE 6 — Structure: [brief character anchor] + [DECISIVE ACTION] + [result/reaction] + [camera/mood]
The character anchor is just enough to maintain identity (1 short phrase), NOT a full re-description.
Example: "The boy in the yellow shirt grabs the Diet Coke can from the machine slot, holds it up, and grins widely. Close-up shot, warm lighting."

RULE 7 — negative_prompt must include all competing items/actions that should NOT appear.

RULE 8 — Causal consistency: action prerequisites come first, target stays consistent through the sequence.

VIDEO DURATION:
You MUST return "video_duration_seconds" — an integer from 2 to 10.
Pick the duration based on how many distinct physical actions the scene contains:
- 1 simple action (e.g. put item in cart): 4
- 1 action + reaction (e.g. put item in cart, companion nods): 5
- 2 sequential actions (e.g. examine label, then hand to companion): 6–7
- 3+ actions or actions with dialogue/discussion: 8–10
Shorter is better for simple outcomes — a 4-second clip of one clear action looks natural, while stretching it to 10 looks slow-motion.

Return JSON:
{
  continuation_summary: string,
  accepted_predictions: string[],
  rejected_predictions: string[],
  partially_matched: string[],
  media_prompt: string,
  scene_explanation: string,
  video_prompt: string,
  negative_prompt: string,
  video_duration_seconds: number (2-10)
}`;

  try {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: JSON.stringify(contextPayload) },
    ];
    const { data } = await generateAndValidate(messages, continuationOutputSchema, "Continuation");
    return data as ContinuationResult;
  } catch (err) {
    console.error("[continuation] LLM failed, using mock:", (err as Error)?.message);
    return mockGenerateContinuation(sceneSummaryFallback, predictions) as ContinuationResult;
  }
}

// ─── Video generation via Fal.ai ─────────────────────────────────────────────

async function generateContinuationVideo(
  clipNodeId: string,
  clipNode: Record<string, unknown>,
  videoPrompt: string,
  negativePrompt: string | undefined,
  ctx: ContinuationContext | null,
  durationSeconds?: number,
): Promise<string> {
  const supabase = await createServiceClient();
  const { getFalClient, falLongJobOptions } = await import("@/lib/fal/server");
  const fal = getFalClient();

  // Extract last frame from current clip for visual continuity
  let startImageUrl: string | null = null;

  const videoPath = String(clipNode.video_storage_path ?? "");
  if (videoPath) {
    try {
      const { data: videoBlob } = await supabase.storage
        .from("media")
        .download(videoPath);

      if (videoBlob) {
        const { extractLastFrame } = await import("@/video-intelligence/last-frame");
        const lastFrameBuffer = await extractLastFrame(new Uint8Array(await videoBlob.arrayBuffer()));
        const lastFrameBytes = new Uint8Array(lastFrameBuffer);

        const lastFrameBlob = new Blob([lastFrameBytes], { type: "image/jpeg" });
        startImageUrl = await fal.storage.upload(lastFrameBlob);
        console.log("[continuation] Last frame uploaded to Fal:", startImageUrl);
      }
    } catch (err) {
      console.error("[continuation] Last frame extraction failed:", (err as Error)?.message);
    }
  }

  if (!startImageUrl) {
    throw new Error("Cannot generate continuation video without a start image (last frame extraction failed)");
  }

  // Build a detailed character identity string from analysis data to enforce
  // visual consistency between Part 1 and Part 2.
  let prompt = videoPrompt;
  if (ctx) {
    const charParts: string[] = [];

    for (const c of ctx.characters) {
      const desc: string[] = [];
      if (c.ageGroup && c.ageGroup !== "unknown") desc.push(c.ageGroup.replace(/_/g, " "));
      if (c.genderPresentation && c.genderPresentation !== "unknown") {
        desc.push(c.genderPresentation === "male_presenting" ? "male" : c.genderPresentation === "female_presenting" ? "female" : c.genderPresentation);
      }
      if (c.bodyBuild && c.bodyBuild !== "unknown") desc.push(`${c.bodyBuild} build`);
      if (c.hairDescription && c.hairDescription !== "unknown") desc.push(`${c.hairDescription} hair`);
      const clothing: string[] = [];
      if (c.clothingTop && c.clothingTop !== "unknown") clothing.push(c.clothingTop);
      if (c.clothingBottom && c.clothingBottom !== "unknown") clothing.push(c.clothingBottom);
      if (clothing.length > 0) desc.push(`wearing ${clothing.join(" and ")}`);
      if (c.accessories && c.accessories.length > 0) desc.push(`with ${c.accessories.join(", ")}`);
      if (desc.length > 0) {
        charParts.push(desc.join(", "));
      }
    }

    const charIdentity = charParts.length > 0
      ? `SAME CHARACTER: ${charParts.join("; ")}.`
      : "";

    const cameraAnchor = ctx.continuityAnchors?.cameraStyle?.slice(0, 1).join(", ") ?? "";

    const anchorPrefix = [charIdentity, cameraAnchor].filter(Boolean).join(" ");
    if (anchorPrefix) {
      prompt = `${anchorPrefix} ${prompt}`;
    }
  }

  console.log("[continuation] Generating video with Kling I2V");
  console.log("[continuation] Prompt:", prompt.slice(0, 200));

  const video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
    ...falLongJobOptions,
    input: {
      start_image_url: startImageUrl,
      prompt,
      negative_prompt: `${negativePrompt || "blurry, low quality, text overlay, watermark"}, different person, different clothes, costume change, different hair, different outfit, wardrobe change, distorted face`,
      duration: String(Math.min(10, Math.max(2, durationSeconds ?? 5))),
      generate_audio: true,
    },
    logs: true,
    onQueueUpdate: (u: unknown) => {
      const status = (u as Record<string, unknown>)?.status ?? "unknown";
      console.log(`[continuation] video.queue: ${status}`);
    },
  });

  const falResult = video as Record<string, unknown>;
  const videoUrlCandidates = [
    (falResult.video as Record<string, unknown> | undefined)?.url,
    ((falResult.data as Record<string, unknown> | undefined)?.video as Record<string, unknown> | undefined)?.url,
    ((falResult.output as Record<string, unknown> | undefined)?.video as Record<string, unknown> | undefined)?.url,
    ((falResult.result as Record<string, unknown> | undefined)?.video as Record<string, unknown> | undefined)?.url,
  ];
  const videoUrl = videoUrlCandidates.find((u): u is string => typeof u === "string" && u.length > 0) ?? null;

  if (!videoUrl) {
    console.error("[continuation] Fal response keys:", Object.keys(falResult));
    throw new Error("Fal returned no video URL");
  }

  // Download and upload to Supabase storage
  const videoResponse = await fetch(videoUrl);
  const videoBuffer = new Uint8Array(await videoResponse.arrayBuffer());

  const creatorId = String(clipNode.creator_user_id);
  const storagePath = `clips/${creatorId}/continuation_${clipNodeId}_${Date.now()}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(storagePath, videoBuffer, { contentType: "video/mp4" });

  if (uploadError) {
    throw new Error(`Failed to upload continuation video: ${uploadError.message}`);
  }

  console.log("[continuation] Video uploaded:", storagePath);
  return storagePath;
}
