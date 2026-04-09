"use server";

import { revalidatePath } from "next/cache";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { falLongJobOptions, getFalClient } from "@/lib/fal/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";

function logLine(jobId: string, phase: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`${ts} [pattern-gen job=${jobId}] ${phase}${payload}`);
}

export async function downloadToUint8Array(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download asset: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function uploadBytesToMedia(storagePath: string, bytes: Uint8Array, contentType: string) {
  const serviceClient = await createServiceClient();
  const { error } = await serviceClient.storage.from("media").upload(storagePath, bytes, {
    upsert: true,
    contentType,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

export async function trimVideoAt(videoBytes: Uint8Array, cutSeconds: number): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "trim-"));
  const inPath = join(dir, "input.mp4");
  const outPath = join(dir, "output.mp4");
  await writeFile(inPath, videoBytes);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", inPath, "-t", String(cutSeconds), "-c", "copy", "-avoid_negative_ts", "1", outPath],
      { timeout: 30_000 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  const trimmed = await readFile(outPath);
  await unlink(inPath).catch(() => {});
  await unlink(outPath).catch(() => {});
  return new Uint8Array(trimmed);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BaseScene = {
  subject: string;
  subject_state: string;
  environment: string;
  camera: string;
  textures: string;
};

export type MultiScene = {
  prompt: string;
  duration: string;
};

export type EnhancedPlot = {
  scene_summary: string;
  scenes: MultiScene[];
  negative_prompt: string;
  outcomes: string[];
  /** Optional subtitle line; empty if no speech implied */
  spoken_dialogue: string;
  /** LLM-decided total clip duration: 6, 8, or 10 seconds */
  total_duration_seconds?: number;
};

// ---------------------------------------------------------------------------
// LLM: interpret user's short plot change → 3 structured multi-scene prompts
// ---------------------------------------------------------------------------

async function buildMultiScenePrompt(
  baseScene: BaseScene,
  userPlotChange: string,
  options?: { mood?: string; camera?: string },
): Promise<EnhancedPlot | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL_IMAGE_PATTERNS || process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: `You create 3-scene video prompts for Kling AI image-to-video. The video starts from a provided STILL image.

===== BASE IMAGE =====
- Subject: ${baseScene.subject}
- State: ${baseScene.subject_state}
- Environment: ${baseScene.environment}
- Camera: ${baseScene.camera}
- Textures: ${baseScene.textures}

===== YOUR #1 GOAL =====
Create ONE CONTINUOUS, NATURAL piece of motion that flows smoothly across all 3 scenes.
The 3 scenes are NOT 3 separate shots — they are 3 segments of ONE UNBROKEN TAKE.
Think of it as writing movement choreography for a single 6-second clip.

===== CRITICAL: HOW KLING AI WORKS =====
Kling generates video FROM the start image. It already sees the full scene.

NEVER re-describe the static scene. The image already shows it.
NEVER start with "The camera captures..." or "The scene shows..." — nothing is being "captured", movement is being GENERATED.

Each scene prompt should describe ONLY what CHANGES / MOVES during that 2-second window.
The subject, environment, and objects are already visible — just describe the MOTION.

===== MOVEMENT PRINCIPLES FOR NATURAL VIDEO =====

1. ONE CONTINUOUS FLOW — Each scene picks up EXACTLY where the previous one left off.
   If Scene 1 ends with the man walking toward the rack, Scene 2 starts with him arriving at it.
   NEVER "reset" the scene or re-establish the setting.

2. DESCRIBE PHYSICAL MOTION, NOT CAMERA NARRATION:
   BAD: "The camera captures the man assessing the barbell. The atmosphere is quiet."
   GOOD: "He walks toward the squat rack, eyes fixed on the barbell."
   BAD: "The camera shifts to focus on his determined expression."
   GOOD: "He grips the barbell, adjusts his stance, and takes a breath."

3. USE ACTION VERBS, NOT OBSERVATION VERBS:
   BAD: "appears", "is seen", "can be observed", "the camera reveals"
   GOOD: "walks", "grips", "lifts", "turns", "reaches", "steps", "leans"

4. BLEND ACTION WITH ENVIRONMENT — Each scene should combine physical motion with
   brief sensory/environmental detail so Kling maintains the setting consistently.
   BAD (pure filler): "The ambient light casts soft shadows, highlighting the contours of his physique and the equipment, creating a sense of anticipation."
   BAD (pure action): "He picks up the barbell."
   GOOD: "He grips the barbell firmly, the polished metal gleaming under the gym's overhead lights, and positions his feet shoulder-width on the rubber mat."
   Include 1-2 short environment anchors per scene (lighting, surfaces, objects nearby).

5. AIM FOR 40-60 WORDS PER SCENE — enough for Kling to understand both the motion
   AND the setting. Every scene should mention at least one environmental element.

===== DIALOGUE / VOICE =====
ABSOLUTELY FORBIDDEN unless user explicitly asks for speech.
No murmurs, "hmm", grunts, sighs, whispers, or ANY sound.

===== MOVEMENT FIDELITY =====
- Include ONLY movement that the user described or directly implied.
- Do NOT invent extra body movements (no hand hovering, gesturing, fidgeting).
- "deciding" / "contemplating" = gaze shifts only. Hands and body stay still.
- When in doubt: LESS movement, not more.

===== MOOD & CAMERA (if provided) =====
The user may specify a Mood and/or Camera style. If provided, use them:
- Mood affects PACING: "tense" = slower movements, held pauses. "energetic" = quicker actions. "calm" = gentle, unhurried. "playful" = lighter, bouncier movement. "dramatic" = deliberate, weighted.
- Camera options: "follow" = camera tracks the subject. "static" = camera locked, only subject moves. "closeup" = tight framing on hands/face. "pov" = first-person view. "orbit" = slow circular movement around subject.
- If not provided, choose what fits the action naturally.

===== SCENE STRUCTURE =====
You MUST decide the total duration: 6, 8, or 10 seconds. Return "total_duration_seconds" in JSON.
- Simple setup (1 action + cliffhanger): 6s → 3 scenes × 2s
- Medium setup (2 actions + cliffhanger): 8s → scene_1=3s, scene_2=3s, scene_3=2s
- Complex setup (3+ actions + cliffhanger): 10s → scene_1=3s, scene_2=4s, scene_3=3s
Set each scene's "duration" field accordingly.

- Scene 1: ESTABLISH & BEGIN. The action starts. Subject begins moving as user described. Keep it simple — one smooth motion.
- Scene 2: The action DEVELOPS. The main beat of the user's plot unfolds. Let movements breathe — do not rush.
- Scene 3: CLIFFHANGER. Movement slows to stillness. The subject holds position facing a clear choice/dilemma. The viewer MUST see what the options are. Camera may drift slowly. No resolution.
- This is Part 1 of a two-part video. NEVER show the outcome or resolution. The clip MUST end with a visible dilemma.

===== EXAMPLE =====
User plot: "man walks up to squat rack and prepares to squat"
BAD (robotic, re-describes scene each time):
  scene_1: "The camera captures the barbell resting on the squat rack, its metallic surface gleaming under soft ambient lighting. A slim man walks into frame."
  scene_2: "As the man approaches the squat rack, he pauses momentarily, assessing the barbell. The camera shifts to focus on his determined expression."
  scene_3: "The camera holds steady on the man as he stands before the squat rack. The barbell looms large in the frame."

GOOD (continuous motion, no re-description):
  scene_1: "He walks toward the squat rack with steady steps, eyes locked on the barbell."
  scene_2: "He grips the barbell with both hands, ducks under it, and positions it across his upper back. He plants his feet shoulder-width apart."
  scene_3: "He takes a deep breath, knees slightly bent, holding the loaded position. The camera slowly pushes in on his focused face."

===== NEGATIVE PROMPT =====
Include: "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking, murmuring, whispering"
Do NOT put items from the user's plot in the negative prompt.

===== OUTPUT FORMAT =====
Return JSON:
{
  "scene_summary": "one sentence describing the full clip",
  "mood": "the emotional tone",
  "feasibility_notes": "brief note on any adaptations you made and why",
  "enhanced_plot": "your cinematic version of the user's plot (1-2 sentences)",
  "total_duration_seconds": 6 | 8 | 10,
  "scene_1": "scene 1 prompt (40-60 words, action + environment grounding)",
  "scene_1_duration": "2" | "3",
  "scene_2": "scene 2 prompt (40-60 words, action + environmental detail)",
  "scene_2_duration": "2" | "3" | "4",
  "scene_3": "scene 3 prompt (40-60 words, cliffhanger + visible dilemma + camera)",
  "scene_3_duration": "2" | "3",
  "negative_prompt": "things to avoid (do NOT include objects the user requested)",
  "outcomes": ["outcome A", "outcome B", "outcome C"],
  "spoken_dialogue": "If the user's plot includes speech (quoted words, 'says', 'whispers', etc.), write the subtitle line (max 120 chars). Otherwise empty string."
}`,
      },
      {
        role: "user",
        content: [
          `Action: "${userPlotChange}"`,
          options?.mood ? `Mood: ${options.mood}` : null,
          options?.camera ? `Camera: ${options.camera}` : null,
        ].filter(Boolean).join("\n"),
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.feasibility_notes) {
      logLine("llm", "feasibility", { notes: parsed.feasibility_notes, enhanced_plot: parsed.enhanced_plot });
    }
    const hardNegative =
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking, murmuring, whispering";
    const spoken =
      typeof parsed.spoken_dialogue === "string" ? parsed.spoken_dialogue.trim().slice(0, 120) : "";
    return {
      scene_summary: parsed.scene_summary || userPlotChange,
      scenes: [
        { prompt: parsed.scene_1, duration: String(parsed.scene_1_duration || "2") },
        { prompt: parsed.scene_2, duration: String(parsed.scene_2_duration || "2") },
        { prompt: parsed.scene_3, duration: String(parsed.scene_3_duration || "2") },
      ],
      negative_prompt: `${parsed.negative_prompt || ""}, ${hardNegative}`.replace(/^,\s*/, ""),
      outcomes: parsed.outcomes || [],
      spoken_dialogue: spoken,
      total_duration_seconds: parsed.total_duration_seconds,
    };
  } catch {
    return null;
  }
}

function buildFallbackScenes(baseScene: BaseScene, userPlotChange: string): EnhancedPlot {
  return {
    scene_summary: `${baseScene.subject} — ${userPlotChange}`,
    spoken_dialogue: "",
    scenes: [
      {
        prompt: `${userPlotChange}. The action begins naturally.`,
        duration: "2",
      },
      {
        prompt: `Continuing smoothly. The moment develops.`,
        duration: "2",
      },
      {
        prompt: `Movement slows. Stillness. Camera drifts in slowly. No resolution.`,
        duration: "2",
      },
    ],
    negative_prompt:
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking",
    outcomes: [],
  };
}

// ---------------------------------------------------------------------------
// Post-generation: analyze video for resolution and find cut point
// ---------------------------------------------------------------------------

export async function analyzeVideoForResolution(
  videoUrl: string,
  sceneSummary: string,
  outcomes: string[],
): Promise<{ resolved: boolean; cutAtSecond: number | null; description: string }> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    return { resolved: false, cutAtSecond: null, description: "no LLM configured" };
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL_IMAGE_PATTERNS || process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a video analyst for a prediction/betting platform. Users bet on what happens next in short clips. If the video shows the OUTCOME, the bet is ruined.

The clip is about: "${sceneSummary}"
Possible outcomes viewers bet on: ${JSON.stringify(outcomes)}

Analyze the video and determine:
1. Does the video show any of these outcomes being RESOLVED (completed, decided, finished)?
2. If yes, at approximately what second does the resolution become visible?

A resolution means: ball goes in/misses the hole, person picks an item, object lands/stops, choice is made, action completes.
NOT a resolution: ball still rolling, hand still hovering, object still in motion, person still deciding.

Return JSON:
{
  "resolved": true/false,
  "resolution_description": "what outcome was shown",
  "cut_at_second": number or null (the last second BEFORE resolution becomes clear — return null if not resolved),
  "frame_by_frame": "brief description of what happens each second"
}`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this video for any resolved outcomes:" },
          { type: "image_url", image_url: { url: videoUrl } },
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return { resolved: false, cutAtSecond: null, description: "analysis failed" };

  try {
    const parsed = JSON.parse(raw);
    return {
      resolved: !!parsed.resolved,
      cutAtSecond: parsed.cut_at_second ?? null,
      description: parsed.frame_by_frame || parsed.resolution_description || "",
    };
  } catch {
    return { resolved: false, cutAtSecond: null, description: "parse failed" };
  }
}

// ---------------------------------------------------------------------------
// Fetch patterns
// ---------------------------------------------------------------------------

export async function getImagePatterns() {
  const serviceClient = await createServiceClient();
  const { data, error } = await serviceClient
    .from("image_patterns")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) return { error: error.message, patterns: [] };
  return { patterns: data || [] };
}

// ---------------------------------------------------------------------------
// Analyze a custom uploaded image via GPT-4o vision → BaseScene
// ---------------------------------------------------------------------------

export async function analyzeCustomImage(imageStoragePath: string): Promise<{ error?: string; baseScene?: BaseScene }> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    return { error: "LLM not configured" };
  }

  const serviceClient = await createServiceClient();
  const { data: imgBlob } = await serviceClient.storage.from("media").download(imageStoragePath);
  if (!imgBlob) return { error: "Image not found in storage" };

  const buffer = Buffer.from(await imgBlob.arrayBuffer());
  const base64 = buffer.toString("base64");
  const mimeType = imageStoragePath.endsWith(".png") ? "image/png" : "image/jpeg";
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  try {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL_IMAGE_ANALYSIS || process.env.LLM_MODEL_IMAGE_PATTERNS || process.env.LLM_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Analyze this image and extract a structured scene description for video generation. Return JSON:
{
  "subject": "detailed description of the main subject (who/what, appearance, position, facing direction)",
  "subject_state": "current state/action of the subject (calm, sleeping, moving, etc.)",
  "environment": "background, setting, lighting, time of day, weather",
  "camera": "camera angle, framing, lens type, composition",
  "textures": "notable textures, materials, visual details"
}
Be specific and visual. Describe exactly what you see — colors, positions, clothing, expressions, objects. This will be used to maintain consistency in video generation.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image:" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return { error: "No response from vision model" };
    const parsed = JSON.parse(raw) as BaseScene;
    return { baseScene: parsed };
  } catch (e: any) {
    return { error: e?.message || "Image analysis failed" };
  }
}

// ---------------------------------------------------------------------------
// Guard: check for in-flight jobs
// ---------------------------------------------------------------------------

async function checkAndClearStaleJobs(serviceClient: any, userId: string) {
  const { data: existing } = await serviceClient
    .from("clip_generation_jobs")
    .select("id, status, created_at")
    .eq("user_id", userId)
    .eq("generation_mode", "image_pattern")
    .in("status", ["queued", "generating_first_frame", "generating_end_frame", "generating_video"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (existing && existing.length > 0) {
    const job = existing[0] as any;
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (ageMs < 15 * 60 * 1000) {
      return { blocked: true };
    }
    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "failed",
        error_message: "Previous generation exceeded wait limit; start a new one.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Core generation logic (shared between pattern + custom image)
// ---------------------------------------------------------------------------

async function runGeneration(opts: {
  user: { id: string };
  serviceClient: any;
  fal: any;
  imageStoragePath: string;
  patternImageUrl: string;
  baseScene: BaseScene;
  plotChange: string;
  mood?: string;
  camera?: string;
  sourceLabel: string;
}) {
  const { user, serviceClient, fal, imageStoragePath, patternImageUrl, baseScene, plotChange, mood, camera, sourceLabel } = opts;

  const llmResult = await buildMultiScenePrompt(baseScene, plotChange, { mood, camera });
  const enhanced = llmResult || buildFallbackScenes(baseScene, plotChange);

  logLine("pre-job", "scene_plan", { source: sourceLabel, plotChange, summary: enhanced.scene_summary });

  const now = new Date().toISOString();
  const { data: job, error: jobErr } = await serviceClient
    .from("clip_generation_jobs")
    .insert({
      user_id: user.id,
      status: "generating_video",
      provider: "fal",
      image_model_key: "user_uploaded_pattern",
      video_model_key: "fal-ai/kling-video/v3/pro/image-to-video",
      generation_mode: "image_pattern",
      llm_generation_json: {
        ...enhanced,
        base_scene: baseScene,
        source: sourceLabel,
        image_storage_path: imageStoragePath,
      },
    })
    .select()
    .single();
  if (jobErr || !job) return { error: "Failed to create generation job" };

  const jobId = String((job as any).id);
  try {
    const startedAt = Date.now();

    logLine(jobId, "start", { userId: user.id, source: sourceLabel, mode: "multi_prompt" });
    logLine(jobId, "multi_prompt", {
      scene_1: enhanced.scenes[0].prompt,
      scene_2: enhanced.scenes[1].prompt,
      scene_3: enhanced.scenes[2].prompt,
      negative: enhanced.negative_prompt,
    });

    const video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
      ...falLongJobOptions,
      input: {
        start_image_url: patternImageUrl,
        multi_prompt: enhanced.scenes.map((s: MultiScene) => ({ prompt: s.prompt, duration: s.duration })),
        shot_type: "customize",
        negative_prompt: enhanced.negative_prompt,
        duration: String(Math.min(10, Math.max(5, enhanced.total_duration_seconds || 6))),
        generate_audio: true,
      },
      logs: true,
      onQueueUpdate: (u: any) => logLine(jobId, "video.queue", { status: u?.status ?? "unknown" }),
    });

    const videoUrl = (video as any)?.data?.video?.url as string | undefined;
    if (!videoUrl) throw new Error("Kling video missing url");
    logLine(jobId, "video.done", { requestId: (video as any)?.requestId ?? null, ms: Date.now() - startedAt });

    let videoBytes = await downloadToUint8Array(videoUrl);

    try {
      logLine(jobId, "resolution_check.start");
      const analysis = await analyzeVideoForResolution(videoUrl, enhanced.scene_summary, enhanced.outcomes);
      logLine(jobId, "resolution_check.done", {
        resolved: analysis.resolved,
        cutAt: analysis.cutAtSecond,
        desc: analysis.description.slice(0, 120),
      });
      if (analysis.resolved && analysis.cutAtSecond && analysis.cutAtSecond >= 2) {
        logLine(jobId, "resolution_trim", { cutAtSecond: analysis.cutAtSecond });
        videoBytes = await trimVideoAt(videoBytes, analysis.cutAtSecond) as Uint8Array<ArrayBuffer>;
        logLine(jobId, "resolution_trim.done");
      }
    } catch (analysisErr: any) {
      logLine(jobId, "resolution_check.failed", { message: analysisErr?.message });
    }

    const videoPath = `clips/${user.id}/${jobId}.mp4`;
    await uploadBytesToMedia(videoPath, videoBytes, "video/mp4");

    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "review",
        video_request_id: (video as any)?.requestId ?? null,
        video_storage_path: videoPath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", (job as any).id);

    await serviceClient.from("notifications").insert({
      user_id: user.id,
      type: "video_review_ready",
      title: "Video ready for review",
      body: "Your generated video is ready. Tap to review, improve, or post.",
      link: "/create",
      read: false,
    });

    logLine(jobId, "ready_for_review", { totalMs: Date.now() - startedAt, videoPath });
    return {
      data: {
        jobId,
        videoStoragePath: videoPath,
        imageStoragePath,
        sceneSummary: enhanced.scene_summary,
        llmGeneration: { ...enhanced, base_scene: baseScene },
      },
    };
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

// ---------------------------------------------------------------------------
// Main generation action: from pre-defined pattern
// ---------------------------------------------------------------------------

export async function generateFromImagePattern(input: {
  patternId: string;
  plotChange: string;
  mood?: string;
  camera?: string;
}) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();
  const guard = await checkAndClearStaleJobs(serviceClient, user.id);
  if (guard.blocked) return { error: "A generation is already running. Please wait." };

  const { data: pattern, error: patErr } = await serviceClient
    .from("image_patterns")
    .select("*")
    .eq("id", input.patternId)
    .single();
  if (patErr || !pattern) return { error: "Pattern not found" };

  const baseScene = (pattern as any).base_scene as BaseScene;
  const imageStoragePath = (pattern as any).image_storage_path as string;

  const { data: imgBytes } = await serviceClient.storage.from("media").download(imageStoragePath);
  if (!imgBytes) return { error: "Pattern image not found in storage" };

  const fal = getFalClient();
  const imgBuffer = new Uint8Array(await imgBytes.arrayBuffer());
  const falFile = new File([imgBuffer], "pattern.png", { type: "image/png" });
  const patternImageUrl = await fal.storage.upload(falFile);
  if (!patternImageUrl) return { error: "Failed to upload pattern image to fal.ai" };
  logLine("pre-job", "pattern_image_uploaded", { url: patternImageUrl });

  return runGeneration({
    user,
    serviceClient,
    fal,
    imageStoragePath,
    patternImageUrl,
    baseScene,
    plotChange: input.plotChange,
    mood: input.mood,
    camera: input.camera,
    sourceLabel: `pattern:${(pattern as any).slug}`,
  });
}

// ---------------------------------------------------------------------------
// Main generation action: from user-uploaded custom image
// ---------------------------------------------------------------------------

export async function generateFromCustomImage(input: {
  imageStoragePath: string;
  plotChange: string;
  mood?: string;
  camera?: string;
}) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();
  const guard = await checkAndClearStaleJobs(serviceClient, user.id);
  if (guard.blocked) return { error: "A generation is already running. Please wait." };

  // Analyze the uploaded image to get base_scene
  const analysis = await analyzeCustomImage(input.imageStoragePath);
  if (analysis.error || !analysis.baseScene) return { error: analysis.error || "Image analysis failed" };

  logLine("pre-job", "custom_image_analyzed", { baseScene: analysis.baseScene });

  // Upload to fal.ai storage
  const { data: imgBytes } = await serviceClient.storage.from("media").download(input.imageStoragePath);
  if (!imgBytes) return { error: "Image not found in storage" };

  const fal = getFalClient();
  const imgBuffer = new Uint8Array(await imgBytes.arrayBuffer());
  const ext = input.imageStoragePath.split(".").pop() || "png";
  const falFile = new File([imgBuffer], `custom.${ext}`, { type: ext === "png" ? "image/png" : "image/jpeg" });
  const customImageUrl = await fal.storage.upload(falFile);
  if (!customImageUrl) return { error: "Failed to upload image to fal.ai" };
  logLine("pre-job", "custom_image_uploaded", { url: customImageUrl });

  return runGeneration({
    user,
    serviceClient,
    fal,
    imageStoragePath: input.imageStoragePath,
    patternImageUrl: customImageUrl,
    baseScene: analysis.baseScene,
    plotChange: input.plotChange,
    mood: input.mood,
    camera: input.camera,
    sourceLabel: "custom_upload",
  });
}

// ---------------------------------------------------------------------------
// Publish a reviewed draft → go live
// ---------------------------------------------------------------------------

export async function publishDraft(input: {
  jobId: string;
  videoStoragePath: string;
  imageStoragePath: string;
  sceneSummary: string;
  llmGeneration: any;
}) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();
  const now = new Date().toISOString();

  const { data: story, error: storyErr } = await serviceClient
    .from("stories")
    .insert({ title: (input.sceneSummary || "Untitled").slice(0, 80), creator_user_id: user.id })
    .select()
    .single();
  if (storyErr || !story) return { error: "Failed to create story" };

  const llm = (input.llmGeneration || {}) as { spoken_dialogue?: string };
  const transcript =
    typeof llm.spoken_dialogue === "string" && llm.spoken_dialogue.trim()
      ? llm.spoken_dialogue.trim().slice(0, 500)
      : null;

  const { data: clipNode, error: clipErr } = await serviceClient
    .from("clip_nodes")
    .insert({
      story_id: (story as any).id,
      creator_user_id: user.id,
      source_type: "image_to_video",
      status: "betting_open",
      video_storage_path: input.videoStoragePath,
      poster_storage_path: input.imageStoragePath,
      first_frame_storage_path: input.imageStoragePath,
      llm_generation_json: input.llmGeneration,
      scene_summary: input.sceneSummary,
      transcript,
      published_at: now,
      betting_deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();
  if (clipErr || !clipNode) return { error: `Failed to create clip: ${(clipErr as any)?.message ?? ""}` };

  await serviceClient.from("stories").update({ root_clip_node_id: (clipNode as any).id }).eq("id", (story as any).id);
  await serviceClient
    .from("clip_generation_jobs")
    .update({ status: "completed", clip_node_id: (clipNode as any).id, updated_at: now })
    .eq("id", input.jobId);

  logLine(input.jobId, "published", { clipId: (clipNode as any).id });

  import("@/video-intelligence/pipeline")
    .then((m) => m.analyzeClipVideo(String((clipNode as any).id)))
    .catch(() => {});

  revalidatePath("/feed");
  return { data: { clipId: (clipNode as any).id } };
}

// ---------------------------------------------------------------------------
// Improve video via Kling O1 video-to-video/edit
// ---------------------------------------------------------------------------

export async function improveVideo(input: {
  jobId: string;
  videoStoragePath: string;
  feedback: string;
}) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();
  const fal = getFalClient();

  // Download current video from Supabase and upload to fal storage
  const { data: videoBlob } = await serviceClient.storage.from("media").download(input.videoStoragePath);
  if (!videoBlob) return { error: "Video not found in storage" };

  const videoBuffer = new Uint8Array(await videoBlob.arrayBuffer());
  const falVideoFile = new File([videoBuffer], "video.mp4", { type: "video/mp4" });
  const falVideoUrl = await fal.storage.upload(falVideoFile);
  if (!falVideoUrl) return { error: "Failed to upload video to fal.ai" };

  logLine(input.jobId, "improve.start", { feedback: input.feedback.slice(0, 120) });

  try {
    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "generating_video", updated_at: new Date().toISOString() })
      .eq("id", input.jobId);

    const result = await fal.subscribe("fal-ai/kling-video/o1/video-to-video/edit", {
      ...falLongJobOptions,
      input: {
        prompt: input.feedback,
        video_url: falVideoUrl,
        keep_audio: true,
      },
      logs: true,
      onQueueUpdate: (u: any) => logLine(input.jobId, "improve.queue", { status: u?.status ?? "unknown" }),
    });

    const newVideoUrl = (result as any)?.data?.video?.url as string | undefined;
    if (!newVideoUrl) throw new Error("Kling edit returned no video");

    const newVideoBytes = await downloadToUint8Array(newVideoUrl);
    const newVideoPath = `clips/${user.id}/${input.jobId}_v${Date.now()}.mp4`;
    await uploadBytesToMedia(newVideoPath, newVideoBytes, "video/mp4");

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "review", video_storage_path: newVideoPath, updated_at: new Date().toISOString() })
      .eq("id", input.jobId);

    logLine(input.jobId, "improve.done", { newPath: newVideoPath });
    return { data: { videoStoragePath: newVideoPath } };
  } catch (e: any) {
    const message = e?.message || "Improvement failed";
    logLine(input.jobId, "improve.failed", { message });
    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "review", updated_at: new Date().toISOString() })
      .eq("id", input.jobId);
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// Restore latest draft in review mode (in case user navigated away)
// ---------------------------------------------------------------------------

export async function dismissDraft(jobId: string) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();
  await serviceClient
    .from("clip_generation_jobs")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", user.id);

  return { ok: true };
}

export async function deleteDraft(jobId: string, videoStoragePath: string) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();

  if (videoStoragePath) {
    await serviceClient.storage.from("media").remove([videoStoragePath]);
  }

  await serviceClient
    .from("clip_generation_jobs")
    .update({ status: "deleted", video_storage_path: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", user.id);

  return { ok: true };
}

export async function getPendingReviewDraft() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: null };

  const serviceClient = await createServiceClient();
  const { data, error } = await serviceClient
    .from("clip_generation_jobs")
    .select("id, status, video_storage_path, llm_generation_json, updated_at, generation_mode")
    .eq("user_id", user.id)
    .in("generation_mode", ["image_pattern", "character"])
    .eq("status", "review")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.video_storage_path) return { data: null };

  const llm = (data.llm_generation_json as Record<string, unknown> | null) ?? {};
  const reviewCharacterId =
    typeof llm.character_id === "string" && llm.character_id ? llm.character_id : null;
  return {
    data: {
      reviewJobId: String(data.id),
      reviewVideoPath: data.video_storage_path as string,
      reviewImagePath: (llm.image_storage_path as string | undefined) ?? null,
      reviewSummary: (llm.scene_summary as string | undefined) ?? null,
      reviewLlmGen: data.llm_generation_json,
      reviewCharacterId,
    },
  };
}
