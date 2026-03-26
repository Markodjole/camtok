/**
 * Scene Planner v10
 *
 * Flux has a ~77 CLIP token limit (~60-70 words effective).
 * Every word in the image prompt MUST count.
 *
 * Frame 1 = characters + scene + key_element_normal + camera/style (~60 words)
 * Frame 2 = characters + scene + key_element_CHANGED + camera/style (~60 words)
 *
 * Consistency is handled by: same seed + img2img + same base description.
 * NOT by wasting prompt tokens on "IDENTICAL SCENE LOCK" text.
 *
 * The LLM generates SHORT, STRICT fields (word limits enforced).
 */

import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SceneState = {
  scene: string;
  characters: string;
  camera: string;
  key_element_normal: string;
  key_element_changed: string;
  reaction_change: string;
  state_change_description: string;
  option_a: string;
  option_b: string;
  unresolved_question: string;
  outcomes: string[];
  allowed_actions: string[];
  forbidden: string[];
  video_motion: string;
  subject: string;
  detailed_scene_prompt: string;
  event_phrase: string;
  setup_description: string;
  tension_description: string;
  scene_description: string;
};

export type ActionStep = { t: number; action: string };

export type ActionTimeline = {
  timeline: ActionStep[];
  video_motion_description: string;
};

export type ScenePlanResult = {
  sceneState: SceneState;
  timeline: ActionTimeline;
  firstFramePrompt: string;
  endFramePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
};

// ---------------------------------------------------------------------------
// LLM Scene Designer — SHORT fields, strict word limits
// ---------------------------------------------------------------------------

type LlmSceneOutput = {
  scene: string;
  characters: string;
  camera: string;
  key_element_normal: string;
  key_element_changed: string;
  reaction_change: string;
  state_change_description: string;
  option_a: string;
  option_b: string;
  unresolved_question: string;
  outcomes: string[];
  allowed_actions: string[];
  video_motion: string;
};

async function designScene(
  sceneSetupPrompt: string,
  plotPrompt: string,
): Promise<LlmSceneOutput | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `You design scenes for AI image generation. The image model has a STRICT 60-word prompt limit. Every word counts.

We generate TWO images from ONE scene. They must be identical except for ONE physical change to a key element.

RULES — all fields must be SHORT and PHYSICAL (no emotion/mood words):

1. "characters" — STRICT 15 words max. Count + gender + age + clothing + FIXED position.
   GOOD: "2 men and 1 woman, late 20s, swimwear, men floating left and center, woman sitting right edge"
   BAD: "a group of friends enjoying themselves in the pool with relaxed expressions and diverse ethnicities" (too long, too vague)

2. "scene" — STRICT 15 words max. Location + time + lighting direction + key materials.
   GOOD: "rooftop infinity pool, city skyline, twilight, purple-orange sky, concrete and glass, turquoise water"
   BAD: "rooftop infinity pool overlooking a beautiful city skyline at twilight with a soft purple and orange sky" (too long)

3. "camera" — STRICT 10 words max. Angle + framing + lens.
   GOOD: "eye-level, medium-wide, waist-up, centered, 35mm lens"
   BAD: "eye-level shot, medium-wide framing, all subjects visible from waist up, centered composition, no tilt, no camera movement, 35mm lens look" (way too long)

4. "key_element_normal" — STRICT 15 words max. The ONE story-critical object in its INTACT state. Position + material + condition.
   GOOD: "large glass wall panel at pool edge, perfectly intact, clean, water touching its base"
   BAD: "a large transparent glass wall panel on the right side of the pool, perfectly intact and clean, water gently touching its base, clear reflections visible on surface" (too long)

5. "key_element_changed" — STRICT 15 words max. SAME object, SAME position, ONE clearly visible physical change. The change must be OBVIOUS and LARGE, not subtle or tiny. Never use "subtle" or "slightly".
   CRITICAL: Always anchor the change to the OBJECT'S position in the frame (e.g. "at the bottom-right glass panel"). Never say "from center" without specifying which object — the AI model will apply the change to the whole image instead of the specific object.
   GOOD: "the glass panel at bottom of frame has a large crack spreading across it, water leaking"
   BAD: "large crack from center spreading outward" (ambiguous — AI applies crack to whole image like a lens effect)
   BAD: "subtle crack starting slightly" (too subtle — change must be clearly visible)

6. "reaction_change" — STRICT 15 words max. How the subject(s) visibly react to the plot change. No position changes — only expression, posture, or physical state changes.
   For people: facial expression + micro body language (e.g. "wide eyes, tense shoulders, gripping edge")
   For animals: body language (e.g. "ears flat, fur raised, crouched low")
   For objects/nature: physical reaction (e.g. "water ripples violently, leaves scatter")
   If no subjects react, write "no visible reaction"

7. "state_change_description" — For video only. CAN use tension/suspense words. 15 words max.

FORBIDDEN in fields 1-5: "tension", "dramatic", "suspenseful", "about to", "pressure", "nervous", "intense", "threatening"

Return ONLY valid JSON (no trailing periods):
{
  "scene": "15 words max",
  "characters": "15 words max with fixed positions",
  "camera": "10 words max",
  "key_element_normal": "15 words max, intact state",
  "key_element_changed": "15 words max, ONE physical change",
  "reaction_change": "15 words max, how subjects visibly react (expression, posture, or physical state)",
  "state_change_description": "15 words max, for video prompt",
  "option_a": "under 8 words",
  "option_b": "under 8 words",
  "unresolved_question": "under 10 words",
  "outcomes": ["A", "B", "C"],
  "allowed_actions": ["action 1", "action 2", "action 3"],
  "video_motion": "under 12 words"
}

EXAMPLES (cover different subjects — the pattern is universal):

EXAMPLE 1 — People scene:
Scene Setup: "group of friends in infinity pool"
Plot Change: "glass edge cracks and people are scared"
{
  "scene": "rooftop infinity pool, city skyline, twilight, purple-orange sky, concrete and glass",
  "characters": "2 men and 1 woman, late 20s, swimwear, men floating left, woman sitting right edge",
  "camera": "eye-level, medium-wide, waist-up, centered, 35mm lens",
  "key_element_normal": "large glass wall panel at pool edge, perfectly intact, clean, water touching base",
  "key_element_changed": "the glass panel at bottom of frame has large crack spreading across it, water leaking through",
  "reaction_change": "wide eyes, open mouths, tense shoulders, gripping pool edge",
  "state_change_description": "crack appears at center of glass panel and slowly spreads",
  "option_a": "glass shatters completely",
  "option_b": "crack stops, glass holds",
  "unresolved_question": "Will the glass hold or shatter?",
  "outcomes": ["Glass shatters", "Glass holds", "Friends escape in time"],
  "allowed_actions": ["crack grows wider", "water seeps faster", "friend flinches"],
  "video_motion": "calm pool scene to spreading crack and frozen reactions"
}

EXAMPLE 2 — Animal scene:
Scene Setup: "cat sleeping on sunny grass in a garden"
Plot Change: "a dog appears behind the fence and cat wakes up alert"
{
  "scene": "backyard garden, sunny afternoon, soft shadows, green grass, wooden fence",
  "characters": "1 tabby cat, curled up center of grass, eyes closed, fur smooth",
  "camera": "eye-level, medium shot, full body, centered, 50mm lens",
  "key_element_normal": "wooden fence in background, fully closed, no animals behind it",
  "key_element_changed": "same fence, golden retriever head poking over top, ears up, looking at cat",
  "reaction_change": "cat eyes wide open, ears perked, body tensed, alert posture",
  "state_change_description": "dog appears over fence, cat snaps awake, freezes in alert stance",
  "option_a": "cat bolts away from dog",
  "option_b": "cat holds ground, stares back",
  "unresolved_question": "Will the cat run or stand its ground?",
  "outcomes": ["Cat runs", "Cat stays", "Dog jumps over fence"],
  "allowed_actions": ["cat twitches tail", "dog barks", "cat lowers body"],
  "video_motion": "peaceful sleeping cat to alert freeze as dog appears"
}

EXAMPLE 3 — Object/nature scene (no living subjects):
Scene Setup: "a droplet falls onto still water surface"
Plot Change: "one ripple becomes stronger than the others"
{
  "scene": "dark still water surface, overhead light, black background, reflective",
  "characters": "none",
  "camera": "top-down, macro close-up, centered, 100mm macro lens",
  "key_element_normal": "single water droplet mid-fall, perfectly spherical, above calm flat water",
  "key_element_changed": "concentric ripples on water, one ripple on the right visibly taller and wider",
  "reaction_change": "surrounding water disturbed, smaller ripples bending toward the dominant one",
  "state_change_description": "ripples expand outward, one grows dominant, others bend toward it",
  "option_a": "dominant ripple keeps growing",
  "option_b": "ripples equalize and settle",
  "unresolved_question": "Will the dominant ripple take over?",
  "outcomes": ["One ripple dominates", "Ripples equalize", "New droplet falls"],
  "allowed_actions": ["ripple expands further", "water surface trembles", "smaller ripples merge"],
  "video_motion": "droplet impact to expanding ripples, one growing dominant"
}

(Each example follows the same structure — adapt to ANY subject.)`,
        },
        {
          role: "user",
          content: `Scene setup prompt: "${sceneSetupPrompt}"\nPlot change prompt: "${plotPrompt}"`,
        },
      ],
    });

    const content = res.choices[0]?.message?.content;
    if (!content) return null;

    const p = JSON.parse(content) as LlmSceneOutput;

    console.log(`[scene-design] tokens=${res.usage?.total_tokens ?? 0}`, {
      scene: p.scene,
      characters: p.characters,
      camera: p.camera,
      key_normal: p.key_element_normal,
      key_changed: p.key_element_changed,
    });

    return p;
  } catch (err: unknown) {
    console.error("[scene-design] LLM failed:", (err as Error)?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Action Timeline
// ---------------------------------------------------------------------------

async function planTimeline(
  scene: SceneState,
  durationSeconds: number,
): Promise<ActionTimeline> {
  const actions = (scene.allowed_actions || []).slice(0, 3);
  if (actions.length === 0) actions.push("subtle shift", "brief pause", "slight movement");
  const step = Math.floor(durationSeconds / actions.length);
  return {
    timeline: actions.map((action, i) => ({ t: i * step, action })),
    video_motion_description: scene.video_motion || "Smooth transition from calm to tense",
  };
}

// ---------------------------------------------------------------------------
// Prompt Compiler
//
// Frame 1: full detailed prompt (characters + scene + key_element + camera + style)
// Frame 2: ONLY the change description (key_element_changed). The reference image
//          from frame 1 already contains everything else.
// ---------------------------------------------------------------------------

function clean(s: string): string {
  return (s || "").trim().replace(/\.\s*$/, "").replace(/\.{2,}/g, ".");
}

function compileFirstFramePrompt(scene: SceneState): string {
  return [
    clean(scene.characters),
    clean(scene.scene),
    clean(scene.key_element_normal),
    clean(scene.camera),
    "ultra-realistic, cinematic lighting, sharp focus, natural colors, 9:16 vertical",
  ].join(", ") + ".";
}

function compileEndFrameEditPrompt(scene: SceneState): string {
  return `edit only the specific object: ${clean(scene.key_element_changed)}, ${clean(scene.reaction_change)}, keep all people, background, lighting, camera exactly the same.`;
}

function buildVideoPrompt(scene: SceneState, timeline: ActionTimeline, style: string): string {
  const actions = timeline.timeline.map((t) => t.action).join(", then ");
  return [
    `${clean(scene.characters)}, ${clean(scene.scene)}.`,
    `${clean(scene.state_change_description)}.`,
    `Slow cinematic motion: ${actions}.`,
    `${clean(timeline.video_motion_description)}.`,
    `Locked camera, single continuous shot, vertical 9:16, ${clean(style)}.`,
    `End at peak tension before resolution.`,
  ].join(" ");
}

function buildNegativePrompt(scene: SceneState): string {
  return [
    "different people", "different positions", "different number of people",
    "identity change", "pose change", "lighting change", "environment change",
    "camera movement", "zoom", "pan", "tilt",
    "deformed hands", "extra fingers", "extra limbs",
    "blur", "artifacts", "distortion", "low quality",
    "text", "subtitles", "watermark", "logo",
    "outcome revealed", "result shown",
    ...(scene.forbidden || []),
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Post-Frame QA
// ---------------------------------------------------------------------------

export type FrameQAScore = {
  has_two_options: boolean;
  has_instability_or_tension: boolean;
  subject_matches: boolean;
  no_contact: boolean;
  overall_pass: boolean;
  description: string;
};

export async function scoreGeneratedFrame(
  imageUrl: string,
  scene: SceneState,
  phase: "setup" | "options_reveal",
): Promise<FrameQAScore> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    return { has_two_options: true, has_instability_or_tension: true, subject_matches: true, no_contact: true, overall_pass: true, description: "QA skipped" };
  }

  try {
    const client = new OpenAI({ apiKey });
    const keyEl = phase === "setup" ? scene.key_element_normal : scene.key_element_changed;
    const expected = `${scene.characters}, ${scene.scene}, ${keyEl}`;

    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Score this AI-generated frame. Return ONLY JSON:
{
  "has_two_options": true/false,
  "has_instability_or_tension": true/false,
  "subject_matches": true/false,
  "no_contact": true/false,
  "description": "1-2 sentence description"
}`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Phase: ${phase}. Expected: ${expected}` },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
          ],
        },
      ],
      max_tokens: 200,
    });

    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}") as FrameQAScore;
    parsed.overall_pass = parsed.subject_matches !== false;
    console.log(`[frame-qa] phase=${phase} pass=${parsed.overall_pass} desc="${parsed.description?.slice(0, 80)}"`);
    return parsed;
  } catch (err: unknown) {
    console.error("[frame-qa] failed:", (err as Error)?.message);
    return { has_two_options: true, has_instability_or_tension: true, subject_matches: true, no_contact: true, overall_pass: true, description: "QA error fallback" };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function planScene(input: {
  sceneSetupPrompt: string;
  plotPrompt: string;
  style: string;
  durationSeconds: number;
}): Promise<ScenePlanResult> {
  const llmOutput = await designScene(input.sceneSetupPrompt, input.plotPrompt);

  const sceneState: SceneState = llmOutput
    ? {
        ...llmOutput,
        forbidden: ["outcome revealed", "decision completed", "result shown"],
        subject: llmOutput.characters?.split(",")[0] || "the subject",
        reaction_change: llmOutput.reaction_change || "no visible reaction",
        detailed_scene_prompt: `${llmOutput.characters}, ${llmOutput.scene}, ${llmOutput.key_element_normal}`,
        event_phrase: llmOutput.state_change_description,
        setup_description: llmOutput.key_element_normal?.split(",")[0] || "calm scene",
        tension_description: llmOutput.state_change_description,
        scene_description: llmOutput.scene,
      }
    : {
        scene: "well-lit room, wooden table, warm afternoon light from left, beige walls",
        characters: "one person, 30s, dark hair, blue shirt, standing center, hands at sides",
        camera: "eye-level, medium, centered, 50mm lens",
        key_element_normal: "two sealed wooden boxes on table, left and right, both closed, brown wood",
        key_element_changed: "left box lid slightly ajar with faint glow inside, right box still sealed",
        reaction_change: "no visible reaction",
        state_change_description: "left box slowly opens, faint glow appears — which is the right choice?",
        option_a: "glowing left box is valuable",
        option_b: "sealed right box was better",
        unresolved_question: "Which box is the right choice?",
        outcomes: ["Left wins", "Right wins", "Both empty"],
        allowed_actions: ["glances at left box", "shifts weight", "looks at right box"],
        forbidden: ["outcome revealed", "decision completed", "result shown"],
        video_motion: "Still scene to realization as left box opens",
        subject: "one person",
        detailed_scene_prompt: "one person standing in well-lit room with two sealed boxes",
        event_phrase: "left box begins to open",
        setup_description: "two sealed boxes",
        tension_description: "left box begins to open",
        scene_description: "well-lit room, warm afternoon light",
      };

  const timeline = await planTimeline(sceneState, input.durationSeconds);

  const firstFramePrompt = compileFirstFramePrompt(sceneState);
  const endFramePrompt = compileEndFrameEditPrompt(sceneState);
  const truncatedStyle = input.style.split(/,\s*/).slice(0, 3).join(", ");
  const videoPrompt = buildVideoPrompt(sceneState, timeline, truncatedStyle);
  const negativePrompt = buildNegativePrompt(sceneState);

  console.log("[scene-planner] prompts built", {
    firstWords: firstFramePrompt.split(/\s+/).length,
    endWords: endFramePrompt.split(/\s+/).length,
    first: firstFramePrompt,
    end: endFramePrompt,
  });

  return { sceneState, timeline, firstFramePrompt, endFramePrompt, videoPrompt, negativePrompt };
}
