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

async function downloadToUint8Array(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download asset: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function uploadBytesToMedia(storagePath: string, bytes: Uint8Array, contentType: string) {
  const serviceClient = await createServiceClient();
  const { error } = await serviceClient.storage.from("media").upload(storagePath, bytes, {
    upsert: true,
    contentType,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

async function trimVideoAt(videoBytes: Uint8Array, cutSeconds: number): Promise<Uint8Array> {
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

type BaseScene = {
  subject: string;
  subject_state: string;
  environment: string;
  camera: string;
  textures: string;
};

type MultiScene = {
  prompt: string;
  duration: string;
};

type EnhancedPlot = {
  scene_summary: string;
  scenes: MultiScene[];
  negative_prompt: string;
  outcomes: string[];
  /** Optional subtitle line; empty if no speech implied */
  spoken_dialogue: string;
};

// ---------------------------------------------------------------------------
// LLM: interpret user's short plot change → 3 structured multi-scene prompts
// ---------------------------------------------------------------------------

async function buildMultiScenePrompt(
  baseScene: BaseScene,
  userPlotChange: string,
): Promise<EnhancedPlot | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
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
Translate the USER'S plot into video prompts with STRICT intent fidelity.
Do exactly what user asked, no extra behavior.

===== WHAT KLING AI CAN DO =====
Kling v3 Pro image-to-video is powerful. It CAN:
✅ Move subjects (walk, turn, gesture, look around, change expression)
✅ Shift camera angle significantly (POV shots, over-shoulder, wide to close-up, orbit)
✅ Show the subject interacting with objects already in the environment
✅ Show the subject moving to a different part of the same environment
✅ Reveal more of the environment as the camera moves (shelves, products, signs)
✅ Add environmental motion (people in background, lights, reflections)
✅ Change lighting, atmosphere, mood

It CANNOT:
❌ Teleport to a completely different location (indoor → outdoor)
❌ Show readable on-screen text or speech bubbles
❌ Reliably create objects that are wildly inconsistent with the environment

===== HOW TO HANDLE USER REQUESTS (STRICT) =====

1. RESPECT THE USER'S PLOT. If the user says "finds snacks" and the image is a supermarket aisle — snacks ARE in a supermarket. Don't strip them out. The environment IMPLIES their presence even if individual snack packages aren't pixel-visible in the start frame.

2. CAMERA DIRECTION: If the user specifies a camera angle ("from his view", "POV", "over the shoulder", "close-up on hands"), USE IT. Override the base image camera. Kling can change camera angle.

3. DIALOGUE / VOICE IS ABSOLUTELY FORBIDDEN unless user explicitly asks:
- ONLY include spoken_dialogue if the user explicitly includes speech (quoted words, "says", "asks", "whispers", etc.).
- If user did not explicitly request speech, spoken_dialogue MUST be empty string.
- NEVER write murmurs, "hmm", grunts, sighs, whispers, or ANY vocal sound into scene prompts.
- NEVER use verbs like "murmurs", "says", "whispers", "mutters" in scene prompts unless user requested speech.
- If you catch yourself writing dialogue/sound — DELETE IT.

4. OBJECTS IN CONTEXT: A supermarket has products, shelves, prices. A bar has drinks. A road has cars. Don't add things that are impossible for the setting, but DO include things the setting naturally contains. The start image is a STARTING POINT, not a prison.

5. MOVEMENT IS EXACT, NOT DECORATIVE:
- Include ONLY movement verbs that the user explicitly stated or directly implied.
- Do NOT invent body movements: no hand hovering, no reaching, no pointing, no waving, no head turns, no gestures, no fidgeting — unless the user explicitly described that action.
- "deciding" or "contemplating" does NOT mean hands move. It means the character LOOKS, maybe shifts gaze. Nothing more.
- If user says "looks at X" → eyes/gaze move. Hands stay still. Body stays still.
- If user says "reaches for X" → hand extends. But ONLY if user said "reaches".
- When in doubt: LESS movement, not more.

===== SCENE STRUCTURE =====
- Scene 1 (2s): Establish the moment. Can include the user's described action beginning. Camera sets up.
- Scene 2 (2s): The main beat of the user's plot. The action, the discovery, the choice being presented. This is the heart of what the user described.
- Scene 3 (2s): FREEZE FRAME ENERGY. The character is STILL — no hand movement, no reaching, no gesturing, no speaking, no sound. Only the CAMERA may move (slow push-in, hold, subtle drift). Describe ONLY what the camera sees, NOT what the character does. The viewer should feel tension from stillness.
- Each scene: 60 words max. Be specific and cinematic.

===== WHAT TO AVOID =====
- Don't RESOLVE the outcome (if choosing between items, don't show the choice being made)
- Don't add jerky/sudden unnatural motion
- Don't contradict the physical environment (outdoor elements in indoor scene)
- Don't add extra actions not requested by user (no hand hover, no reaching, no pointing, no gesturing)
- Don't add dialogue, murmurs, "hmm", grunts, or ANY vocal sounds unless user explicitly requested speech
- Don't describe the character's hands moving in Scene 3 — EVER

===== NEGATIVE PROMPT =====
Include: "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, grabbing option, picking item, talking, speaking, murmuring, whispering, hand reaching, hand grabbing"
Do NOT put items from the user's plot in the negative prompt. If the user asks for snacks, do NOT add "snacks" to negative prompt.

===== OUTPUT FORMAT =====
Return JSON:
{
  "scene_summary": "one sentence describing the full clip",
  "mood": "the emotional tone",
  "feasibility_notes": "brief note on any adaptations you made and why",
  "enhanced_plot": "your cinematic version of the user's plot (1-2 sentences)",
  "scene_1": "scene 1 prompt (60 words max)",
  "scene_2": "scene 2 prompt (60 words max)",
  "scene_3": "scene 3 prompt (60 words max)",
  "negative_prompt": "things to avoid (do NOT include objects the user requested)",
  "outcomes": ["outcome A", "outcome B", "outcome C"],
  "spoken_dialogue": "If the user's plot includes speech (quoted words, 'says', 'whispers', etc.), write the subtitle line (max 120 chars). Otherwise empty string."
}`,
      },
      {
        role: "user",
        content: `Plot change: "${userPlotChange}"`,
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
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking, murmuring, whispering, hand reaching, hand grabbing";
    const spoken =
      typeof parsed.spoken_dialogue === "string" ? parsed.spoken_dialogue.trim().slice(0, 120) : "";
    return {
      scene_summary: parsed.scene_summary || userPlotChange,
      scenes: [
        { prompt: parsed.scene_1, duration: "2" },
        { prompt: parsed.scene_2, duration: "2" },
        { prompt: parsed.scene_3, duration: "2" },
      ],
      negative_prompt: `${parsed.negative_prompt || ""}, ${hardNegative}`.replace(/^,\s*/, ""),
      outcomes: parsed.outcomes || [],
      spoken_dialogue: spoken,
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
        prompt: `${baseScene.subject}, ${baseScene.subject_state}, ${baseScene.environment}. Camera holds steady. No movement, no action.`,
        duration: "2",
      },
      {
        prompt: `Same scene. ${userPlotChange}. Camera slowly pushes in. Subjects stay in their positions.`,
        duration: "2",
      },
      {
        prompt: `Same scene continues. Nothing resolved yet. Subjects remain still, same positions, same framing. Uncertainty lingers.`,
        duration: "2",
      },
    ],
    negative_prompt:
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion",
    outcomes: [],
  };
}

// ---------------------------------------------------------------------------
// Post-generation: analyze video for resolution and find cut point
// ---------------------------------------------------------------------------

async function analyzeVideoForResolution(
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
    model: "gpt-4o-mini",
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
      model: "gpt-4o-mini",
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
  sourceLabel: string;
}) {
  const { user, serviceClient, fal, imageStoragePath, patternImageUrl, baseScene, plotChange, sourceLabel } = opts;

  const llmResult = await buildMultiScenePrompt(baseScene, plotChange);
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
        duration: "6",
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
    sourceLabel: `pattern:${(pattern as any).slug}`,
  });
}

// ---------------------------------------------------------------------------
// Main generation action: from user-uploaded custom image
// ---------------------------------------------------------------------------

export async function generateFromCustomImage(input: {
  imageStoragePath: string;
  plotChange: string;
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
    .select("id, status, video_storage_path, llm_generation_json, updated_at")
    .eq("user_id", user.id)
    .eq("generation_mode", "image_pattern")
    .eq("status", "review")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data || !data.video_storage_path) return { data: null };

  const llm = (data.llm_generation_json as Record<string, any> | null) ?? {};
  return {
    data: {
      reviewJobId: String(data.id),
      reviewVideoPath: data.video_storage_path as string,
      reviewImagePath: (llm.image_storage_path as string | undefined) ?? null,
      reviewSummary: (llm.scene_summary as string | undefined) ?? null,
      reviewLlmGen: data.llm_generation_json,
    },
  };
}
