"use server";

import { revalidatePath } from "next/cache";

import { falLongJobOptions, getFalClient } from "@/lib/fal/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { planScene, scoreGeneratedFrame } from "./scene-planner";
import type { SceneState } from "./scene-planner";

function logLine(jobId: string, phase: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`${ts} [fal-gen job=${jobId}] ${phase}${payload}`);
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

async function downloadToUint8Array(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download asset: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function uploadBytesToMedia(storagePath: string, bytes: Uint8Array, contentType: string) {
  const serviceClient = await createServiceClient();
  const { error } = await serviceClient.storage.from("media").upload(storagePath, bytes, {
    upsert: true,
    contentType,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

async function analyzeClipFrames(
  firstFrameUrl: string,
  endFrameUrl: string,
  sceneSummary: string,
): Promise<{ analysis: string | null; spokenDialogue: string | null }> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    return { analysis: null, spokenDialogue: null };
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL_AI_CLIPS || process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You analyze two frames (start and end) of a short vertical video for a prediction app. " +
          "Return JSON with keys: " +
          '"scene_analysis" (string, 2-4 sentences): subjects, positions, options/tension, unresolved outcome — factual. ' +
          '"spoken_dialogue" (string or null): ONLY if a person clearly appears to be speaking (mouth open mid-speech, direct address) or the scene context strongly implies a spoken line you can infer in one short subtitle (max 120 chars). ' +
          "If no speech is suggested, use null. Do not invent dialogue that contradicts the scene.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Scene context: ${sceneSummary}\n\nAnalyze both frames and return JSON only.`,
          },
          { type: "image_url", image_url: { url: firstFrameUrl, detail: "low" } },
          { type: "image_url", image_url: { url: endFrameUrl, detail: "low" } },
        ],
      },
    ],
    max_tokens: 350,
  });

  const raw = response.choices[0]?.message?.content?.trim();
  console.log(
    `[vision] tokens=${response.usage?.total_tokens ?? 0} raw="${raw?.slice(0, 100)}..."`,
  );
  if (!raw) return { analysis: null, spokenDialogue: null };
  try {
    const parsed = JSON.parse(raw) as { scene_analysis?: string; spoken_dialogue?: string | null };
    const analysis =
      typeof parsed.scene_analysis === "string" ? parsed.scene_analysis.trim() : null;
    let spoken: string | null =
      typeof parsed.spoken_dialogue === "string" ? parsed.spoken_dialogue.trim() : null;
    if (spoken && (spoken.toLowerCase() === "none" || spoken.toLowerCase() === "null")) spoken = null;
    if (spoken && spoken.length > 500) spoken = spoken.slice(0, 500);
    return { analysis: analysis || null, spokenDialogue: spoken };
  } catch {
    return { analysis: raw, spokenDialogue: null };
  }
}

function getStyleFusion(input: { genre: string; tone: string; realismLevel: string }) {
  const genreMap: Record<string, string> = {
    action: "dynamic action framing, readable motion, strong silhouettes",
    comedy: "whimsical comedic timing, playful expressions, bright playful palette",
    drama: "cinematic drama, emotionally readable expressions, dramatic lighting",
    horror: "dark suspense lighting, eerie atmosphere, controlled shadows",
    romance: "soft romantic lighting, gentle motion, warm highlights",
    sci_fi: "futuristic environment details, controlled neon accents, clean composition",
    thriller: "tense thriller mood, high contrast, slow build tension",
    fantasy: "stylized cinematic look, magical ambiance but realistic motion",
    mystery: "mysterious environment, subtle clues, suspenseful framing",
    slice_of_life: "everyday realism with cinematic framing, natural movement",
    nature: "outdoor natural lighting, gentle wind motion, earthy colors",
    sports: "sports-like motion but simplified, readable athletic action, no collisions",
  };

  const toneMap: Record<string, string> = {
    serious: "serious, grounded performance, subtle facial emotion",
    humorous: "funny, playful energy, friendly exaggerated motion",
    dark: "dark, moody, dramatic contrast, suspenseful energy",
    lighthearted: "lighthearted, bright cheerful palette, gentle optimism",
    tense: "tense, suspenseful build, slight trembling / anticipation",
    wholesome: "wholesome, soft gentle action, warm and safe composition",
    chaotic: "chaotic energy, fast motion, but keep action readable and simple",
  };

  const realismMap: Record<string, string> = {
    low: "stylized look, simplified shapes, slightly exaggerated but clean",
    medium: "semi-realistic cinematic look, clear anatomy, smooth lighting",
    high: "photorealistic cinematic look, accurate lighting, natural textures",
  };

  const genre = genreMap[input.genre] ?? input.genre;
  const tone = toneMap[input.tone] ?? input.tone;
  const realism = realismMap[input.realismLevel] ?? input.realismLevel;
  return `${genre}, ${tone}, ${realism}`;
}

function strengthenPrompt(_prompt: string, scene: SceneState, phase: "setup" | "options_reveal"): string {
  const c = (s: string) => (s || "").trim().replace(/\.\s*$/, "");
  if (phase === "options_reveal") {
    return `edit only the specific object: ${c(scene.key_element_changed)}, ${c(scene.reaction_change)}, keep all people, background, lighting, camera exactly the same.`;
  }
  return [
    c(scene.characters),
    c(scene.scene),
    c(scene.key_element_normal),
    c(scene.camera),
    "ultra-realistic, cinematic lighting, sharp focus, natural colors, 9:16 vertical",
  ].join(", ") + ".";
}

type ExpandedPrompt = {
  scene_summary: string;
  first_frame_prompt: string;
  end_frame_prompt: string;
  video_prompt: string;
  negative_prompt: string;
  obvious_outcomes: string[];
  forbidden_outcomes: string[];
  explanation_for_odds_engine: string;
};

export async function getCurrentAiGenerationStatus(): Promise<{
  running: boolean;
  status: string | null;
  jobId: string | null;
  errorMessage: string | null;
}> {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { running: false, status: null, jobId: null, errorMessage: null };

  const inFlightStatuses = ["queued", "generating_first_frame", "generating_end_frame", "generating_video"];
  const { data: job } = await serviceClient
    .from("clip_generation_jobs")
    .select("id, status, error_message, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) return { running: false, status: null, jobId: null, errorMessage: null };
  const status = String((job as any).status ?? "");
  return {
    running: inFlightStatuses.includes(status),
    status: status || null,
    jobId: String((job as any).id),
    errorMessage: ((job as any).error_message as string | null) ?? null,
  };
}

export async function generateAiClipFromBlueprint(input: {
  blueprintId?: string;
  userPrompt: string;
  sceneSetupPrompt?: string;
  plotPrompt?: string;
  tone: string;
  genre: string;
  realismLevel: string;
  durationSeconds?: number;
}) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  if (!process.env.FAL_KEY) return { error: "Missing FAL_KEY on server" };

  const inFlightStatuses = ["queued", "generating_first_frame", "generating_end_frame", "generating_video"];
  const inFlightTtlMs = 5 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - inFlightTtlMs).toISOString();

  await serviceClient
    .from("clip_generation_jobs")
    .update({
      status: "failed",
      error_message: "Generation timed out. Marked stale automatically.",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .in("status", inFlightStatuses as unknown as string[])
    .lt("created_at", cutoffIso);

  const { data: inFlight } = await serviceClient
    .from("clip_generation_jobs")
    .select("id")
    .eq("user_id", user.id)
    .in("status", inFlightStatuses as unknown as string[])
    .gte("created_at", cutoffIso)
    .limit(1);
  if (inFlight && inFlight.length > 0) {
    return { error: "A generation job is already running for your account. Please wait a bit." };
  }

  const style = getStyleFusion({
    genre: input.genre,
    tone: input.tone,
    realismLevel: input.realismLevel,
  });
  const sceneSetupPrompt = (input.sceneSetupPrompt ?? input.userPrompt ?? "").trim();
  const plotPrompt = (input.plotPrompt ?? "").trim();
  if (!sceneSetupPrompt) return { error: "Missing scene setup prompt" };
  if (!plotPrompt) return { error: "Missing plot change prompt" };

  const plan = await planScene({
    sceneSetupPrompt,
    plotPrompt,
    style,
    durationSeconds: Math.max(5, Math.min(8, input.durationSeconds || 6)),
  });

  const expanded: ExpandedPrompt = {
    scene_summary: `${plan.sceneState.characters} — ${plan.sceneState.scene}`.slice(0, 120),
    first_frame_prompt: plan.firstFramePrompt,
    end_frame_prompt: plan.endFramePrompt,
    video_prompt: plan.videoPrompt,
    negative_prompt: plan.negativePrompt,
    obvious_outcomes: plan.sceneState.outcomes,
    forbidden_outcomes: plan.sceneState.forbidden.slice(0, 12),
    explanation_for_odds_engine: `Unresolved question: ${plan.sceneState.unresolved_question}. The clip implies: ${plan.sceneState.outcomes.slice(0, 3).join(" vs ")}.`,
  };

  logLine("pre-job", "scene_plan", {
    sceneSetupPrompt,
    plotPrompt,
    scene: plan.sceneState.scene,
    characters: plan.sceneState.characters,
    camera: plan.sceneState.camera,
    key_normal: plan.sceneState.key_element_normal,
    key_changed: plan.sceneState.key_element_changed,
    optionA: plan.sceneState.option_a,
    optionB: plan.sceneState.option_b,
  });

  const now = new Date().toISOString();
  const useKlingImages = true;
  const klingTextToImageModelKey = "fal-ai/kling-image/v3/text-to-image";
  const klingImageToImageModelKey = "fal-ai/kling-image/v3/image-to-image";
  const fluxTextToImageModelKey = "fal-ai/flux/dev";
  const fluxImageToImageModelKey = "fal-ai/flux/dev/image-to-image";
  const imageModelKey = useKlingImages ? klingTextToImageModelKey : fluxTextToImageModelKey;
  const { data: job, error: jobErr } = await serviceClient
    .from("clip_generation_jobs")
    .insert({
      user_id: user.id,
      blueprint_id: input.blueprintId || null,
      status: "generating_first_frame",
      provider: "fal",
      image_model_key: imageModelKey,
      video_model_key: "fal-ai/kling-video/v3/pro/image-to-video",
      llm_generation_json: { ...expanded, scene_state: plan.sceneState, action_timeline: plan.timeline },
    })
    .select()
    .single();
  if (jobErr || !job) return { error: "Failed to create generation job" };

  const jobId = String((job as any).id);
  try {
    const fal = getFalClient();
    const startedAt = Date.now();

    logLine(jobId, "start", {
      userId: user.id,
      imageModel: imageModelKey,
      videoModel: "fal-ai/kling-video/v3/pro/image-to-video",
    });
    logLine(jobId, "fal.prompts", {
      first_frame_prompt: expanded.first_frame_prompt,
      end_frame_prompt: expanded.end_frame_prompt,
      video_prompt: expanded.video_prompt,
      negative_prompt: expanded.negative_prompt,
    });

    const MAX_FRAME_ATTEMPTS = 2;

    // --- Generate first frame ---
    let firstUrl: string | undefined;
    let currentFirstPrompt = expanded.first_frame_prompt;
    for (let attempt = 0; attempt < MAX_FRAME_ATTEMPTS; attempt++) {
      logLine(jobId, `first_frame.attempt_${attempt}`, {
        prompt_len: currentFirstPrompt.length,
        model: useKlingImages ? klingTextToImageModelKey : fluxTextToImageModelKey,
      });

      try {
        if (useKlingImages) {
          const first = await fal.subscribe(klingTextToImageModelKey, {
            ...falLongJobOptions,
            input: {
              prompt: currentFirstPrompt,
              aspect_ratio: "9:16",
              resolution: "1K",
              output_format: "png",
              num_images: 1,
            },
            logs: true,
            onQueueUpdate: (u) => logLine(jobId, "first_frame.queue", { status: (u as any)?.status ?? "unknown" }),
          });
          const url = (first as any)?.data?.images?.[0]?.url as string | undefined;
          if (!url) throw new Error("Kling first frame missing url");
          logLine(jobId, "first_frame.done", { requestId: (first as any)?.requestId ?? null, ms: Date.now() - startedAt, attempt });

          if (attempt < MAX_FRAME_ATTEMPTS - 1) {
            const qa = await scoreGeneratedFrame(url, plan.sceneState, "setup");
            logLine(jobId, "first_frame.qa", { pass: qa.overall_pass, desc: qa.description?.slice(0, 80) });
            if (qa.overall_pass) { firstUrl = url; break; }
            currentFirstPrompt = strengthenPrompt(currentFirstPrompt, plan.sceneState, "setup");
            logLine(jobId, "first_frame.retry", { reason: "QA failed" });
          } else {
            firstUrl = url;
          }
        } else {
          // Flux fallback
          const first = await fal.subscribe(fluxTextToImageModelKey, {
            ...falLongJobOptions,
            input: { prompt: currentFirstPrompt, image_size: "portrait_16_9" },
            logs: true,
            onQueueUpdate: (u) => logLine(jobId, "first_frame.queue", { status: (u as any)?.status ?? "unknown" }),
          });
          const url = (first as any)?.data?.images?.[0]?.url as string | undefined;
          if (!url) throw new Error("Fal first frame missing url");
          logLine(jobId, "first_frame.done", { requestId: (first as any)?.requestId ?? null, ms: Date.now() - startedAt, attempt });
          if (attempt < MAX_FRAME_ATTEMPTS - 1) {
            const qa = await scoreGeneratedFrame(url, plan.sceneState, "setup");
            logLine(jobId, "first_frame.qa", { pass: qa.overall_pass, desc: qa.description?.slice(0, 80) });
            if (qa.overall_pass) { firstUrl = url; break; }
            currentFirstPrompt = strengthenPrompt(currentFirstPrompt, plan.sceneState, "setup");
            logLine(jobId, "first_frame.retry", { reason: "QA failed" });
          } else {
            firstUrl = url;
          }
        }
      } catch (e: any) {
        const message = e?.message ? String(e.message) : "Unknown error";
        logLine(jobId, "first_frame.fail", { attempt, message });
        if (attempt === MAX_FRAME_ATTEMPTS - 1) throw e;
        // Try next attempt
      }
    }
    if (!firstUrl) throw new Error("First frame generation failed after retries");

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "generating_end_frame" })
      .eq("id", (job as any).id);

    // --- Generate end frame ---
    // Kling image-to-image: reference image + short edit prompt.
    let endUrl: string | undefined;
    let currentEndPrompt = expanded.end_frame_prompt;
    for (let attempt = 0; attempt < MAX_FRAME_ATTEMPTS; attempt++) {
      logLine(jobId, `end_frame.attempt_${attempt}`, {
        prompt_len: currentEndPrompt.length,
        model: useKlingImages ? klingImageToImageModelKey : fluxImageToImageModelKey,
      });

      if (useKlingImages) {
        const end = await fal.subscribe(klingImageToImageModelKey, {
          input: {
            prompt: currentEndPrompt,
            image_url: firstUrl,
            aspect_ratio: "9:16",
            resolution: "1K",
            output_format: "png",
            num_images: 1,
          },
          logs: true,
          onQueueUpdate: (u) => logLine(jobId, "end_frame.queue", { status: (u as any)?.status ?? "unknown" }),
        });
        const url = (end as any)?.data?.images?.[0]?.url as string | undefined;
        if (!url) throw new Error("Kling end frame missing url");
        logLine(jobId, "end_frame.done", { requestId: (end as any)?.requestId ?? null, ms: Date.now() - startedAt, attempt });

        if (attempt < MAX_FRAME_ATTEMPTS - 1) {
          const qa = await scoreGeneratedFrame(url, plan.sceneState, "options_reveal");
          logLine(jobId, "end_frame.qa", { pass: qa.overall_pass, has_two_options: qa.has_two_options, desc: qa.description?.slice(0, 80) });
          if (qa.overall_pass) { endUrl = url; break; }
          currentEndPrompt = strengthenPrompt(currentEndPrompt, plan.sceneState, "options_reveal");
          logLine(jobId, "end_frame.retry", { reason: `QA failed: options=${qa.has_two_options}` });
        } else {
          endUrl = url;
        }
      } else {
        // Flux fallback
        const END_FRAME_STRENGTH = 0.6;
        const strength = attempt === 0 ? END_FRAME_STRENGTH : END_FRAME_STRENGTH + 0.15;
        const end = await fal.subscribe(fluxImageToImageModelKey, {
          ...falLongJobOptions,
          input: {
            prompt: currentEndPrompt,
            image_url: firstUrl,
            strength,
            num_inference_steps: 40,
          } as any,
          logs: true,
          onQueueUpdate: (u) => logLine(jobId, "end_frame.queue", { status: (u as any)?.status ?? "unknown" }),
        });
        const url = (end as any)?.data?.images?.[0]?.url as string | undefined;
        if (!url) throw new Error("Fal end frame missing url");
        if (attempt < MAX_FRAME_ATTEMPTS - 1) {
          const qa = await scoreGeneratedFrame(url, plan.sceneState, "options_reveal");
          logLine(jobId, "end_frame.qa", { pass: qa.overall_pass, has_two_options: qa.has_two_options, desc: qa.description?.slice(0, 80) });
          if (qa.overall_pass) { endUrl = url; break; }
          currentEndPrompt = strengthenPrompt(currentEndPrompt, plan.sceneState, "options_reveal");
          logLine(jobId, "end_frame.retry", { reason: `QA failed: options=${qa.has_two_options}` });
        } else {
          endUrl = url;
        }
      }
    }
    if (!endUrl) throw new Error("End frame generation failed after retries");

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "generating_video" })
      .eq("id", (job as any).id);

    // Primary: start + end + single prompt (keeps the "cut right before tension" behavior).
    let video: any;
    try {
      video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
        ...falLongJobOptions,
        input: {
          start_image_url: firstUrl,
          end_image_url: endUrl,
          prompt: expanded.video_prompt,
          negative_prompt: expanded.negative_prompt,
          duration: String(Math.max(5, Math.min(8, input.durationSeconds || 6))),
          generate_audio: true,
        },
        logs: true,
        onQueueUpdate: (u) => logLine(jobId, "video.queue", { status: (u as any)?.status ?? "unknown", mode: "single_prompt_with_end" }),
      });
    } catch (videoErr: any) {
      const message = String(videoErr?.message || "");
      logLine(jobId, "video.retry", { reason: message, mode: "single_prompt_start_only" });
      if (!message.toLowerCase().includes("unprocessable")) throw videoErr;
      video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
        ...falLongJobOptions,
        input: {
          start_image_url: firstUrl,
          prompt: expanded.video_prompt,
          negative_prompt: expanded.negative_prompt,
          duration: "5",
          generate_audio: true,
        },
        logs: true,
        onQueueUpdate: (u) => logLine(jobId, "video.queue", { status: (u as any)?.status ?? "unknown", mode: "single_prompt_start_only" }),
      });
    }

    const videoUrl = (video as any)?.data?.video?.url as string | undefined;
    if (!videoUrl) throw new Error("Fal video missing url");
    logLine(jobId, "video.done", { requestId: (video as any)?.requestId ?? null, ms: Date.now() - startedAt });

    const firstBytes = await downloadToUint8Array(firstUrl);
    const endBytes = await downloadToUint8Array(endUrl);
    const videoBytes = await downloadToUint8Array(videoUrl);

    const firstPath = `clips/${user.id}/${(job as any).id}_first.png`;
    const endPath = `clips/${user.id}/${(job as any).id}_end.png`;
    const videoPath = `clips/${user.id}/${(job as any).id}.mp4`;
    await uploadBytesToMedia(firstPath, firstBytes, "image/png");
    await uploadBytesToMedia(endPath, endBytes, "image/png");
    await uploadBytesToMedia(videoPath, videoBytes, "video/mp4");

    const { data: story, error: storyErr } = await serviceClient
      .from("stories")
      .insert({
        title: expanded.scene_summary.slice(0, 80),
        genre: input.genre || null,
        tone: input.tone || null,
        creator_user_id: user.id,
      })
      .select()
      .single();
    if (storyErr || !story) throw new Error("Failed to create story");

    const { data: clipNode, error: clipErr } = await serviceClient
      .from("clip_nodes")
      .insert({
        story_id: (story as any).id,
        creator_user_id: user.id,
        source_type: "image_to_video",
        status: "betting_open",
        video_storage_path: videoPath,
        poster_storage_path: firstPath,
        first_frame_storage_path: firstPath,
        end_frame_storage_path: endPath,
        blueprint_id: input.blueprintId,
        llm_generation_json: { ...expanded, scene_state: plan.sceneState, action_timeline: plan.timeline },
        scene_summary: expanded.scene_summary,
        genre: input.genre || null,
        tone: input.tone || null,
        realism_level: input.realismLevel || null,
        published_at: now,
        betting_deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    if (clipErr || !clipNode) throw new Error(`Failed to create clip: ${(clipErr as any)?.message ?? ""}`);

    await serviceClient
      .from("stories")
      .update({ root_clip_node_id: (clipNode as any).id })
      .eq("id", (story as any).id);

    // Vision analysis of generated frames (non-blocking — failures won't break generation)
    try {
      logLine(jobId, "vision_analysis.start");
      const { analysis, spokenDialogue } = await analyzeClipFrames(
        firstUrl!,
        endUrl!,
        expanded.scene_summary,
      );
      if (analysis || spokenDialogue) {
        await serviceClient
          .from("clip_nodes")
          .update({
            ...(analysis ? { video_analysis_text: analysis } : {}),
            ...(spokenDialogue ? { transcript: spokenDialogue } : {}),
          })
          .eq("id", (clipNode as any).id);
        logLine(jobId, "vision_analysis.done", {
          analysisLen: analysis?.length ?? 0,
          transcript: spokenDialogue ? spokenDialogue.slice(0, 60) : null,
        });
      }
    } catch (visionErr: any) {
      logLine(jobId, "vision_analysis.failed", { message: visionErr?.message });
    }

    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "completed",
        video_request_id: (video as any)?.requestId ?? null,
        first_frame_storage_path: firstPath,
        end_frame_storage_path: endPath,
        video_storage_path: videoPath,
        clip_node_id: (clipNode as any).id,
        updated_at: now,
      })
      .eq("id", (job as any).id);

    logLine(jobId, "completed", { totalMs: Date.now() - startedAt, clipId: (clipNode as any).id });

    import("@/video-intelligence/pipeline")
      .then((m) => m.analyzeClipVideo(String((clipNode as any).id)))
      .catch(() => {});

    revalidatePath("/feed");
    return { data: { clipId: (clipNode as any).id } };
  } catch (e: any) {
    const message = e?.message || "Generation failed";
    logLine(jobId, "failed", { message });
    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
      .eq("id", (job as any).id);
    return { error: message };
  }
}

