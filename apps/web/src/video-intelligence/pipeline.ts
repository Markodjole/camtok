/**
 * Video is the source of truth.
 * Prompt is not trusted.
 * We extract observed facts, inferred possibilities, and derived continuation context separately.
 * We never rely on stereotypes or sensitive attribute guesses.
 * Future continuation must be based on structured evidence from the clip and prior history.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { transcribeClipAudioFromVideoBytes } from "./audio-transcribe";
import { sampleFrames, transcodeToH264Mp4, safeContainerExt } from "./frame-sampler";
import { extractObservedFacts } from "./vision-extractor";
import { extractTemporalFeatures } from "./temporal-extractor";
import type {
  VideoAnalysis,
  ContinuationContext,
  ExtractionWarning,
  VideoAnalysisStatus,
} from "./types";
import { log } from "./utils";
import { getCharacterById } from "@/actions/characters";
import { characterToPromptContext } from "@/lib/characters/types";

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
    // Step 0: Get video bytes from storage + optional character profile
    const { data: clip } = await serviceClient
      .from("clip_nodes")
      .select("video_storage_path, character_id")
      .eq("id", clipNodeId)
      .single();

    if (!clip?.video_storage_path) {
      return fail("No video_storage_path on clip");
    }

    let characterProfile: string | null = null;
    if (clip.character_id) {
      try {
        const { character } = await getCharacterById(String(clip.character_id));
        if (character) {
          characterProfile = characterToPromptContext(character);
          log("pipeline", "character_loaded", { name: character.name });
        }
      } catch {
        log("pipeline", "character_load_failed", { characterId: clip.character_id });
      }
    }

    const { data: videoBlob } = await serviceClient.storage
      .from("media")
      .download(clip.video_storage_path as string);

    if (!videoBlob) return fail("Video not found in storage");
    const storagePath = clip.video_storage_path as string;
    const extFromPath = safeContainerExt(storagePath.split(".").pop() || "mp4");
    let workBytes = new Uint8Array(await videoBlob.arrayBuffer());
    let workExt = extFromPath;

    // Step 1: Sample frames (HEVC MOV / odd WebM → transcode to H.264 MP4 once, then retry)
    await setStatus("sampling_frames");
    let frames;
    try {
      frames = await sampleFrames(workBytes, workExt);
    } catch (e) {
      log("pipeline", "sample_transcode_retry", {
        analysisId,
        message: (e as Error)?.message?.slice(0, 200),
      });
      workBytes = new Uint8Array(await transcodeToH264Mp4(workBytes, workExt));
      workExt = "mp4";
      frames = await sampleFrames(workBytes, workExt);
    }
    log("pipeline", "frames_sampled", { analysisId, count: frames.length });

    // Step 2: Vision + audio ASR in parallel (speech affects temporal / betting context)
    await setStatus("extracting_vision");
    const [visionPack, audioAsr] = await Promise.all([
      extractObservedFacts(frames),
      transcribeClipAudioFromVideoBytes(workBytes, workExt),
    ]);
    const { observed, warnings: visionWarnings } = visionPack;
    log("pipeline", "vision_done", {
      analysisId,
      characters: observed.characters.length,
      objects: observed.objects.length,
      visibleTexts: observed.visibleTexts.length,
      asrChars: audioAsr.transcript?.length ?? 0,
    });

    // Step 3: Temporal extraction (actions, beats, intents, derived features)
    await setStatus("extracting_temporal");
    const temporal = await extractTemporalFeatures(
      observed,
      { transcript: audioAsr.transcript, language: audioAsr.language },
      characterProfile,
    );

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

    // Whisper transcript is ground truth for spoken dialogue — never let the
    // temporal LLM hallucinate a translation or fabricate speech in another language.
    const whisper = audioAsr.transcript?.trim() || null;
    if (whisper) {
      temporal.derived.spokenDialogue = whisper;
    }

    // Auto-populate empty continuity anchors from observed data so downstream
    // continuation always has something to anchor against.
    const anchors = temporal.derived.continuityAnchors;
    if (anchors.characterAppearance.length === 0) {
      anchors.characterAppearance = observed.characters.map((c) => {
        const parts: string[] = [c.label];
        if (c.ageGroup && c.ageGroup !== "unknown") parts.push(c.ageGroup.replace(/_/g, " "));
        if (c.hairDescription) parts.push(c.hairDescription);
        if (c.clothingTop) parts.push(c.clothingTop);
        if (c.clothingBottom) parts.push(c.clothingBottom);
        return parts.join(", ");
      });
    }
    if (anchors.wardrobe.length === 0) {
      anchors.wardrobe = observed.characters.flatMap((c) => {
        const items: string[] = [];
        if (c.clothingTop) items.push(c.clothingTop);
        if (c.clothingBottom) items.push(c.clothingBottom);
        if (c.accessories?.length) items.push(...c.accessories);
        return items;
      });
    }
    if (anchors.environment.length === 0) {
      const env = observed.environment;
      anchors.environment = [
        env.locationType,
        env.indoorOutdoor,
        env.lighting,
        ...(env.settingTags ?? []),
      ].filter((v): v is string => !!v && v !== "unknown");
    }
    if (anchors.objectStates.length === 0) {
      anchors.objectStates = observed.objects
        .filter((o) => o.state)
        .map((o) => `${o.label}: ${o.state}`);
    }
    if (anchors.cameraStyle.length === 0 && observed.camera) {
      anchors.cameraStyle = [
        observed.camera.shotType,
        observed.camera.cameraAngle,
        observed.camera.cameraMotion,
      ].filter((v): v is string => !!v && v !== "unknown");
    }

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

    const fromTemporal = temporal.derived.spokenDialogue?.trim() || null;
    const transcriptToStore = whisper
      ? whisper.slice(0, 500)
      : fromTemporal
        ? fromTemporal.slice(0, 500)
        : null;
    if (transcriptToStore) {
      await serviceClient
        .from("clip_nodes")
        .update({ transcript: transcriptToStore })
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
