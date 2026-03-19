"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { generateAndValidate } from "@bettok/story-engine";
import { getFalClient } from "@/lib/fal/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";

type BlueprintRow = {
  id: string;
  slug: string;
  label: string;
  category: string;
  description: string | null;
  config_json: Record<string, unknown>;
};

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
): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a video scene analyst for a prediction-betting platform. " +
          "Describe what is happening in these two frames (start frame and end frame) of a short clip. " +
          "Focus on: subjects visible, their positions, what choices/options are present, " +
          "the state of tension/action, and what outcome is still unresolved. " +
          "Keep it factual, 2-4 sentences. This analysis will be used to calculate betting odds.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Scene context: ${sceneSummary}\n\nDescribe what you see in these two frames:` },
          { type: "image_url", image_url: { url: firstFrameUrl, detail: "low" } },
          { type: "image_url", image_url: { url: endFrameUrl, detail: "low" } },
        ],
      },
    ],
    max_tokens: 200,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? null;
  console.log(
    `[vision] tokens=${response.usage?.total_tokens ?? 0} analysis="${text?.slice(0, 80)}..."`,
  );
  return text;
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

function buildBlueprintFraming(blueprintSlug: string) {
  if (blueprintSlug === "left_right_choice") {
    return "two choices visible (left and right) with clear tension; subject moves toward one side but no final selection";
  }
  if (blueprintSlug === "object_approaching_target") {
    return "object approaches a target but stops short; tension grows before contact";
  }
  if (blueprintSlug === "reach_without_resolution") {
    return "subject reaches toward an object but does not touch; stop before contact";
  }
  if (blueprintSlug === "balance_before_fall") {
    return "object wobbles near an edge; hesitation builds; cut before fall";
  }
  if (blueprintSlug === "suspense_reveal_setup") {
    return "door/container about to open; stop before reveal; tension holds";
  }
  return "simple scene with a single main action and an unresolved tension point";
}

function buildSceneImagePrompts(input: {
  baseStyle: string;
  subject: string;
  blueprintSlug: string;
}) {
  const { baseStyle, subject } = input;
  const common = `vertical 9:16 ${baseStyle}, shallow depth of field, cinematic lighting, no text, no captions`;

  if (input.blueprintSlug === "left_right_choice") {
    return {
      firstFrame: `${common}. ${subject}. Two clear options visible: one on the LEFT side and one on the RIGHT side. Subject is centered, looking at both options, body language shows indecision. Tension building, no choice made yet. Wide enough framing to show both options clearly.`,
      endFrame: `${common}. ${subject}. Same scene, same two options on left and right. Subject is now leaning or reaching toward one option but has NOT made contact or committed. Hand/body frozen in the moment right before choosing. Maximum suspense, decision imminent but not made.`,
    };
  }

  if (input.blueprintSlug === "object_approaching_target") {
    return {
      firstFrame: `${common}. ${subject}. Object is visible at a distance from the target. Clear trajectory implied. Tension starting to build, outcome uncertain.`,
      endFrame: `${common}. ${subject}. Object is very close to the target but has NOT made contact. Frozen at the moment right before impact/contact. Maximum suspense.`,
    };
  }

  if (input.blueprintSlug === "reach_without_resolution") {
    return {
      firstFrame: `${common}. ${subject}. Subject visible with hand/arm at rest, target object in view but out of reach. Anticipation building.`,
      endFrame: `${common}. ${subject}. Subject reaching toward the object, fingertips almost touching but NOT making contact. Frozen at maximum tension before touch.`,
    };
  }

  if (input.blueprintSlug === "balance_before_fall") {
    return {
      firstFrame: `${common}. ${subject}. Object sitting near an edge, slightly tilted. Precarious position, could go either way.`,
      endFrame: `${common}. ${subject}. Object tilting further, almost falling off the edge but NOT fallen yet. Maximum wobble, frozen right before the tipping point.`,
    };
  }

  if (input.blueprintSlug === "suspense_reveal_setup") {
    return {
      firstFrame: `${common}. ${subject}. A door/container/box is closed. Subject approaching it. What's inside is unknown. Curiosity and suspense building.`,
      endFrame: `${common}. ${subject}. Hand on the handle/lid, about to open but NOT opened yet. Frozen at the moment right before the reveal.`,
    };
  }

  return {
    firstFrame: `${common}. ${subject}. Scene establishing shot with clear tension point. Action is about to begin, outcome uncertain.`,
    endFrame: `${common}. ${subject}. Tension at maximum, action frozen right before the decisive moment. Outcome still unknown.`,
  };
}

function expandPromptFallback(input: {
  blueprint: BlueprintRow;
  userPrompt: string;
  tone: string;
  genre: string;
  realismLevel: string;
}) {
  const subject = input.userPrompt?.trim() || "simple scene";
  const baseStyle = getStyleFusion({
    genre: input.genre,
    tone: input.tone,
    realismLevel: input.realismLevel,
  });
  const framing = buildBlueprintFraming(input.blueprint.slug);

  const suggested =
    (input.blueprint.config_json?.["suggested_outcomes"] as unknown as string[]) ?? [];
  const obviousOutcomes =
    suggested.length > 0
      ? suggested.map((s) => (input.blueprint.slug === "left_right_choice" ? `Subject ${s}` : s))
      : ["Outcome A", "Outcome B", "Outcome C"];

  const forbiddenOutcomes = [
    "outcome already resolved",
    "character disappears",
    "multiple unrelated actions",
    "text overlays or subtitles",
    "blurred anatomy",
  ];

  const negativePrompt = [
    "outcome resolved",
    "decision made",
    "result shown",
    "text overlays",
    "subtitles",
    "blurry",
    "distort",
    "low quality",
    "extra limbs",
    "watermark",
    "logo",
  ].join(", ");

  const { firstFrame, endFrame } = buildSceneImagePrompts({
    baseStyle,
    subject,
    blueprintSlug: input.blueprint.slug,
  });

  return {
    scene_summary: `${subject}. Blueprint: ${input.blueprint.label}.`,
    first_frame_prompt: firstFrame,
    end_frame_prompt: endFrame,
    video_prompt: `vertical 9:16 ${baseStyle}. ${subject}. ${framing}. One continuous shot, build tension and motion, then cut right before the decisive moment. Do not show the outcome.`,
    negative_prompt: negativePrompt,
    obvious_outcomes: obviousOutcomes.slice(0, 5),
    forbidden_outcomes: forbiddenOutcomes,
    explanation_for_odds_engine: `The clip implies: ${obviousOutcomes.slice(0, 3).join(" vs ")} based on visible tension and choices.`,
  };
}

const expandedPromptSchema = z.object({
  scene_summary: z.string(),
  first_frame_prompt: z.string(),
  end_frame_prompt: z.string(),
  video_prompt: z.string(),
  negative_prompt: z.string(),
  obvious_outcomes: z.array(z.string()).min(2).max(6),
  forbidden_outcomes: z.array(z.string()).min(1).max(12),
  explanation_for_odds_engine: z.string(),
});

type ExpandedPrompt = z.infer<typeof expandedPromptSchema>;

async function expandPromptWithLlm(input: {
  blueprint: BlueprintRow;
  userPrompt: string;
  tone: string;
  genre: string;
  realismLevel: string;
}) {
  const suggested =
    (input.blueprint.config_json?.["suggested_outcomes"] as unknown as string[]) ?? [];
  const suggestedList =
    suggested.length > 0 ? suggested.slice(0, 5).join(", ") : "Outcome A, Outcome B, Outcome C";

  const messages = [
    {
      role: "system",
      content:
        "You are a careful director and prompt engineer. Return JSON only using the requested schema. Keep scene simple and unresolved.",
    },
    {
      role: "user",
      content: JSON.stringify({
        blueprint: {
          slug: input.blueprint.slug,
          label: input.blueprint.label,
          description: input.blueprint.description,
          suggested_outcomes: suggestedList,
        },
        user_prompt: input.userPrompt,
        tone: input.tone,
        genre: input.genre,
        realism_level: input.realismLevel,
        style_fusion: getStyleFusion({
          genre: input.genre,
          tone: input.tone,
          realismLevel: input.realismLevel,
        }),
        required: [
          "scene_summary",
          "first_frame_prompt",
          "end_frame_prompt",
          "video_prompt",
          "negative_prompt",
          "obvious_outcomes",
          "forbidden_outcomes",
          "explanation_for_odds_engine",
        ],
      }),
    },
  ] as const;

  const { data } = await generateAndValidate(messages as any, expandedPromptSchema, "Prompt expansion");
  return data;
}

export async function getClipBlueprints(): Promise<{ blueprints: BlueprintRow[] }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { blueprints: [] };

  const serviceClient = await createServiceClient();
  const { data, error } = await serviceClient
    .from("clip_blueprints")
    .select("id, slug, label, category, description, config_json")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) return { blueprints: [] };
  return { blueprints: (data || []) as BlueprintRow[] };
}

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
  blueprintId: string;
  userPrompt: string;
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

  const { data: blueprint, error: bpError } = await serviceClient
    .from("clip_blueprints")
    .select("id, slug, label, category, description, config_json")
    .eq("id", input.blueprintId)
    .single();
  if (bpError || !blueprint) return { error: "Blueprint not found" };
  const blueprintRow = blueprint as BlueprintRow;

  let expanded: ExpandedPrompt;
  const useLlm = process.env.LLM_PROVIDER === "openai" && !!process.env.LLM_API_KEY;
  if (useLlm) {
    try {
      expanded = await expandPromptWithLlm({
        blueprint: blueprintRow,
        userPrompt: input.userPrompt,
        tone: input.tone,
        genre: input.genre,
        realismLevel: input.realismLevel,
      });
    } catch {
      expanded = expandPromptFallback({
        blueprint: blueprintRow,
        userPrompt: input.userPrompt,
        tone: input.tone,
        genre: input.genre,
        realismLevel: input.realismLevel,
      });
    }
  } else {
    expanded = expandPromptFallback({
      blueprint: blueprintRow,
      userPrompt: input.userPrompt,
      tone: input.tone,
      genre: input.genre,
      realismLevel: input.realismLevel,
    });
  }

  const now = new Date().toISOString();
  const { data: job, error: jobErr } = await serviceClient
    .from("clip_generation_jobs")
    .insert({
      user_id: user.id,
      blueprint_id: input.blueprintId,
      status: "generating_first_frame",
      provider: "fal",
      image_model_key: "fal-ai/flux/dev",
      video_model_key: "fal-ai/kling-video/v3/pro/image-to-video",
      llm_generation_json: expanded,
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
      blueprintId: input.blueprintId,
      imageModel: "fal-ai/flux/dev",
      videoModel: "fal-ai/kling-video/v3/pro/image-to-video",
    });
    logLine(jobId, "fal.prompts", {
      first_frame_prompt: expanded.first_frame_prompt,
      end_frame_prompt: expanded.end_frame_prompt,
      video_prompt: expanded.video_prompt,
      negative_prompt: expanded.negative_prompt,
    });

    const first = await fal.subscribe("fal-ai/flux/dev", {
      input: { prompt: expanded.first_frame_prompt, image_size: "portrait_16_9" },
      logs: true,
      onQueueUpdate: (u) => logLine(jobId, "first_frame.queue", { status: (u as any)?.status ?? "unknown" }),
    });
    const firstUrl = (first as any)?.data?.images?.[0]?.url as string | undefined;
    if (!firstUrl) throw new Error("Fal first frame missing url");
    logLine(jobId, "first_frame.done", { requestId: (first as any)?.requestId ?? null, ms: Date.now() - startedAt });

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "generating_end_frame", first_frame_request_id: (first as any)?.requestId ?? null })
      .eq("id", (job as any).id);

    const end = await fal.subscribe("fal-ai/flux/dev", {
      input: { prompt: expanded.end_frame_prompt, image_size: "portrait_16_9" },
      logs: true,
      onQueueUpdate: (u) => logLine(jobId, "end_frame.queue", { status: (u as any)?.status ?? "unknown" }),
    });
    const endUrl = (end as any)?.data?.images?.[0]?.url as string | undefined;
    if (!endUrl) throw new Error("Fal end frame missing url");
    logLine(jobId, "end_frame.done", { requestId: (end as any)?.requestId ?? null, ms: Date.now() - startedAt });

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "generating_video", end_frame_request_id: (end as any)?.requestId ?? null })
      .eq("id", (job as any).id);

    // Primary: start + end + single prompt (keeps the "cut right before tension" behavior).
    let video: any;
    try {
      video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
        input: {
          start_image_url: firstUrl,
          end_image_url: endUrl,
          prompt: expanded.video_prompt,
          negative_prompt: expanded.negative_prompt,
          duration: String(Math.max(5, Math.min(8, input.durationSeconds || 6))),
          generate_audio: false,
        },
        logs: true,
        onQueueUpdate: (u) => logLine(jobId, "video.queue", { status: (u as any)?.status ?? "unknown", mode: "single_prompt_with_end" }),
      });
    } catch (videoErr: any) {
      const message = String(videoErr?.message || "");
      logLine(jobId, "video.retry", { reason: message, mode: "single_prompt_start_only" });
      if (!message.toLowerCase().includes("unprocessable")) throw videoErr;
      video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
        input: {
          start_image_url: firstUrl,
          prompt: expanded.video_prompt,
          negative_prompt: expanded.negative_prompt,
          duration: "5",
          generate_audio: false,
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
        llm_generation_json: expanded,
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
      const analysisText = await analyzeClipFrames(
        firstUrl!,
        endUrl!,
        expanded.scene_summary,
      );
      if (analysisText) {
        await serviceClient
          .from("clip_nodes")
          .update({ video_analysis_text: analysisText })
          .eq("id", (clipNode as any).id);
        logLine(jobId, "vision_analysis.done", { length: analysisText.length });
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

