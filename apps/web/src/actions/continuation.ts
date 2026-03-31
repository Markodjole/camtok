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
    return { error: result.error };
  }

  const { continuation, selectionData } = result;
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
    const uniqueLabels = [...new Set(allCandidateLabels)];

    if (uniqueLabels.length > 0) {
      try {
        const plausResult = await scoreRealWorldPlausibility(
          uniqueLabels,
          ctx.mainStory,
          ctx.characters,
          ctx.environment,
        );
        plausibilityScores = plausResult.scores;
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

    const candidates: SelectionCandidate[] = ctx.nextStepCandidates.map((c) => {
      const videoW = c.probabilityScore;
      const plausW = plausibilityScores[c.label]?.score ?? 0.5;
      const blended = (videoW * VIDEO_WEIGHT_FACTOR) + (plausW * PLAUSIBILITY_WEIGHT_FACTOR);
      return {
        id: c.candidateId,
        label: c.label,
        weight: blended,
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
          conflictTags: opt.category === "path_choice" ? ["path_direction"] : undefined,
          metadata: {
            source: "available_option",
            videoWeight: videoW,
            plausibilityWeight: plausW,
            plausibilityReasoning: plausibilityScores[opt.label]?.reasoning ?? "no data",
          },
        });
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
        console.log(`  ${c.label}: final=${c.weight.toFixed(3)} (video=${Number(meta.videoWeight ?? 0).toFixed(2)} × ${VIDEO_WEIGHT_FACTOR} + plausibility=${Number(meta.plausibilityWeight ?? 0).toFixed(2)} × ${PLAUSIBILITY_WEIGHT_FACTOR}) [${src}]`);
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
      clothing: [c.clothingTop, c.clothingBottom].filter(Boolean).join(", "),
      emotion: c.dominantEmotion,
      posture: c.posture,
    })),
    objects: ctx.objects.map((o) => ({
      id: o.objectId,
      label: o.label,
      category: o.category,
      state: o.state,
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
If 2 actions were selected, the scene must show BOTH happening (e.g. character does action 1, then action 2, or simultaneously).
You may embellish, add detail, and weave in predictions — but every selected action must visibly occur.

The weights include a "plausibilityReasoning" field explaining the real-world logic behind each choice.
You should reference this in scene_explanation so users understand the decision considered both video evidence and real-world logic.

Priority order:
1. ALL selected actions from fair selection (MANDATORY — these define what happens, ALL must appear)
2. What was visibly happening in the clip (observed facts)
3. What options are visibly available (from video analysis)
4. What the character has shown preference for (from evidence, not guessing)
5. User predictions that are compatible with the selected actions

CONTINUITY IS CRITICAL:
- Characters must keep the same appearance, clothing, and position
- Objects must maintain their state
- Environment must not change
- Economic consistency: a person in a $1000 car does not suddenly have luxury items

VIDEO PROMPT — CRITICAL RULES FOR KLING AI:
You MUST return "video_prompt" and "negative_prompt" fields.

The video_prompt is sent directly to Kling AI image-to-video model. Follow these rules strictly:

1. ONLY mention the target object/brand that the character interacts with. NEVER mention other brands or products in the prompt — the model gets confused and may show the wrong item.
   BAD: "boy stands in front of a Coca-Cola vending machine and picks up Diet Coke" (model sees "Coca-Cola" and "Diet Coke" and gets confused)
   GOOD: "boy reaches toward the vending machine, his hand grabs a Diet Coke can, he pulls it out and smiles"

2. Describe the PHYSICAL ACTION as a sequence of body movements:
   BAD: "picks up a can"
   GOOD: "extends his right hand, fingers wrap around the silver Diet Coke can, lifts it from the shelf"

3. Structure the prompt as: [character appearance] + [specific physical action sequence] + [camera angle] + [lighting/mood]
   Example: "A young boy with curly brown hair in a yellow shirt reaches toward a vending machine shelf. His hand grabs a red Coca-Cola can and pulls it toward his chest. He looks at it with wide excited eyes. Medium close-up shot, warm natural lighting."

4. Put the MOST IMPORTANT action verb at the beginning of a sentence, not buried in a clause.

5. negative_prompt must include all competing brands/products that should NOT appear in the action:
   If character picks Diet Coke, negative_prompt should include other brands: "Sprite can in hand, Coca-Cola can in hand, wrong product, multiple cans"

6. Enforce causal action consistency in ALL scenes:
   - If an action has prerequisites, show them first (cause -> effect order).
   - The selected object/action target must stay consistent through the sequence.
   - Do not switch target mid-sequence (no "press Sprite button, get Diet Coke" type mismatches).
   Example (vending): press Diet Coke button -> Diet Coke can dispenses -> pick up Diet Coke can.

Return JSON:
{
  continuation_summary: string,
  accepted_predictions: string[],
  rejected_predictions: string[],
  partially_matched: string[],
  media_prompt: string,
  scene_explanation: string,
  video_prompt: string,
  negative_prompt: string
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

  // Prepend character appearance anchors only (skip environment — it contains brand
  // names that confuse the model when the action targets a specific product).
  let prompt = videoPrompt;
  if (ctx?.continuityAnchors) {
    const anchors = ctx.continuityAnchors;
    const anchorPrefix = [
      ...anchors.characterAppearance.slice(0, 2),
      ...anchors.wardrobe.slice(0, 2),
      ...anchors.cameraStyle.slice(0, 1),
    ].filter(Boolean).join(". ");
    if (anchorPrefix) {
      prompt = `${anchorPrefix}. ${prompt}`;
    }
  }

  console.log("[continuation] Generating video with Kling I2V");
  console.log("[continuation] Prompt:", prompt.slice(0, 200));

  const video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
    ...falLongJobOptions,
    input: {
      start_image_url: startImageUrl,
      prompt,
      negative_prompt: negativePrompt || "blurry, low quality, text overlay, watermark, distorted face",
      duration: "5",
      generate_audio: true,
    },
    logs: true,
    onQueueUpdate: (u: unknown) => {
      const status = (u as Record<string, unknown>)?.status ?? "unknown";
      console.log(`[continuation] video.queue: ${status}`);
    },
  });

  const videoUrl = (video as Record<string, unknown>).video
    ? ((video as Record<string, unknown>).video as Record<string, unknown>).url
    : null;

  if (!videoUrl || typeof videoUrl !== "string") {
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
