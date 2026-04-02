/**
 * Vision extractor: sends sampled frames to GPT-4o for structured scene extraction.
 * Returns observed facts (characters, objects, environment, camera, text, dialogue).
 */

import type { SampledFrame, ObservedFacts, ExtractionWarning } from "./types";
import { observedFactsSchema } from "./types";
import { FRAME_EXTRACTION_SYSTEM, buildFrameExtractionUserMessage } from "./prompts";
import { log } from "./utils";

const VISION_MODEL = process.env.LLM_MODEL_VISION || process.env.LLM_MODEL_ANALYSIS || process.env.LLM_MODEL || "gpt-4o-mini";
const MAX_FRAMES_PER_CALL = 8;

export async function extractObservedFacts(
  frames: SampledFrame[],
): Promise<{ observed: ObservedFacts; warnings: ExtractionWarning[] }> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    throw new Error("LLM not configured (need LLM_API_KEY + LLM_PROVIDER=openai)");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const selectedFrames = frames.length > MAX_FRAMES_PER_CALL
    ? selectKeyFrames(frames, MAX_FRAMES_PER_CALL)
    : frames;

  const imageMessages = selectedFrames.map((f) => ({
    type: "image_url" as const,
    image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: "low" as const },
  }));

  log("vision", "extracting", { frameCount: selectedFrames.length, model: VISION_MODEL });

  const res = await client.chat.completions.create({
    model: VISION_MODEL,
    response_format: { type: "json_object" },
    max_tokens: 4000,
    temperature: 0.1,
    messages: [
      { role: "system", content: FRAME_EXTRACTION_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: buildFrameExtractionUserMessage(selectedFrames.length) },
          ...imageMessages,
        ],
      },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim();
  log("vision", "response", {
    tokens: res.usage?.total_tokens ?? 0,
    length: raw?.length ?? 0,
  });

  if (!raw) throw new Error("Empty response from vision model");

  const warnings: ExtractionWarning[] = [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Vision model returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const result = observedFactsSchema.safeParse(normalizeObservedKeys(parsed));
  if (!result.success) {
    warnings.push({
      type: "schema_validation",
      message: `Observed facts partial parse: ${result.error.issues.map((i) => i.message).join("; ").slice(0, 300)}`,
      severity: "medium",
    });
    return { observed: buildSafeObservedFacts(parsed), warnings };
  }

  return { observed: result.data, warnings };
}

function selectKeyFrames(frames: SampledFrame[], maxCount: number): SampledFrame[] {
  if (frames.length <= maxCount) return frames;
  const result: SampledFrame[] = [frames[0]];
  const step = (frames.length - 1) / (maxCount - 1);
  for (let i = 1; i < maxCount - 1; i++) {
    result.push(frames[Math.round(i * step)]);
  }
  result.push(frames[frames.length - 1]);
  return result;
}

function normalizeObservedKeys(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    characters: raw.characters ?? [],
    objects: raw.objects ?? [],
    environment: raw.environment ?? { settingTags: [] },
    actions: raw.actions ?? [],
    storyBeats: raw.storyBeats ?? raw.story_beats ?? [],
    availableOptions: raw.availableOptions ?? raw.available_options ?? [],
    dialogueLines: raw.dialogueLines ?? raw.dialogue_lines ?? [],
    visibleTexts: raw.visibleTexts ?? raw.visible_texts ?? [],
    camera: raw.camera ?? {},
  };
}

function buildSafeObservedFacts(raw: Record<string, unknown>): ObservedFacts {
  const safe = normalizeObservedKeys(raw);
  return {
    characters: Array.isArray(safe.characters) ? safe.characters.map(coerceCharacter) : [],
    objects: Array.isArray(safe.objects) ? safe.objects.map(coerceObject) : [],
    environment: typeof safe.environment === "object" && safe.environment
      ? { settingTags: [], ...safe.environment } as ObservedFacts["environment"]
      : { settingTags: [] },
    actions: Array.isArray(safe.actions) ? safe.actions as ObservedFacts["actions"] : [],
    storyBeats: [],
    availableOptions: Array.isArray(safe.availableOptions) ? safe.availableOptions.map(coerceOption) : [],
    dialogueLines: Array.isArray(safe.dialogueLines) ? safe.dialogueLines as ObservedFacts["dialogueLines"] : [],
    visibleTexts: Array.isArray(safe.visibleTexts) ? safe.visibleTexts as ObservedFacts["visibleTexts"] : [],
    camera: typeof safe.camera === "object" && safe.camera ? safe.camera as ObservedFacts["camera"] : {},
  };
}

function coerceCharacter(c: unknown): ObservedFacts["characters"][number] {
  if (typeof c !== "object" || !c) return { characterId: "char_unknown", label: "unknown" };
  const o = c as Record<string, unknown>;
  return {
    characterId: String(o.characterId ?? o.character_id ?? `char_${Math.random().toString(36).slice(2, 6)}`),
    label: String(o.label ?? "person"),
    ...(o.ageGroup || o.age_group ? { ageGroup: String(o.ageGroup ?? o.age_group) as "unknown" } : {}),
    ...(o.dominantEmotion || o.dominant_emotion ? { dominantEmotion: String(o.dominantEmotion ?? o.dominant_emotion) } : {}),
    ...(o.clothingTop || o.clothing_top ? { clothingTop: String(o.clothingTop ?? o.clothing_top) } : {}),
    ...(o.clothingBottom || o.clothing_bottom ? { clothingBottom: String(o.clothingBottom ?? o.clothing_bottom) } : {}),
    ...(o.confidence ? { confidence: Number(o.confidence) } : {}),
  };
}

function coerceOption(opt: unknown): ObservedFacts["availableOptions"][number] {
  if (typeof opt !== "object" || !opt) return { optionId: "opt_unknown", category: "action_choice", label: "unknown", source: "inferred_from_context" };
  const o = opt as Record<string, unknown>;
  return {
    optionId: String(o.optionId ?? o.option_id ?? `opt_${Math.random().toString(36).slice(2, 6)}`),
    category: String(o.category ?? "action_choice") as "action_choice",
    label: String(o.label ?? ""),
    ...(o.objectId ?? o.object_id ? { objectId: String(o.objectId ?? o.object_id) } : {}),
    ...(o.priceIfVisible ?? o.price_if_visible ? { priceIfVisible: String(o.priceIfVisible ?? o.price_if_visible) } : {}),
    source: String(o.source ?? "inferred_from_context") as "visible" | "inferred_from_context",
    ...(typeof o.confidence === "number" ? { confidence: o.confidence } : {}),
  };
}

function coerceObject(obj: unknown): ObservedFacts["objects"][number] {
  if (typeof obj !== "object" || !obj) return { objectId: "obj_unknown", label: "unknown", category: "other" };
  const o = obj as Record<string, unknown>;
  return {
    objectId: String(o.objectId ?? o.object_id ?? `obj_${Math.random().toString(36).slice(2, 6)}`),
    label: String(o.label ?? "object"),
    category: (o.category as "other") ?? "other",
    ...(o.brandOrTextVisible || o.brand_text_visible ? { brandOrTextVisible: String(o.brandOrTextVisible ?? o.brand_text_visible) } : {}),
    ...(o.state ? { state: String(o.state) } : {}),
    ...(o.color ? { color: String(o.color) } : {}),
    ...(o.priceIfVisible || o.price_if_visible ? { priceIfVisible: String(o.priceIfVisible ?? o.price_if_visible) } : {}),
    ...(o.confidence ? { confidence: Number(o.confidence) } : {}),
  };
}
