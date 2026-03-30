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
      published_at: new Date().toISOString(),
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

  await supabase
    .from("clip_nodes")
    .update({ status: "continuation_ready" })
    .eq("id", clipNodeId);

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

  // Step 2: Fair selection of next-step candidates
  let selection: MultiSelectionResult | null = null;
  let seed = "";

  if (ctx && ctx.nextStepCandidates.length > 0) {
    seed = `${clipNodeId}:job:${jobId}:ts:${Date.now()}`;

    const candidates: SelectionCandidate[] = ctx.nextStepCandidates.map((c) => ({
      id: c.candidateId,
      label: c.label,
      weight: c.probabilityScore,
      metadata: { rationale: c.rationale, basedOn: c.basedOn },
    }));

    // Also add available options as lower-weight action candidates
    for (const opt of ctx.availableOptions) {
      if (!candidates.some((c) => c.label.toLowerCase().includes(opt.label.toLowerCase()))) {
        candidates.push({
          id: opt.optionId,
          label: opt.label,
          weight: (opt.confidence ?? 0.3) * 0.5,
          conflictTags: opt.category === "path_choice" ? ["path_direction"] : undefined,
        });
      }
    }

    try {
      selection = selectMultiple(candidates, {
        seed,
        maxSelections: 2,
        respectConflicts: true,
        minWeight: 0.05,
      });

      console.log("[continuation] Fair selection completed:");
      for (const s of selection.selected) {
        const singleResult = selectOne(candidates, { seed: `${seed}:verify:${s.id}` });
        console.log(buildVerificationSummary(singleResult, candidates));
      }
      console.log("[continuation] Selected:", selection.selected.map((s) => s.label));
      if (selection.excludedByConflict.length > 0) {
        console.log("[continuation] Excluded by conflict:", selection.excludedByConflict.map((e) => e.label));
      }
    } catch (err) {
      console.error("[continuation] Fair selection failed:", (err as Error)?.message);
    }
  }

  // Step 3: LLM generates the continuation narrative + video prompt
  const continuation = await generateContinuationNarrative(
    ctx,
    selection,
    String(clipNode.scene_summary ?? ""),
    predictions,
    isLlmAvailable,
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

  const selectedActions = selection?.selected.map((s) => ({
    action: s.label,
    weight: s.weight,
    rationale: (s.metadata as Record<string, unknown>)?.rationale ?? "",
  })) ?? [];

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
The "selected_next_actions" were chosen by a provably fair algorithm (SHA-256 weighted selection).
You MUST incorporate these selected actions into the continuation. They are the foundation of what happens next.
You may embellish, add detail, and weave in predictions — but the core action must match what was selected.

Priority order:
1. Selected actions from fair selection (MANDATORY — these define what happens)
2. What was visibly happening in the clip (observed facts)
3. What options are visibly available (from video analysis)
4. What the character has shown preference for (from evidence, not guessing)
5. User predictions that are compatible with the selected actions

CONTINUITY IS CRITICAL:
- Characters must keep the same appearance, clothing, and position
- Objects must maintain their state
- Environment must not change
- Economic consistency: a person in a $1000 car does not suddenly have luxury items

VIDEO PROMPT:
In addition to the standard fields, you MUST also return:
- "video_prompt": a detailed Kling AI video generation prompt describing exactly what should happen visually in the next 5-6 second clip. Include character appearance, action, environment, camera angle. Be specific and cinematic.
- "negative_prompt": what to avoid in the video (e.g. "blurry, low quality, text overlay, watermark")

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

  // Build the multi-scene prompt if we have continuity anchors
  let prompt = videoPrompt;
  if (ctx?.continuityAnchors) {
    const anchors = ctx.continuityAnchors;
    const anchorPrefix = [
      ...anchors.characterAppearance.slice(0, 2),
      ...anchors.wardrobe.slice(0, 2),
      ...anchors.environment.slice(0, 2),
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
