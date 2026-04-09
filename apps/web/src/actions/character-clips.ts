"use server";

import { revalidatePath } from "next/cache";
import { execFile } from "child_process";
import { writeFile, readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { falLongJobOptions, getFalClient } from "@/lib/fal/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { getCharacterById } from "./characters";
import {
  downloadToUint8Array,
  uploadBytesToMedia,
  trimVideoAt,
  analyzeVideoForResolution,
} from "./image-pattern-clips";
import type { BaseScene, MultiScene, EnhancedPlot } from "./image-pattern-clips";
import {
  characterToPromptContext,
  characterToKlingIdentity,
} from "@/lib/characters/types";
import type { Character, CharacterWithImages } from "@/lib/characters/types";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logLine(jobId: string, phase: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`${ts} [char-gen job=${jobId}] ${phase}${payload}`);
}

function isFalForbiddenError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | undefined;
  return e?.status === 403 || /forbidden/i.test(String(e?.message ?? ""));
}

/** Next.js Flight can serialize `undefined` as the literal string "$undefined". */
function sanitizeOptionalString(v: string | undefined): string | undefined {
  if (v == null || v === "" || v === "$undefined" || v === "undefined") return undefined;
  return v;
}

function isMediaMockMode(): boolean {
  return process.env.MEDIA_PROVIDER === "mock";
}

function formatFalError(err: unknown): string {
  const e = err as {
    status?: number;
    message?: string;
    body?: { detail?: string; error?: string; message?: string };
  };
  const detail =
    e?.body?.detail ||
    e?.body?.error ||
    e?.body?.message ||
    (typeof e?.body === "string" ? e.body : null);
  const parts = [e?.message, detail, e?.status ? `HTTP ${e.status}` : null].filter(Boolean);
  return parts.join(" — ") || "Fal request failed";
}

/** Visible H.264 MP4 for local dev when MEDIA_PROVIDER=mock (requires ffmpeg). */
async function createMockClipMp4(): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "mock-char-clip-"));
  const outPath = join(dir, "out.mp4");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          // Use an obvious test pattern so mock clips are clearly visible in review/feed.
          "testsrc2=s=720x1280:r=24:d=4",
          "-c:v",
          "libx264",
          "-t",
          "4",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          outPath,
        ],
        { timeout: 45_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const buf = await readFile(outPath);
    return new Uint8Array(buf);
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Guard: check for in-flight character generation jobs
// ---------------------------------------------------------------------------

async function checkAndClearStaleJobs(serviceClient: any, userId: string) {
  const { data: existing } = await serviceClient
    .from("clip_generation_jobs")
    .select("id, status, created_at")
    .eq("user_id", userId)
    .eq("generation_mode", "character")
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
// Pick the best reference image for the scene context
// ---------------------------------------------------------------------------

async function pickBestReferenceImage(
  images: CharacterWithImages["reference_images"],
  location: string,
  plot: string,
): Promise<CharacterWithImages["reference_images"][number]> {
  const primary = images.find((i) => i.is_primary) ?? images[0];
  if (images.length <= 1) return primary;

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return primary;

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const catalog = images.map((img, i) => ({
      index: i,
      angle: img.angle,
      description: img.description || img.angle,
    }));

    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Pick the best character reference image for a video. The image is ONLY used to identify the character's appearance — the photo's background is irrelevant (the video will place the character in a different environment via text prompt). Choose the angle that best matches the character's body visibility needs for the action.

Return JSON: { "index": number, "reason": string }

Rules:
- Sitting/close interaction → closeup_face or front
- Walking/running/sports/full-body action → full_body_front
- Conversation face-to-face → front or left_45/right_45 depending on who they face
- Side view scene (walking past camera) → left_profile or right_profile
- Behind/away from camera → back
- Default if unclear → front`,
        },
        {
          role: "user",
          content: `Location: ${location}\nAction: ${plot}\n\nAvailable images:\n${catalog.map((c) => `${c.index}: ${c.angle} — ${c.description}`).join("\n")}`,
        },
      ],
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return primary;
    const parsed = JSON.parse(raw);
    const idx = Number(parsed.index);
    if (Number.isFinite(idx) && idx >= 0 && idx < images.length) {
      logLine("pre-job", "image_pick_reason", { reason: parsed.reason });
      return images[idx];
    }
  } catch {
    // Fall back to primary
  }
  return primary;
}

// ---------------------------------------------------------------------------
// Build BaseScene from character appearance + location
// ---------------------------------------------------------------------------

function buildBaseSceneFromCharacter(
  char: Character,
  locationDescription: string,
): BaseScene {
  const a = char.appearance;
  const outfit = [a.default_outfit.top, a.default_outfit.bottom, a.default_outfit.shoes]
    .filter(Boolean)
    .join(", ");

  return {
    subject: `${char.name}, ${a.gender_presentation}, ${a.age_range}, ${a.build} build, ${a.hair.color} ${a.hair.style} hair, wearing ${outfit}`,
    subject_state: "standing naturally, at ease",
    environment: locationDescription,
    camera: "medium shot, eye level",
    textures: a.distinguishing_features.join(", ") || "natural skin, fabric textures",
  };
}

// ---------------------------------------------------------------------------
// Character-input compatibility check: adapt user input to fit character
// ---------------------------------------------------------------------------

interface CompatibilityResult {
  compatible: boolean;
  adaptedPlot: string;
  adaptedLocation: string;
  warnings: string[];
  explanation: string;
}

async function checkCharacterCompatibility(
  character: Character,
  locationDescription: string,
  plotChange: string,
): Promise<CompatibilityResult> {
  const fallback: CompatibilityResult = {
    compatible: true,
    adaptedPlot: plotChange,
    adaptedLocation: locationDescription,
    warnings: [],
    explanation: "",
  };

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return fallback;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const ctx = characterToPromptContext(character);
  const pb = character.personality.physical_behavior;
  const redFlags = pb?.behavioral_red_flags?.join(", ") || "none";

  try {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are a character consistency enforcer. You receive a CHARACTER PROFILE and a USER'S requested video plot.

Your job: keep WHO this person is and HOW they react aligned with profile data. Users must not assign them a fake job, moral role, or personality that contradicts the profile.

SITUATION vs ASSIGNED ROLE (critical):
- ALLOW external circumstances: wrong place, strangers approach, trouble finds them, they witness something, they get stopped, accidental danger, etc. The world can do things TO them.
- REJECT or REWRITE user-assigned identity/role that the profile does not support: e.g. "is a drug dealer", "runs the operation", "acts like a hardened criminal", "flirts aggressively" if that contradicts profile. Instead: same rough situation, but ${character.name} is still themselves — reacting with THEIR temperament, decision style, and physical behavior — not performing a new persona.
- NEVER script specific emotional beats the user invents if they clash with profile (e.g. "he freaks out" for a calm character → show measured tension, slower breathing, controlled assessment instead).
- Reactions, micro-movements, pace, and choices come ONLY from profile + physical_behavior + personality — not from user headcanon.

RULES:
1. CHARACTER DATA ALWAYS WINS over user input for behavior and inner response. If user says "dances wildly in the spotlight" but the character is reserved, adapt to a smaller, in-character version of the beat.
2. Adapt GENTLY — preserve the user's EXTERNAL situation when possible; change HOW the character carries themselves through it.
3. BEHAVIORAL RED FLAGS are actions this character would NEVER do: ${redFlags}
4. Location: keep if plausible; if outside comfort zone, show behavior that fits their profile (caution, withdrawal, controlled unease — not a random new personality).
5. Only canonical story resolutions can change traits over time. Creation input cannot rewrite who they are.

Return JSON:
{
  "compatible": boolean (true if no changes needed, false if adapted),
  "adapted_plot": "the plot, rewritten to fit the character if needed (or original if compatible)",
  "adapted_location": "location (adjusted only if truly inappropriate)",
  "warnings": ["list of things that were changed and why"],
  "explanation": "brief explanation for the user if changes were made"
}`,
        },
        {
          role: "user",
          content: `CHARACTER PROFILE:\n${ctx}\n\nUSER INPUT:\nLocation: ${locationDescription}\nPlot: ${plotChange}`,
        },
      ],
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);

    const result: CompatibilityResult = {
      compatible: parsed.compatible !== false,
      adaptedPlot: parsed.adapted_plot || plotChange,
      adaptedLocation: parsed.adapted_location || locationDescription,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      explanation: parsed.explanation || "",
    };

    if (!result.compatible) {
      logLine("pre-job", "character_compat_adapted", {
        character: character.name,
        originalPlot: plotChange.slice(0, 100),
        adaptedPlot: result.adaptedPlot.slice(0, 100),
        warnings: result.warnings,
      });
    }

    return result;
  } catch (err: any) {
    logLine("pre-job", "character_compat_error", { message: err?.message });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Character-aware LLM prompt → 3 structured multi-scene prompts
// ---------------------------------------------------------------------------

async function buildCharacterMultiScenePrompt(
  character: Character,
  baseScene: BaseScene,
  userPlotChange: string,
  options?: { mood?: string; camera?: string },
): Promise<EnhancedPlot | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const characterContext = characterToPromptContext(character);
  const klingIdentity = characterToKlingIdentity(character);

  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL_IMAGE_PATTERNS || process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content: `You create 3-scene video prompts for Kling AI image-to-video. The video stars a specific CHARACTER and starts from their reference image.

===== CHARACTER PROFILE =====
${characterContext}

===== CHARACTER IDENTITY (for video prompts) =====
${klingIdentity}

===== CHARACTER BEHAVIOR IS LAW (overrides user input) =====
This character's physical behavior MUST govern every movement in the video.
The user's plot may describe CIRCUMSTANCES (where they are, what happens around them, who approaches them).
The CHARACTER PROFILE alone dictates HOW ${character.name} reacts — pace, posture, gestures, fear/anger/calm, whether they engage or withdraw. Do NOT invent a new persona, job, or moral alignment for them.

SITUATION vs REACTION:
- OK: User puts them in tension, ambiguity, social pressure, or danger — show ${character.name} moving through it AS THIS CHARACTER.
- NOT OK: User makes them someone they are not (criminal role, opposite temperament, theatrical emotion not in profile). Strip the false role; keep the situation if possible with in-character responses.

PHYSICAL BEHAVIOR:
- Energy level: ${character.personality.physical_behavior?.energy_level ?? character.personality.temperament}
- Movement style: ${character.personality.physical_behavior?.movement_style ?? "natural to personality"}
- Posture: ${character.personality.physical_behavior?.posture ?? "natural"}
- Typical gestures: ${character.personality.physical_behavior?.typical_gestures?.join(", ") ?? "none specified"}
- Walking pace: ${character.personality.physical_behavior?.walking_pace ?? "moderate"}
- Emotional expressiveness: ${character.personality.physical_behavior?.emotional_expressiveness ?? "moderate"}

BEHAVIORAL RED FLAGS — ${character.name} would NEVER:
${character.personality.physical_behavior?.behavioral_red_flags?.map((f: string) => `- ${f}`).join("\n") ?? "- (none specified)"}

If the user's input asks for movement that conflicts with these traits, ADAPT it:
- Same action, but done in ${character.name}'s way (their energy, their pace, their gestures)
- Example: User says "jumps excitedly" but character is calm → "nods slowly with a subtle smirk"

PERSONALITY DRIVERS:
- Temperament: ${character.personality.temperament}
- Decision style: ${character.personality.decision_style}
- Under pressure: ${character.personality.under_pressure}

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

===== CRITICAL: START IMAGE IS A CHARACTER REFERENCE ONLY =====
The start image is a REFERENCE PHOTO of the character — it shows what they LOOK LIKE.
The background/setting of the photo is IRRELEVANT and must be COMPLETELY IGNORED.
The actual environment for the video comes from the "Environment" field in BASE IMAGE above.

Scene 1 MUST place the character INTO the story's environment. Open by briefly naming
the location (e.g. "In a convenience store aisle, ${character.name} …") so Kling
generates the correct surroundings. After Scene 1 establishes the setting, Scenes 2-3
can focus purely on motion without re-describing it.

===== HOW KLING AI WORKS =====
Kling uses the start image to identify the character's appearance, then generates video
from your text prompt. You control the ENVIRONMENT through your text.

NEVER start with "The camera captures..." or "The scene shows..." — describe MOTION.
Each scene prompt describes what CHANGES / MOVES during that 2-second window.

===== MOVEMENT PRINCIPLES FOR NATURAL VIDEO =====

1. ONE CONTINUOUS FLOW — Each scene picks up EXACTLY where the previous one left off.
   If Scene 1 ends with ${character.name} walking toward something, Scene 2 starts with them arriving.
   NEVER "reset" the scene or re-establish the setting.

2. DESCRIBE PHYSICAL MOTION, NOT CAMERA NARRATION:
   BAD: "The camera captures ${character.name} assessing the situation."
   GOOD: "${character.name} steps forward, eyes scanning the display."
   BAD: "The camera shifts to focus on their expression."
   GOOD: "They reach out, fingers hovering over the selection."

3. USE ACTION VERBS, NOT OBSERVATION VERBS:
   BAD: "appears", "is seen", "can be observed", "the camera reveals"
   GOOD: "walks", "grips", "lifts", "turns", "reaches", "steps", "leans"

4. BLEND ACTION WITH ENVIRONMENT — Each scene should combine physical motion with
   brief sensory/environmental detail so Kling maintains the setting consistently.
   BAD (pure filler): "The ambient light casts soft shadows, highlighting their figure and creating anticipation."
   BAD (pure action): "He picks up the shoe."
   GOOD: "${character.name} picks up the sneaker from the brightly lit display shelf, turning it in the warm store lighting."
   Include 1-2 short environment anchors per scene (lighting, surfaces, objects nearby).

5. AIM FOR 40-60 WORDS PER SCENE — enough for Kling to understand both the motion
   AND the setting. Every scene should mention at least one environmental element.

===== DIALOGUE / VOICE =====
ABSOLUTELY FORBIDDEN unless user explicitly asks for speech.
No murmurs, "hmm", grunts, sighs, whispers, or ANY sound.

===== MOVEMENT FIDELITY & PACING =====
- MAX 1-2 ACTIONS PER 2-SECOND SCENE. Kling needs time to render each action.
  If the user asks for 5 things, spread them across all 3 scenes or cut the less important ones.
  BAD: "He picks up shoes, stands up, tests side steps, swaps to second pair, stands tall" (5 actions in 2s!)
  GOOD: "He slips on the white sneakers and stands up slowly, flexing his feet on the polished store floor." (1-2 actions)
- Include movement implied by the user's situation, but ALWAYS executed in this character's physical and emotional style (profile-driven), never as a generic action hero or a different personality.
- Do NOT invent extra body movements unless they are this character's TYPICAL GESTURES.
- "deciding" / "contemplating" = ${character.name}'s typical thinking gesture, not generic pondering.
- Movement speed and energy MUST match: ${character.personality.physical_behavior?.energy_level ?? character.personality.temperament}

===== MOOD & CAMERA (if provided) =====
The user may specify a Mood and/or Camera style. If provided, use them:
- Mood affects PACING: "tense" = slower movements, held pauses. "energetic" = quicker actions. "calm" = gentle, unhurried. "playful" = lighter, bouncier movement. "dramatic" = deliberate, weighted.
- Camera options: "follow" = camera tracks the subject. "static" = camera locked, only subject moves. "closeup" = tight framing on hands/face. "pov" = first-person view. "orbit" = slow circular movement around subject.
- If not provided, choose what fits the action and character personality naturally.

===== SCENE STRUCTURE =====
You MUST decide the total duration: 6, 8, or 10 seconds. Return "total_duration_seconds" in JSON.
- Simple setup (1 action + cliffhanger): 6s → 3 scenes × 2s
- Medium setup (2 actions + cliffhanger): 8s → scene_1=3s, scene_2=3s, scene_3=2s
- Complex setup (3+ actions + cliffhanger): 10s → scene_1=3s, scene_2=4s, scene_3=3s
Set each scene's "duration" field accordingly.

- Scene 1: ESTABLISH & BEGIN. Name the location/setting (e.g. "In a brightly lit convenience store, ${character.name}…") then start the first motion.
- Scene 2: The action DEVELOPS. The main beat unfolds. This is the heart. Let movements breathe — do not rush.
- Scene 3: CLIFFHANGER. Movement slows to stillness. ${character.name} holds position facing a clear choice/dilemma. The viewer MUST see what the options are (two items, two paths, a decision point). Camera may drift slowly. No resolution.
- This is Part 1 of a two-part video. NEVER show the outcome or resolution. The clip MUST end with a visible dilemma.

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
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed.feasibility_notes) {
      logLine("llm", "feasibility", {
        notes: parsed.feasibility_notes,
        enhanced_plot: parsed.enhanced_plot,
      });
    }
    const hardNegative =
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking, murmuring, whispering";
    const spoken =
      typeof parsed.spoken_dialogue === "string"
        ? parsed.spoken_dialogue.trim().slice(0, 120)
        : "";
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

// ---------------------------------------------------------------------------
// Fallback when LLM is unavailable
// ---------------------------------------------------------------------------

function buildFallbackScenes(
  character: Character,
  baseScene: BaseScene,
  userPlotChange: string,
): EnhancedPlot {
  const identity = characterToKlingIdentity(character);
  return {
    scene_summary: `${character.name} — ${userPlotChange}`,
    spoken_dialogue: "",
    scenes: [
      { prompt: `${identity}. ${userPlotChange}. The action begins naturally.`, duration: "2" },
      { prompt: `Continuing smoothly. The moment develops.`, duration: "2" },
      { prompt: `Movement slows. Stillness. Camera drifts in slowly. No resolution.`, duration: "2" },
    ],
    negative_prompt:
      "outcome revealed, result shown, action completed, decision finished, sudden jump, jerky motion, talking, speaking",
    outcomes: [],
  };
}

// ---------------------------------------------------------------------------
// Compose scene frame: transform reference photo into scene via image-to-image
// ---------------------------------------------------------------------------

async function composeSceneFrame(opts: {
  fal: any;
  character: Character;
  baseScene: BaseScene;
  frontalImageUrl: string;
  scenePrompt: string;
}): Promise<string | null> {
  const { fal, character, baseScene, frontalImageUrl, scenePrompt } = opts;

  const prompt = [
    `Same person, exact same face and body, now standing in: ${baseScene.environment}.`,
    scenePrompt,
    `${baseScene.camera}. Keep the person identical, only change the background and surroundings.`,
  ].join(" ");

  logLine("compose", "scene_frame_prompt", { prompt: prompt.slice(0, 300) });

  try {
    const result = await fal.subscribe("fal-ai/kling-image/v3/image-to-image", {
      ...falLongJobOptions,
      input: {
        prompt,
        image_url: frontalImageUrl,
        aspect_ratio: "9:16",
        resolution: "1K",
        output_format: "png",
        num_images: 1,
      },
      logs: true,
      onQueueUpdate: (u: any) =>
        logLine("compose", "frame.queue", { status: u?.status ?? "unknown" }),
    });

    const url = (result as any)?.data?.images?.[0]?.url as string | undefined;
    if (url) {
      logLine("compose", "scene_frame_done", { url: url.slice(0, 80) });
    }
    return url ?? null;
  } catch (err: any) {
    logLine("compose", "scene_frame_failed", { message: err?.message ?? "unknown" });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core generation logic for character-based clips
// ---------------------------------------------------------------------------

async function runCharacterGeneration(opts: {
  user: { id: string };
  serviceClient: any;
  fal: any;
  character: CharacterWithImages;
  imageStoragePath: string;
  characterImageUrl: string;
  baseScene: BaseScene;
  plotChange: string;
  mood?: string;
  camera?: string;
}) {
  const {
    user,
    serviceClient,
    fal,
    character,
    imageStoragePath,
    characterImageUrl,
    baseScene,
    plotChange,
    mood,
    camera,
  } = opts;

  const llmResult = await buildCharacterMultiScenePrompt(character, baseScene, plotChange, {
    mood,
    camera,
  });
  const enhanced = llmResult || buildFallbackScenes(character, baseScene, plotChange);

  logLine("pre-job", "scene_plan", {
    character: character.name,
    plotChange,
    summary: enhanced.scene_summary,
  });

  // Compose a scene frame: transform reference photo into the story's environment
  const composedFrameUrl = await composeSceneFrame({
    fal,
    character,
    baseScene,
    frontalImageUrl: characterImageUrl,
    scenePrompt: enhanced.scenes[0].prompt,
  });
  const startImageUrl = composedFrameUrl ?? characterImageUrl;
  logLine("pre-job", "start_image", {
    composed: !!composedFrameUrl,
    url: startImageUrl.slice(0, 80),
  });

  const { data: job, error: jobErr } = await serviceClient
    .from("clip_generation_jobs")
    .insert({
      user_id: user.id,
      status: "generating_video",
      provider: "fal",
      image_model_key: composedFrameUrl
        ? "fal-ai/kling-image/v3/text-to-image"
        : "character_reference",
      video_model_key: "fal-ai/kling-video/v3/pro/image-to-video",
      generation_mode: "character",
      llm_generation_json: {
        ...enhanced,
        base_scene: baseScene,
        source: `character:${character.slug || character.id}`,
        character_id: character.id,
        character_name: character.name,
        image_storage_path: imageStoragePath,
        composed_scene_frame: !!composedFrameUrl,
      },
    })
    .select()
    .single();
  if (jobErr || !job) return { error: "Failed to create generation job" };

  const jobId = String((job as any).id);
  try {
    const startedAt = Date.now();

    logLine(jobId, "start", {
      userId: user.id,
      characterId: character.id,
      mode: "multi_prompt",
      composedFrame: !!composedFrameUrl,
    });
    logLine(jobId, "multi_prompt", {
      scene_1: enhanced.scenes[0].prompt,
      scene_2: enhanced.scenes[1].prompt,
      scene_3: enhanced.scenes[2].prompt,
      negative: enhanced.negative_prompt,
    });

    const video = await fal.subscribe("fal-ai/kling-video/v3/pro/image-to-video", {
      ...falLongJobOptions,
      input: {
        start_image_url: startImageUrl,
        multi_prompt: enhanced.scenes.map((s: MultiScene) => ({
          prompt: s.prompt,
          duration: s.duration,
        })),
        shot_type: "customize",
        negative_prompt: enhanced.negative_prompt,
        duration: String(Math.min(10, Math.max(5, enhanced.total_duration_seconds || 6))),
        generate_audio: true,
      },
      logs: true,
      onQueueUpdate: (u: any) =>
        logLine(jobId, "video.queue", { status: u?.status ?? "unknown" }),
    });

    const videoUrl = (video as any)?.data?.video?.url as string | undefined;
    if (!videoUrl) throw new Error("Kling video missing url");
    logLine(jobId, "video.done", {
      requestId: (video as any)?.requestId ?? null,
      ms: Date.now() - startedAt,
    });

    let videoBytes = await downloadToUint8Array(videoUrl);

    try {
      logLine(jobId, "resolution_check.start");
      const analysis = await analyzeVideoForResolution(
        videoUrl,
        enhanced.scene_summary,
        enhanced.outcomes,
      );
      logLine(jobId, "resolution_check.done", {
        resolved: analysis.resolved,
        cutAt: analysis.cutAtSecond,
        desc: analysis.description.slice(0, 120),
      });
      if (analysis.resolved && analysis.cutAtSecond && analysis.cutAtSecond >= 2) {
        logLine(jobId, "resolution_trim", { cutAtSecond: analysis.cutAtSecond });
        videoBytes = (await trimVideoAt(videoBytes, analysis.cutAtSecond)) as Uint8Array<ArrayBuffer>;
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
      body: `Your ${character.name} video is ready. Tap to review, improve, or post.`,
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
        llmGeneration: { ...enhanced, base_scene: baseScene, character_id: character.id },
        characterId: character.id,
      },
    };
  } catch (e: any) {
    const message = formatFalError(e) || e?.message || "Generation failed";
    logLine(jobId, "failed", { message });
    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", (job as any).id);
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// Local dev: skip Fal when MEDIA_PROVIDER=mock (localhost images are not reachable by Fal)
// ---------------------------------------------------------------------------

async function runCharacterGenerationMock(opts: {
  user: { id: string };
  serviceClient: any;
  character: CharacterWithImages;
  imageStoragePath: string;
  baseScene: BaseScene;
  plotChange: string;
  mood?: string;
  camera?: string;
}) {
  const {
    user,
    serviceClient,
    character,
    imageStoragePath,
    baseScene,
    plotChange,
    mood,
    camera,
  } = opts;

  const llmResult = await buildCharacterMultiScenePrompt(character, baseScene, plotChange, {
    mood,
    camera,
  });
  const enhanced = llmResult || buildFallbackScenes(character, baseScene, plotChange);

  logLine("pre-job", "mock_mode", { character: character.name, summary: enhanced.scene_summary });

  const { data: job, error: jobErr } = await serviceClient
    .from("clip_generation_jobs")
    .insert({
      user_id: user.id,
      status: "generating_video",
      provider: "mock",
      image_model_key: "mock",
      video_model_key: "mock",
      generation_mode: "character",
      llm_generation_json: {
        ...enhanced,
        base_scene: baseScene,
        source: `character:${character.slug || character.id}`,
        character_id: character.id,
        character_name: character.name,
        image_storage_path: imageStoragePath,
        mock_clip: true,
      },
    })
    .select()
    .single();
  if (jobErr || !job) return { error: "Failed to create generation job" };

  const jobId = String((job as any).id);
  try {
    const videoBytes = await createMockClipMp4();
    const videoPath = `clips/${user.id}/${jobId}.mp4`;
    await uploadBytesToMedia(videoPath, videoBytes, "video/mp4");

    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "review",
        video_storage_path: videoPath,
        updated_at: new Date().toISOString(),
      })
      .eq("id", (job as any).id);

    await serviceClient.from("notifications").insert({
      user_id: user.id,
      type: "video_review_ready",
      title: "Video ready for review (mock)",
      body: `Mock clip for ${character.name}. Install ffmpeg for a real file, or use Fal in production.`,
      link: "/create",
      read: false,
    });

    logLine(jobId, "mock_ready_for_review", { videoPath });
    return {
      data: {
        jobId,
        videoStoragePath: videoPath,
        imageStoragePath,
        sceneSummary: enhanced.scene_summary,
        llmGeneration: {
          ...enhanced,
          base_scene: baseScene,
          character_id: character.id,
          mock_clip: true,
        },
        characterId: character.id,
      },
    };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    logLine(jobId, "mock_failed", { message: msg });
    await serviceClient
      .from("clip_generation_jobs")
      .update({
        status: "failed",
        error_message: msg,
        updated_at: new Date().toISOString(),
      })
      .eq("id", (job as any).id);
    if (/ffmpeg|ENOENT|spawn/i.test(msg)) {
      return {
        error:
          "MEDIA_PROVIDER=mock needs ffmpeg on PATH to build a test MP4. Install ffmpeg, or remove MEDIA_PROVIDER=mock and use a Fal key with Kling + storage upload access.",
      };
    }
    return { error: msg || "Mock generation failed" };
  }
}

// ---------------------------------------------------------------------------
// Main public action: generate from character
// ---------------------------------------------------------------------------

export async function generateFromCharacter(input: {
  characterId: string;
  locationDescription: string;
  plotChange: string;
  mood?: string;
  camera?: string;
}) {
  try {
    const mood = sanitizeOptionalString(input.mood);
    const camera = sanitizeOptionalString(input.camera);

    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Not signed in" };

    const serviceClient = await createServiceClient();
    const guard = await checkAndClearStaleJobs(serviceClient, user.id);
    if (guard.blocked) return { error: "A generation is already running. Please wait." };

    const { character, error: charErr } = await getCharacterById(input.characterId);
    if (charErr || !character) return { error: charErr || "Character not found" };

    // Check if user input is compatible with character personality
    const compat = await checkCharacterCompatibility(
      character,
      input.locationDescription,
      input.plotChange,
    );
    const effectivePlot = compat.adaptedPlot;
    const effectiveLocation = compat.adaptedLocation;

    const bestImage = character.reference_images.length > 1
      ? await pickBestReferenceImage(character.reference_images, effectiveLocation, effectivePlot)
      : character.reference_images.find((img) => img.is_primary) ?? character.reference_images[0];
    if (!bestImage) return { error: "Character has no reference image" };

    logLine("pre-job", "image_selected", {
      angle: bestImage.angle,
      path: bestImage.image_storage_path,
      reason: bestImage.description,
    });

    const imageStoragePath = bestImage.image_storage_path;
    const baseScene = buildBaseSceneFromCharacter(character, effectiveLocation);

    logLine("pre-job", "character_media_route", {
      character: character.name,
      mock: isMediaMockMode(),
    });

    if (isMediaMockMode()) {
      const result = await runCharacterGenerationMock({
        user,
        serviceClient,
        character,
        imageStoragePath,
        baseScene,
        plotChange: effectivePlot,
        mood,
        camera,
      });
      if (!compat.compatible && result.data) {
        (result.data as any).characterAdaptation = {
          adapted: true,
          warnings: compat.warnings,
          explanation: compat.explanation,
        };
      }
      return result;
    }

    const fal = getFalClient();

    const { data: imgBytes } = await serviceClient.storage
      .from("media")
      .download(imageStoragePath);
    if (!imgBytes) return { error: "Character reference image not found in storage" };

    const imgBuffer = new Uint8Array(await imgBytes.arrayBuffer());
    const ext = imageStoragePath.split(".").pop() || "png";
    const falFile = new File([imgBuffer], `character.${ext}`, {
      type: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png",
    });
    let characterImageUrl: string;
    try {
      characterImageUrl = await fal.storage.upload(falFile);
    } catch (uploadErr: any) {
      if (isFalForbiddenError(uploadErr)) {
        // Fallback for local/dev where storage upload scope may be restricted:
        // use a data URL as start image directly.
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
        characterImageUrl = `data:${mime};base64,${Buffer.from(imgBuffer).toString("base64")}`;
        logLine("pre-job", "character_image_upload_forbidden_fallback_data_url", {
          status: uploadErr?.status ?? 403,
          bytes: imgBuffer.byteLength,
        });
      } else {
        throw uploadErr;
      }
    }
    if (!characterImageUrl) return { error: "Failed to upload character image to fal.ai" };
    logLine("pre-job", "character_image_uploaded", {
      characterId: character.id,
      url: characterImageUrl,
    });

    const result = await runCharacterGeneration({
      user,
      serviceClient,
      fal,
      character,
      imageStoragePath,
      characterImageUrl,
      baseScene,
      plotChange: effectivePlot,
      mood,
      camera,
    });

    // Attach adaptation info so the UI can inform the user
    if (!compat.compatible && result.data) {
      (result.data as any).characterAdaptation = {
        adapted: true,
        warnings: compat.warnings,
        explanation: compat.explanation,
      };
    }

    return result;
  } catch (e: any) {
    const message = e?.message || "Character generation failed";
    console.error("[generateFromCharacter] unexpected error", e);
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// Publish a reviewed character draft → go live
// ---------------------------------------------------------------------------

export async function publishCharacterDraft(input: {
  jobId: string;
  videoStoragePath: string;
  imageStoragePath: string;
  sceneSummary: string;
  llmGeneration: any;
  characterId: string;
}) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Not signed in" };

    const serviceClient = await createServiceClient();
    const now = new Date().toISOString();

    const { data: story, error: storyErr } = await serviceClient
      .from("stories")
      .insert({
        title: (input.sceneSummary || "Untitled").slice(0, 80),
        creator_user_id: user.id,
      })
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
        character_id: input.characterId,
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
    if (clipErr || !clipNode)
      return { error: `Failed to create clip: ${(clipErr as any)?.message ?? ""}` };

    await serviceClient
      .from("stories")
      .update({ root_clip_node_id: (clipNode as any).id })
      .eq("id", (story as any).id);

    await serviceClient
      .from("clip_generation_jobs")
      .update({ status: "completed", clip_node_id: (clipNode as any).id, updated_at: now })
      .eq("id", input.jobId);

    const { data: charRow } = await serviceClient
      .from("characters")
      .select("total_videos")
      .eq("id", input.characterId)
      .single();
    if (charRow) {
      await serviceClient
        .from("characters")
        .update({ total_videos: (Number(charRow.total_videos) || 0) + 1 })
        .eq("id", input.characterId);
    }

    logLine(input.jobId, "published", {
      clipId: (clipNode as any).id,
      characterId: input.characterId,
    });

    import("@/video-intelligence/pipeline")
      .then((m) => m.analyzeClipVideo(String((clipNode as any).id)))
      .catch(() => {});

    revalidatePath("/feed");
    return { data: { clipId: (clipNode as any).id } };
  } catch (e: any) {
    const message = e?.message || "Publish failed";
    console.error("[publishCharacterDraft] unexpected error", e);
    return { error: message };
  }
}
