"use server";

import { revalidatePath } from "next/cache";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getFalClient } from "@/lib/fal/server";
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
        content: `You create 3-scene video prompts for Kling AI image-to-video. The video starts from a provided image.

BASE IMAGE shows:
- Subject: ${baseScene.subject}
- State: ${baseScene.subject_state}
- Environment: ${baseScene.environment}
- Camera: ${baseScene.camera}
- Textures: ${baseScene.textures}

CAMERA CONSTRAINT — VERY IMPORTANT:
You can ONLY describe what the camera angle above can actually see. If the camera shows "lower body and hands only", you CANNOT write about eyes, face, facial expressions, or anything above the waist. If the camera shows "back of subject", you CANNOT describe the subject's face. ONLY describe visual changes that are VISIBLE from the stated camera angle.

The user provides a short "plot change" — something that happens to the subject. You must:
1. UNDERSTAND USER INTENT, not just their literal words. Fix grammar, spelling, illogical sequences. Figure out what the user actually WANTED to show, not what they literally typed.
   Example: "vw beetle breaks slowley and stops to the red light. then Turn on the hazard lights, and red light turns to yellow and then green" → the user wants: car waiting at red light, hazard lights blinking, tension about when the light will change. The light CHANGING is the resolution — don't show it.
2. Determine the EMOTIONAL TONE of the scenario (see below)
3. IDENTIFY THE RESOLUTION in the user's prompt. The resolution is the FINAL OUTCOME the viewer would bet on. NEVER show it. Examples:
   - "light turns green" → light changing IS the resolution → show only the red light with tension building
   - "ball goes in the hole" → ball entering IS the resolution → show only the ball rolling
   - "cat eats the food" → eating IS the resolution → show only the cat looking at food
4. Rewrite the user's prompt so that the RESOLUTION IS PUSHED TO THE VERY END — the video should be all buildup, with the decisive moment happening as late as possible

REWRITING THE USER'S PROMPT — CRITICAL:
Your job is to SLOW DOWN the action. Whatever the user describes, stretch it out cinematically:
- If user says "golfer hits ball toward hole" → the swing should happen late in scene 2, and the ball should STILL BE ROLLING at the end of scene 3 — far from the hole
- If user says "kid chooses a drink" → the hand should still be hovering at end of scene 3
- PUSH the outcome as far into the future as possible. Fill scenes with slow buildup: breathing, micro-adjustments, camera movements, atmosphere
- The decisive moment (ball reaching hole, finger touching button, object landing) must NOT happen within the 6 seconds

NO NEW VISUAL ELEMENTS — CRITICAL:
NEVER add objects, people, or elements that are NOT described in the BASE IMAGE above.
- If the image shows a car on an empty road, do NOT add pedestrians, cyclists, other cars, signs, or extra traffic lights
- Kling AI cannot reliably create new objects — they appear distorted, wrong, or nonsensical
- You may ONLY describe elements that already exist in the image + the specific change from the user's plot
- Environmental changes are OK (lighting shifts, shadows, weather), but new physical objects are NOT

NO INVENTED MOVEMENT — CRITICAL:
NEVER add physical movement (steps forward, leaning, reaching, walking, crawling) that the user did NOT describe.
- If the user says "deciding" or "looking" → that means EYES and EXPRESSION only, NOT body/position changes
- The subject's POSITION in the frame must stay the same unless the user explicitly says the subject moves
- "Deciding" = gaze shifts, blinks, ear twitches, subtle expression changes. NOT leaning, stepping, approaching
- Only OTHER objects/characters can enter the scene IF the user's plot describes them — the main subject stays put unless told otherwise

NO ACTION TOWARD OPTIONS — ABSOLUTE RULE:
For betting clips, options must be PRESENTED, not ACTED ON.
- Never generate: reaching, touching, grabbing, pressing, opening, picking up, sipping, biting, stepping toward an option
- Never generate "hand hovering over option" or "fingers about to touch"
- The subject may LOOK at options, react emotionally, or shift gaze between options
- The subject must remain physically neutral relative to options (no approach motion)

EMOTIONAL TONE — CRITICAL:
Match the mood to the actual scenario. NOT everything is dramatic or scary.
- Choosing a dress, picking food, casual decisions → PLAYFUL, lighthearted, fun, curious, amused
- Danger, cracks, falling, breaking → TENSE, suspenseful, fearful
- Sports, competition → FOCUSED, determined, concentrated
- Nature, animals → NATURAL, instinctive, alert
NEVER use fear/tension/anxiety words for lighthearted scenarios.

SCENE CONTINUITY — CRITICAL:
Kling AI processes each scene prompt semi-independently. To get smooth motion across scenes, follow these rules:

1. DESCRIBE MOTION, NOT POSITIONS. Each scene should describe what is MOVING and HOW, not frozen start/end states. Kling generates smooth motion within a scene but can "jump" between scenes if they describe different static poses.

2. OVERLAP AT BOUNDARIES. The END of one scene's motion and the START of the next should describe the SAME ongoing movement. Think of it like crossfade editing — the action at the boundary is shared.
   BAD: Scene 1 "golfer stands still" → Scene 2 "golfer shifts weight and draws back putter"  (jump: still → new motion)
   GOOD: Scene 1 "golfer breathes slowly, weight shifting slightly onto front foot" → Scene 2 "continuing the slow weight shift, hands tighten on the putter grip, drawing it back in one fluid motion"  (smooth: same motion continues)

3. NEVER START A SCENE WITH A NEW DISTINCT ACTION. Each scene must continue the motion already happening. Use "continuing", "still", "the same motion carries" to bridge.

4. DESCRIBE WHAT CHANGES, NOT WHAT EXISTS. Don't say "the ball is on the grass" — say "the ball catches a glint of light as the club shadow passes over it." Motion-first language keeps the video fluid.

RULES:
- Scene 1 (2s): Subtle living motion — breathing, micro-adjustments, environmental motion (wind, light shifts). The subject is in its calm state but ALIVE, not frozen. Describe gentle continuous movement.
- Scene 2 (2s): Continue scene 1 smoothly, REVEAL options clearly, build tension via gaze/environment/camera only. No approach toward any option.
- Scene 3 (2s): Continue scene 2 smoothly, hold uncertainty at peak. Options remain visible and unresolved. Still NO approach/reach/touch toward any option.
- Each scene: 60 words max. Focus on MOTION VERBS and CAMERA MOVEMENT. Avoid static descriptions.
- Use camera terms: slow push-in, gentle rack focus, camera drifts, follows, tracks
- Include 3 possible outcomes the viewer could bet on

NEGATIVE PROMPT MUST ALWAYS INCLUDE: "outcome revealed, result shown, action completed, decision finished, object reaching destination, sudden jump, jerky motion, reaching toward option, touching option, grabbing option, pressing button, opening item, picking item, hand hovering over option"

Return JSON:
{
  "scene_summary": "one sentence describing the full clip",
  "mood": "the emotional tone: playful / tense / focused / curious / etc.",
  "enhanced_plot": "your rewritten version that SLOWS DOWN the action (1-2 sentences)",
  "scene_1": "scene 1 prompt (subtle living motion, 60 words max)",
  "scene_2": "scene 2 prompt (action begins flowing from scene 1, 60 words max)",
  "scene_3": "scene 3 prompt (action continues unbroken from scene 2, unresolved, 60 words max)",
  "negative_prompt": "things to avoid — MUST include outcome/resolution + motion jump terms",
  "outcomes": ["outcome A", "outcome B", "outcome C"]
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
    const hardNegative =
      "outcome revealed, result shown, action completed, decision finished, object reaching destination, sudden jump, jerky motion, reaching toward option, touching option, grabbing option, pressing button, opening item, picking item, hand hovering over option";
    return {
      scene_summary: parsed.scene_summary || userPlotChange,
      scenes: [
        { prompt: parsed.scene_1, duration: "2" },
        { prompt: parsed.scene_2, duration: "2" },
        { prompt: parsed.scene_3, duration: "2" },
      ],
      negative_prompt: `${parsed.negative_prompt || ""}, ${hardNegative}`.replace(/^,\s*/, ""),
      outcomes: parsed.outcomes || [],
    };
  } catch {
    return null;
  }
}

function buildFallbackScenes(baseScene: BaseScene, userPlotChange: string): EnhancedPlot {
  return {
    scene_summary: `${baseScene.subject} — ${userPlotChange}`,
    scenes: [
      {
        prompt: `${baseScene.subject} breathing slowly, ${baseScene.subject_state}, gentle ambient motion in ${baseScene.environment}. Camera holds steady, subtle living details — light shifting, textures moving.`,
        duration: "2",
      },
      {
        prompt: `Continuing the gentle motion, ${userPlotChange} begins to unfold slowly. Camera drifts closer, the first signs of change emerge naturally from the calm. Action builds gradually.`,
        duration: "2",
      },
      {
        prompt: `The motion carries forward unbroken — action still in progress, far from any conclusion. Camera follows the movement. Everything still uncertain, nothing resolved.`,
        duration: "2",
      },
    ],
    negative_prompt:
      "outcome revealed, result shown, action completed, decision finished, object reaching destination, sudden jump, jerky motion, reaching toward option, touching option, grabbing option, pressing button, opening item, picking item, hand hovering over option",
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
    if (ageMs < 5 * 60 * 1000) {
      return { blocked: true };
    }
    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "failed", error_message: "Timed out", updated_at: new Date().toISOString() })
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
      llm_generation_json: { ...enhanced, base_scene: baseScene, source: sourceLabel },
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
