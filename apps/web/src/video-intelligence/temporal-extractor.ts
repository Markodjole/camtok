/**
 * Temporal extractor: analyzes ordered observations from vision pass
 * to extract actions, story beats, intents, options, and continuation features.
 */

import type {
  ObservedFacts,
  InferredSignals,
  DerivedFeatures,
  ExtractionWarning,
  ExtractionScore,
  ActionEvent,
  StoryBeat,
  AvailableOption,
} from "./types";
import { TEMPORAL_EXTRACTION_SYSTEM, buildTemporalUserMessage } from "./prompts";
import { log } from "./utils";

const TEMPORAL_MODEL = process.env.LLM_MODEL_TEMPORAL || process.env.LLM_MODEL_ANALYSIS || process.env.LLM_MODEL || "gpt-4o-mini";

interface TemporalResult {
  actions: ActionEvent[];
  storyBeats: StoryBeat[];
  availableOptions: AvailableOption[];
  inferred: InferredSignals;
  derived: DerivedFeatures;
  score: ExtractionScore;
  warnings: ExtractionWarning[];
}

export async function extractTemporalFeatures(
  observed: ObservedFacts,
): Promise<TemporalResult> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    throw new Error("LLM not configured");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const observedJson = JSON.stringify(observed, null, 1);
  log("temporal", "extracting", { observedLength: observedJson.length, model: TEMPORAL_MODEL });

  const res = await client.chat.completions.create({
    model: TEMPORAL_MODEL,
    response_format: { type: "json_object" },
    max_tokens: 4000,
    temperature: 0.15,
    messages: [
      { role: "system", content: TEMPORAL_EXTRACTION_SYSTEM },
      { role: "user", content: buildTemporalUserMessage(observedJson) },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim();
  log("temporal", "response", {
    tokens: res.usage?.total_tokens ?? 0,
    length: raw?.length ?? 0,
  });

  if (!raw) throw new Error("Empty response from temporal model");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Temporal model returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const warnings: ExtractionWarning[] = [];

  const actions = normalizeActions(parsed.actions);
  const storyBeats = normalizeStoryBeats(parsed.storyBeats ?? parsed.story_beats);
  const availableOptions = normalizeOptions(parsed.availableOptions ?? parsed.available_options);

  const inferred = normalizeInferred(parsed);
  const derived = normalizeDerived(parsed);
  const score = normalizeScore(parsed.score);

  if (!inferred.mainStory) {
    warnings.push({ type: "missing_main_story", message: "Could not determine main story", severity: "high" });
  }
  if (derived.nextStepCandidates.length === 0) {
    warnings.push({ type: "no_next_steps", message: "No next step candidates generated", severity: "medium" });
  }

  return { actions, storyBeats, availableOptions, inferred, derived, score, warnings };
}

function normalizeActions(raw: unknown): ActionEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a: Record<string, unknown>, i) => ({
    actionId: String(a.actionId ?? a.action_id ?? `act_${i + 1}`),
    actorId: a.actorId ?? a.actor_id ? String(a.actorId ?? a.actor_id) : undefined,
    targetObjectId: a.targetObjectId ?? a.target_object_id ? String(a.targetObjectId ?? a.target_object_id) : undefined,
    targetCharacterId: a.targetCharacterId ?? a.target_character_id ? String(a.targetCharacterId ?? a.target_character_id) : undefined,
    actionType: String(a.actionType ?? a.action_type ?? "unknown"),
    actionPhase: (a.actionPhase ?? a.action_phase) as ActionEvent["actionPhase"],
    result: a.result ? String(a.result) : undefined,
    confidence: typeof a.confidence === "number" ? a.confidence : undefined,
  }));
}

function normalizeStoryBeats(raw: unknown): StoryBeat[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b: Record<string, unknown>, i) => ({
    beatIndex: typeof b.beatIndex === "number" ? b.beatIndex : (typeof b.beat_index === "number" ? b.beat_index : i),
    beatType: String(b.beatType ?? b.beat_type ?? "attempt") as StoryBeat["beatType"],
    summary: String(b.summary ?? ""),
    involvedCharacterIds: Array.isArray(b.involvedCharacterIds ?? b.involved_character_ids)
      ? (b.involvedCharacterIds ?? b.involved_character_ids) as string[] : [],
    involvedObjectIds: Array.isArray(b.involvedObjectIds ?? b.involved_object_ids)
      ? (b.involvedObjectIds ?? b.involved_object_ids) as string[] : [],
  }));
}

function normalizeOptions(raw: unknown): AvailableOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o: Record<string, unknown>, i) => ({
    optionId: String(o.optionId ?? o.option_id ?? `opt_${i + 1}`),
    category: String(o.category ?? "action_choice") as AvailableOption["category"],
    label: String(o.label ?? ""),
    ...(o.objectId ?? o.object_id ? { objectId: String(o.objectId ?? o.object_id) } : {}),
    ...(o.priceIfVisible ?? o.price_if_visible ? { priceIfVisible: String(o.priceIfVisible ?? o.price_if_visible) } : {}),
    source: String(o.source ?? "inferred_from_context") as AvailableOption["source"],
    confidence: typeof o.confidence === "number" ? o.confidence : undefined,
  }));
}

function normalizeInferred(parsed: Record<string, unknown>): InferredSignals {
  const intents = parsed.characterIntents ?? parsed.character_intents;
  const prefs = parsed.preferenceSignals ?? parsed.preference_signals;
  return {
    characterIntents: Array.isArray(intents) ? intents.map((i: Record<string, unknown>) => ({
      characterId: String(i.characterId ?? i.character_id ?? ""),
      primaryIntent: i.primaryIntent ?? i.primary_intent ? String(i.primaryIntent ?? i.primary_intent) : undefined,
      secondaryIntents: Array.isArray(i.secondaryIntents ?? i.secondary_intents) ? (i.secondaryIntents ?? i.secondary_intents) as string[] : undefined,
      evidence: Array.isArray(i.evidence) ? i.evidence as string[] : [],
      confidence: typeof i.confidence === "number" ? i.confidence : undefined,
    })) : [],
    preferenceSignals: Array.isArray(prefs) ? prefs.map((p: Record<string, unknown>) => ({
      characterId: String(p.characterId ?? p.character_id ?? ""),
      domain: String(p.domain ?? "other") as "other",
      value: String(p.value ?? ""),
      basis: String(p.basis ?? "visible_reaction") as "visible_reaction",
      strength: typeof p.strength === "number" ? p.strength : 0.5,
    })) : [],
    mainStory: String(parsed.mainStory ?? parsed.main_story ?? ""),
    currentStateSummary: String(parsed.currentStateSummary ?? parsed.current_state_summary ?? ""),
    unresolvedQuestions: Array.isArray(parsed.unresolvedQuestions ?? parsed.unresolved_questions)
      ? (parsed.unresolvedQuestions ?? parsed.unresolved_questions) as string[] : [],
  };
}

function normalizeDerived(parsed: Record<string, unknown>): DerivedFeatures {
  const anchors = (parsed.continuityAnchors ?? parsed.continuity_anchors ?? {}) as Record<string, unknown>;
  const nexts = parsed.nextStepCandidates ?? parsed.next_step_candidates;
  return {
    continuityAnchors: {
      characterAppearance: toStringArray(anchors.characterAppearance ?? anchors.character_appearance),
      wardrobe: toStringArray(anchors.wardrobe),
      environment: toStringArray(anchors.environment),
      objectStates: toStringArray(anchors.objectStates ?? anchors.object_states),
      cameraStyle: toStringArray(anchors.cameraStyle ?? anchors.camera_style),
    },
    nextStepCandidates: Array.isArray(nexts) ? nexts.map((n: Record<string, unknown>, i) => ({
      candidateId: String(n.candidateId ?? n.candidate_id ?? `next_${i + 1}`),
      label: String(n.label ?? ""),
      rationale: String(n.rationale ?? ""),
      probabilityScore: typeof n.probabilityScore === "number" ? n.probabilityScore
        : (typeof n.probability_score === "number" ? n.probability_score : 0.5),
      basedOn: Array.isArray(n.basedOn ?? n.based_on) ? (n.basedOn ?? n.based_on) as string[] : [],
    })) : [],
    spokenDialogue: typeof parsed.spokenDialogue === "string" ? parsed.spokenDialogue
      : (typeof parsed.spoken_dialogue === "string" ? parsed.spoken_dialogue : null),
  };
}

function normalizeScore(raw: unknown): ExtractionScore {
  if (typeof raw !== "object" || !raw) {
    return { entityConsistency: 0.5, textReadability: 0.5, actionClarity: 0.5, storyClarity: 0.5, continuationReadiness: 0.5 };
  }
  const s = raw as Record<string, unknown>;
  const n = (key: string, fallback: string) =>
    typeof s[key] === "number" ? (s[key] as number)
    : (typeof s[fallback] === "number" ? (s[fallback] as number) : 0.5);
  return {
    entityConsistency: n("entityConsistency", "entity_consistency"),
    textReadability: n("textReadability", "text_readability"),
    actionClarity: n("actionClarity", "action_clarity"),
    storyClarity: n("storyClarity", "story_clarity"),
    continuationReadiness: n("continuationReadiness", "continuation_readiness"),
  };
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return [];
}
