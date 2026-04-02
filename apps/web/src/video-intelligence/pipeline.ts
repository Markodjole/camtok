/**
 * Video is the source of truth.
 * Prompt is not trusted.
 * We extract observed facts, inferred possibilities, and derived continuation context separately.
 * We never rely on stereotypes or sensitive attribute guesses.
 * Future continuation must be based on structured evidence from the clip and prior history.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { sampleFrames } from "./frame-sampler";
import { extractObservedFacts } from "./vision-extractor";
import { extractTemporalFeatures } from "./temporal-extractor";
import type {
  VideoAnalysis,
  ContinuationContext,
  ExtractionWarning,
  VideoAnalysisStatus,
} from "./types";
import { log } from "./utils";

// ─── Pipeline entry: analyze a clip ─────────────────────────────────────────

export async function analyzeClipVideo(clipNodeId: string): Promise<{
  analysisId: string;
  error?: string;
}> {
  const serviceClient = await createServiceClient();

  const { data: existing } = await serviceClient
    .from("video_analyses")
    .select("id, status")
    .eq("clip_node_id", clipNodeId)
    .eq("version", 1)
    .maybeSingle();

  if (existing) {
    const status = String(existing.status);
    if (status === "stored") {
      log("pipeline", "already_analyzed", { clipNodeId, analysisId: existing.id });
      await logAnalysisDump(String(existing.id), clipNodeId);
      return { analysisId: String(existing.id) };
    }
    if (!["failed", "stored"].includes(status)) {
      log("pipeline", "already_running", { clipNodeId, status });
      return { analysisId: String(existing.id) };
    }
    await serviceClient.from("video_analyses").delete().eq("id", existing.id);
  }

  const { data: row, error: insertErr } = await serviceClient
    .from("video_analyses")
    .insert({ clip_node_id: clipNodeId, status: "queued", version: 1 })
    .select("id")
    .single();

  if (insertErr || !row) {
    return { analysisId: "", error: `Failed to create analysis job: ${insertErr?.message}` };
  }

  const analysisId = String(row.id);
  log("pipeline", "created", { clipNodeId, analysisId });

  // Fire & forget — don't await the long pipeline
  runPipeline(analysisId, clipNodeId).catch((err) => {
    log("pipeline", "uncaught_error", { analysisId, message: err?.message });
  });

  return { analysisId };
}

// ─── Pipeline runner ────────────────────────────────────────────────────────

async function runPipeline(analysisId: string, clipNodeId: string) {
  const serviceClient = await createServiceClient();
  const startedAt = Date.now();

  async function setStatus(status: VideoAnalysisStatus, extra?: Record<string, unknown>) {
    await serviceClient
      .from("video_analyses")
      .update({ status, started_at: new Date().toISOString(), ...extra })
      .eq("id", analysisId);
    log("pipeline", "status", { analysisId, status });
  }

  async function fail(message: string) {
    log("pipeline", "failed", { analysisId, message });
    await serviceClient
      .from("video_analyses")
      .update({ status: "failed", error_message: message, completed_at: new Date().toISOString() })
      .eq("id", analysisId);
  }

  try {
    // Step 0: Get video bytes from storage
    const { data: clip } = await serviceClient
      .from("clip_nodes")
      .select("video_storage_path")
      .eq("id", clipNodeId)
      .single();

    if (!clip?.video_storage_path) {
      return fail("No video_storage_path on clip");
    }

    const { data: videoBlob } = await serviceClient.storage
      .from("media")
      .download(clip.video_storage_path as string);

    if (!videoBlob) return fail("Video not found in storage");
    const videoBytes = new Uint8Array(await videoBlob.arrayBuffer());

    // Step 1: Sample frames
    await setStatus("sampling_frames");
    const frames = await sampleFrames(videoBytes);
    log("pipeline", "frames_sampled", { analysisId, count: frames.length });

    // Step 2: Vision extraction (per-frame → observed facts)
    await setStatus("extracting_vision");
    const { observed, warnings: visionWarnings } = await extractObservedFacts(frames);
    log("pipeline", "vision_done", {
      analysisId,
      characters: observed.characters.length,
      objects: observed.objects.length,
      visibleTexts: observed.visibleTexts.length,
    });

    // Step 3: Temporal extraction (actions, beats, intents, derived features)
    await setStatus("extracting_temporal");
    const temporal = await extractTemporalFeatures(observed);

    const mergedObserved = {
      ...observed,
      actions: temporal.actions.length > 0 ? temporal.actions : observed.actions,
      storyBeats: temporal.storyBeats,
      availableOptions: temporal.availableOptions.length > 0
        ? temporal.availableOptions : observed.availableOptions,
    };

    // Step 4: Combine + store
    await setStatus("deriving_features");

    const allWarnings: ExtractionWarning[] = [
      ...visionWarnings,
      ...temporal.warnings,
    ];

    const analysis: VideoAnalysis = {
      version: 1,
      clipNodeId,
      observed: mergedObserved,
      inferred: temporal.inferred,
      derived: temporal.derived,
      warnings: allWarnings,
      score: temporal.score,
      frameCount: frames.length,
      analysisModel: process.env.LLM_MODEL_ANALYSIS || process.env.LLM_MODEL || "gpt-4o-mini",
      analyzedAt: new Date().toISOString(),
    };

    // Update transcript on clip_nodes if we got spoken dialogue
    if (temporal.derived.spokenDialogue) {
      await serviceClient
        .from("clip_nodes")
        .update({ transcript: temporal.derived.spokenDialogue.slice(0, 500) })
        .eq("id", clipNodeId);
    }

    // Update scene_summary if we have a better main story
    if (temporal.inferred.mainStory) {
      await serviceClient
        .from("clip_nodes")
        .update({ scene_summary: temporal.inferred.mainStory.slice(0, 500) })
        .eq("id", clipNodeId);
    }

    await serviceClient
      .from("video_analyses")
      .update({
        status: "stored",
        observed: mergedObserved,
        inferred: temporal.inferred,
        derived: temporal.derived,
        warnings: allWarnings,
        score: temporal.score,
        frame_count: frames.length,
        analysis_model: process.env.LLM_MODEL_ANALYSIS || process.env.LLM_MODEL || "gpt-4o-mini",
        completed_at: new Date().toISOString(),
      })
      .eq("id", analysisId);

    await logAnalysisDump(analysisId, clipNodeId);

    log("pipeline", "completed", {
      analysisId,
      clipNodeId,
      totalMs: Date.now() - startedAt,
      scoreReady: temporal.score.continuationReadiness,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown pipeline error";
    await fail(message);
  }
}

async function logAnalysisDump(analysisId: string, clipNodeId: string) {
  const serviceClient = await createServiceClient();
  const { data } = await serviceClient
    .from("video_analyses")
    .select("id, clip_node_id, status, observed, inferred, derived, warnings, score, frame_count, analysis_model, completed_at")
    .eq("id", analysisId)
    .maybeSingle();
  if (!data) return;

  const continuationContext = await getContinuationContext(clipNodeId);

  console.log(
    `${new Date().toISOString()} [video-intelligence][db-dump] ${JSON.stringify(
      {
        analysis_row: data,
        continuation_context: continuationContext,
      },
      null,
      2,
    )}`,
  );
}

// ─── Query: get continuation context for a clip ─────────────────────────────

export async function getContinuationContext(
  clipNodeId: string,
): Promise<ContinuationContext | null> {
  const serviceClient = await createServiceClient();
  const { data } = await serviceClient
    .from("video_analyses")
    .select("observed, inferred, derived, score")
    .eq("clip_node_id", clipNodeId)
    .eq("status", "stored")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const observed = data.observed as VideoAnalysis["observed"];
  const inferred = data.inferred as VideoAnalysis["inferred"];
  const derived = data.derived as VideoAnalysis["derived"];
  const score = data.score as VideoAnalysis["score"];

  return {
    clipNodeId,
    mainStory: inferred.mainStory,
    currentStateSummary: inferred.currentStateSummary,
    characters: observed.characters,
    objects: observed.objects,
    environment: observed.environment,
    continuityAnchors: derived.continuityAnchors,
    availableOptions: observed.availableOptions,
    preferenceSignals: inferred.preferenceSignals,
    nextStepCandidates: derived.nextStepCandidates,
    unresolvedQuestions: inferred.unresolvedQuestions,
    spokenDialogue: derived.spokenDialogue,
    score,
  };
}

// ─── Query: get analysis status ─────────────────────────────────────────────

export async function getAnalysisStatus(clipNodeId: string): Promise<{
  status: string;
  analysisId: string | null;
  score: VideoAnalysis["score"] | null;
  error: string | null;
} | null> {
  const serviceClient = await createServiceClient();
  const { data } = await serviceClient
    .from("video_analyses")
    .select("id, status, score, error_message")
    .eq("clip_node_id", clipNodeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  return {
    status: String(data.status),
    analysisId: String(data.id),
    score: data.score as VideoAnalysis["score"] | null,
    error: (data.error_message as string) ?? null,
  };
}
