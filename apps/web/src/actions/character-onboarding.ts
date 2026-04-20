"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  analyzeCharacterImage,
  createCustomCharacter,
  updateUserCharacter,
} from "@/actions/characters";
import type { BettingSignals } from "@/lib/characters/types";

export type OnboardingMiniGameKey =
  | "snack_aisle"
  | "crosswalk"
  | "party_invite"
  | "group_project"
  | "return_policy"
  | "weekend_plan";

export type CharacterOnboardingDraft = {
  step?: number;
  characterName?: string;
  tagline?: string;
  backstory?: string;
  entityType?: "pedestrian" | "bike" | "car" | "other";
  cityZone?: string;
  preferredHours?: string;
  visualStyle?: string;
  recurringStoryElements?: string;
  maxMissionRadiusMeters?: string;
  safetyForbiddenZones?: string;
  /** Slugs of platform characters the user feels closest to (archetype hints). */
  favoriteCharacterSlugs?: string[];
  foodLikes?: string;
  foodDislikes?: string;
  activityLikes?: string;
  activityDislikes?: string;
  brandLikes?: string;
  brandDislikes?: string;
  shoppingStyle?: string;
  speakingTone?: string;
  vocabulary?: string;
  catchphrases?: string;
  primaryImagePath?: string;
  extraImagePaths?: string[];
  introVideoPath?: string | null;
  miniGame?: Partial<Record<OnboardingMiniGameKey, "a" | "b">>;
};

const EMPTY_SIGNALS: BettingSignals = {
  quick_read: [],
  choice_patterns: {},
  behavior_patterns: {},
  exploitable_tendencies: [],
  context_modifiers: {},
};

function splitList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function defaultPhysicalBehavior() {
  return {
    energy_level: "medium — matches how they describe day-to-day pace",
    movement_style: "natural, unforced; grounded in their real comfort zones",
    posture: "relaxed upright",
    typical_gestures: ["occasional open-hand emphasis when deciding"],
    walking_pace: "average",
    emotional_expressiveness: "moderate — matches self-reported tone",
    comfort_zone: ["familiar routines", "places where they feel socially safe"],
    behavioral_red_flags: [],
  };
}

function clamp01(n: number) {
  return Math.max(0.08, Math.min(0.92, n));
}

function heuristicCore(draft: CharacterOnboardingDraft) {
  const mg = draft.miniGame ?? {};
  let openness = 0.52;
  let conscientiousness = 0.52;
  let extraversion = 0.52;
  let agreeableness = 0.55;
  let neuroticism = 0.45;

  if (mg.snack_aisle === "a") {
    openness -= 0.06;
    conscientiousness += 0.05;
  } else if (mg.snack_aisle === "b") {
    openness += 0.12;
  }
  if (mg.crosswalk === "a") {
    extraversion += 0.06;
    conscientiousness -= 0.05;
    neuroticism += 0.04;
  } else if (mg.crosswalk === "b") {
    conscientiousness += 0.1;
    neuroticism -= 0.04;
  }
  if (mg.party_invite === "a") {
    extraversion += 0.12;
    agreeableness += 0.04;
  } else if (mg.party_invite === "b") {
    extraversion -= 0.1;
    openness -= 0.04;
  }
  if (mg.group_project === "a") {
    agreeableness += 0.08;
    conscientiousness += 0.06;
  } else if (mg.group_project === "b") {
    conscientiousness -= 0.06;
    agreeableness -= 0.05;
  }
  if (mg.return_policy === "a") {
    conscientiousness += 0.08;
    neuroticism += 0.05;
  } else if (mg.return_policy === "b") {
    conscientiousness -= 0.06;
    neuroticism -= 0.04;
  }
  if (mg.weekend_plan === "a") {
    openness += 0.08;
    extraversion += 0.06;
  } else if (mg.weekend_plan === "b") {
    conscientiousness += 0.06;
    extraversion -= 0.05;
  }

  const big_five = {
    openness: clamp01(openness),
    conscientiousness: clamp01(conscientiousness),
    extraversion: clamp01(extraversion),
    agreeableness: clamp01(agreeableness),
    neuroticism: clamp01(neuroticism),
  };

  const temperament =
    big_five.extraversion > 0.62
      ? "outward-facing, energized by people and novelty"
      : "reserved, recharges alone, selective with social energy";

  const decision_style =
    big_five.conscientiousness > 0.58
      ? "structured — prefers a plan before committing"
      : "adaptive — comfortable deciding in the moment";

  const risk_appetite =
    big_five.openness > 0.58 && big_five.neuroticism < 0.52
      ? "curious risk-taker on small stakes"
      : "cautious — prefers predictable outcomes";

  const social_style =
    big_five.extraversion > 0.58
      ? "direct, expressive, likes being in the mix"
      : "observant first, speaks when it matters";

  const under_pressure =
    big_five.neuroticism > 0.55
      ? "more self-conscious under scrutiny, double-checks choices"
      : "steady under pressure, keeps perspective";

  const attention_span =
    big_five.conscientiousness > 0.58
      ? "can sustain focus when the goal is clear"
      : "shifts attention quickly when bored";

  const personality = {
    big_five,
    temperament,
    decision_style,
    risk_appetite,
    social_style,
    under_pressure,
    attention_span,
    physical_behavior: defaultPhysicalBehavior(),
  };

  const preferences = {
    food: { likes: splitList(draft.foodLikes), dislikes: splitList(draft.foodDislikes) },
    activities: { likes: splitList(draft.activityLikes), dislikes: splitList(draft.activityDislikes) },
    brands: { likes: splitList(draft.brandLikes), dislikes: splitList(draft.brandDislikes) },
    shopping: draft.shoppingStyle?.trim() || "practical — mixes habit with occasional splurges",
    general_tendencies: [
      ...(draft.favoriteCharacterSlugs?.length
        ? [`Resonates with archetypes: ${draft.favoriteCharacterSlugs.join(", ")}`]
        : []),
      "Behavior distilled from onboarding choices + self-report (refine with real clips over time).",
    ],
  };

  const voice = {
    tone: draft.speakingTone?.trim() || "authentic, conversational",
    vocabulary: draft.vocabulary?.trim() || "everyday language",
    catchphrases: splitList(draft.catchphrases).slice(0, 6),
  };

  const betting_signals: BettingSignals = {
    quick_read: [
      `${decision_style.split("—")[0].trim()} on everyday choices (~${Math.round(big_five.conscientiousness * 100)}% weighted)`,
      `${social_style.split(",")[0]} (~${Math.round(big_five.extraversion * 100)}%)`,
      `${risk_appetite} (~${Math.round(big_five.openness * 50 + big_five.neuroticism * 50)}% blend)`,
    ],
    choice_patterns: {
      familiar_option: clamp01(0.35 + (1 - big_five.openness) * 0.35),
      novel_option: clamp01(0.2 + big_five.openness * 0.45),
      value_option: clamp01(0.25 + big_five.conscientiousness * 0.35),
      flashy_option: clamp01(0.15 + big_five.extraversion * 0.25),
    },
    behavior_patterns: {
      impulse_grab: clamp01(0.25 + (1 - big_five.conscientiousness) * 0.35 + big_five.extraversion * 0.15),
      compares_options: clamp01(0.2 + big_five.conscientiousness * 0.45),
      walks_away: clamp01(0.08 + big_five.neuroticism * 0.25),
      asks_for_help: clamp01(0.1 + (1 - big_five.extraversion) * 0.2 + big_five.agreeableness * 0.15),
    },
    exploitable_tendencies: [
      ...(big_five.conscientiousness < 0.45 ? ["May underweight fine print when excited"] : []),
      ...(big_five.extraversion > 0.65 ? ["Social proof and hype nudge decisions"] : []),
      ...(big_five.neuroticism > 0.58 ? ["Avoidance kicks in when choices feel high-stakes"] : []),
    ],
    context_modifiers: {
      under_time_pressure: {
        impulse_grab: clamp01(0.35 + (1 - big_five.conscientiousness) * 0.35),
        compares_options: clamp01(0.05 + big_five.conscientiousness * 0.25),
      },
      casual_quick_choice_moment: {
        impulse_grab: clamp01(0.3 + big_five.extraversion * 0.2),
        novel_option: clamp01(0.2 + big_five.openness * 0.25),
      },
    },
  };

  return { personality, preferences, voice, betting_signals };
}

async function llmRefine(params: {
  draft: CharacterOnboardingDraft;
  appearance: Record<string, unknown>;
  heuristic: {
    personality: Record<string, unknown>;
    preferences: Record<string, unknown>;
    voice: Record<string, unknown>;
    betting_signals: BettingSignals;
  };
}): Promise<{
  personality: Record<string, unknown>;
  preferences: Record<string, unknown>;
  voice: Record<string, unknown>;
  betting_signals: BettingSignals;
} | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.35,
    messages: [
      {
        role: "system",
        content: `You unify real-user onboarding into the SAME structured JSON our fictional characters use for video + betting AI.

Return JSON ONLY with keys:
{
  "personality": { ...full CharacterPersonality shape as JSON... },
  "preferences": { food: {likes,dislikes}, activities: {likes,dislikes}, brands: {likes,dislikes}, shopping: string, general_tendencies: string[] },
  "voice": { tone, vocabulary, catchphrases: string[] },
  "betting_signals": {
    "quick_read": string[],
    "choice_patterns": Record<string, number>,
    "behavior_patterns": Record<string, number>,
    "exploitable_tendencies": string[],
    "context_modifiers": Record<string, Record<string, number>>
  }
}

Rules:
- personality.physical_behavior MUST exist with keys: energy_level, movement_style, posture, typical_gestures[], walking_pace, emotional_expressiveness, comfort_zone[], behavioral_red_flags[].
- Keep arrays reasonably short (≤8 strings each).
- betting_signals numeric values are 0-1 probabilities (not percentages).
- Merge the user's self-report with the heuristic baseline; prefer user text when it conflicts.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          draft: params.draft,
          vision_appearance: params.appearance,
          heuristic_baseline: params.heuristic,
        }),
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      personality?: Record<string, unknown>;
      preferences?: Record<string, unknown>;
      voice?: Record<string, unknown>;
      betting_signals?: BettingSignals;
    };
    if (!parsed.personality || !parsed.preferences || !parsed.voice || !parsed.betting_signals) return null;
    return {
      personality: parsed.personality,
      preferences: parsed.preferences,
      voice: parsed.voice,
      betting_signals: parsed.betting_signals ?? EMPTY_SIGNALS,
    };
  } catch {
    return null;
  }
}

export async function getCharacterOnboardingState(): Promise<
  | { authenticated: false }
  | {
      authenticated: true;
      completed: boolean;
      primaryCharacterId: string | null;
      draft: CharacterOnboardingDraft;
      displayName: string | null;
      username: string | null;
    }
> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { authenticated: false };

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "character_onboarding_completed_at, primary_character_id, character_onboarding_draft, display_name, username",
    )
    .eq("id", user.id)
    .maybeSingle();

  const draft = (profile?.character_onboarding_draft ?? {}) as CharacterOnboardingDraft;

  return {
    authenticated: true,
    completed: !!profile?.character_onboarding_completed_at,
    primaryCharacterId: profile?.primary_character_id ?? null,
    draft,
    displayName: profile?.display_name ?? null,
    username: profile?.username ?? null,
  };
}

export async function saveCharacterOnboardingDraft(
  draft: CharacterOnboardingDraft,
): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const merged = { ...draft, updated_at: new Date().toISOString() };
  const { error } = await supabase
    .from("profiles")
    .update({ character_onboarding_draft: merged as never })
    .eq("id", user.id);

  if (error) return { error: error.message };
  return {};
}

async function replaceReferenceImages(
  serviceClient: Awaited<ReturnType<typeof createServiceClient>>,
  characterId: string,
  primaryPath: string,
  extras: string[],
) {
  await serviceClient.from("character_reference_images").delete().eq("character_id", characterId);

  const rows = [
    {
      character_id: characterId,
      image_storage_path: primaryPath,
      angle: "front",
      is_primary: true,
      description: "Primary reference (onboarding)",
      sort_order: 0,
    },
    ...extras.map((path, i) => ({
      character_id: characterId,
      image_storage_path: path,
      angle: `extra_${i + 1}`,
      is_primary: false,
      description: "Additional reference (onboarding)",
      sort_order: i + 1,
    })),
  ];
  await serviceClient.from("character_reference_images").insert(rows);
}

export async function finalizeCharacterOnboarding(input: {
  draft: CharacterOnboardingDraft;
  /** When true, update existing primary character instead of inserting another row. */
  updateExisting?: boolean;
}): Promise<{ error?: string; characterId?: string }> {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("primary_character_id, display_name, username")
    .eq("id", user.id)
    .maybeSingle();

  const draft = input.draft;
  const name =
    draft.characterName?.trim() ||
    profile?.display_name ||
    profile?.username ||
    "My character";

  if (!draft.primaryImagePath?.trim()) {
    return { error: "Add at least one reference photo to finish." };
  }

  const appearanceRes = await analyzeCharacterImage(draft.primaryImagePath.trim());
  const appearance =
    appearanceRes.appearance && typeof appearanceRes.appearance === "object"
      ? (appearanceRes.appearance as Record<string, unknown>)
      : {};

  const heuristic = heuristicCore(draft);
  const refined = await llmRefine({ draft, appearance, heuristic });
  const personality = refined?.personality ?? heuristic.personality;
  const preferences = refined?.preferences ?? heuristic.preferences;
  const voice = refined?.voice ?? heuristic.voice;
  const betting_signals = refined?.betting_signals ?? heuristic.betting_signals;

  const extras = (draft.extraImagePaths ?? []).filter(Boolean).slice(0, 8);
  const media: Record<string, unknown> = {};
  if (draft.introVideoPath?.trim()) {
    media.intro_video_path = draft.introVideoPath.trim();
  }
  if (extras.length) media.extra_image_paths = extras;

  const tagline = draft.tagline?.trim() || null;
  const backstory = draft.backstory?.trim() || null;
  const entityType = draft.entityType ?? "pedestrian";
  const maxMissionRadius =
    draft.maxMissionRadiusMeters && Number.isFinite(Number(draft.maxMissionRadiusMeters))
      ? Number(draft.maxMissionRadiusMeters)
      : null;
  const forbiddenZones = splitList(draft.safetyForbiddenZones).map((z) => ({ label: z }));
  const camtokContent = {
    bio: backstory ?? undefined,
    vibe_tags: splitList(draft.tagline),
    city_zone: draft.cityZone?.trim() || undefined,
    preferred_hours: splitList(draft.preferredHours),
    visual_style: draft.visualStyle?.trim() || undefined,
    recurring_story_elements: splitList(draft.recurringStoryElements),
    rivalries_history: [],
  };

  const primaryId = profile?.primary_character_id ?? null;
  const shouldUpdate = !!primaryId && !!input.updateExisting;

  let resultCharacterId: string | undefined;

  if (shouldUpdate && primaryId) {
    const upd = await updateUserCharacter(primaryId, {
      name,
      tagline,
      appearance,
      personality,
      preferences,
      backstory,
      voice,
      betting_signals,
      media,
      camtok_entity_type: entityType,
      camtok_active: true,
      camtok_content: camtokContent,
    });
    if (upd.error || !upd.character) return { error: upd.error ?? "Update failed" };

    await replaceReferenceImages(serviceClient, primaryId, draft.primaryImagePath.trim(), extras);

    await serviceClient
      .from("profiles")
      .update({
        primary_character_id: primaryId,
        character_onboarding_completed_at: new Date().toISOString(),
        character_onboarding_draft: {} as never,
      })
      .eq("id", user.id);

    await serviceClient.from("character_safety_profiles").upsert(
      {
        character_id: primaryId,
        maximum_mission_radius_meters: maxMissionRadius,
        forbidden_zones: forbiddenZones,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "character_id" },
    );

    resultCharacterId = primaryId;
  } else {
    const created = await createCustomCharacter({
      name,
      tagline: tagline ?? undefined,
      imageStoragePath: draft.primaryImagePath.trim(),
      appearance,
      personality,
      preferences,
      backstory: backstory ?? undefined,
      voice,
      betting_signals,
      media,
      camtok_entity_type: entityType,
      camtok_active: true,
      camtok_content: camtokContent,
      additionalImagePaths: extras.map((path) => ({ path })),
    });
    if (created.error || !created.character) {
      return { error: created.error ?? "Create failed" };
    }

    await serviceClient
      .from("profiles")
      .update({
        primary_character_id: created.character.id,
        character_onboarding_completed_at: new Date().toISOString(),
        character_onboarding_draft: {} as never,
      })
      .eq("id", user.id);

    await serviceClient.from("character_safety_profiles").upsert(
      {
        character_id: created.character.id,
        maximum_mission_radius_meters: maxMissionRadius,
        forbidden_zones: forbiddenZones,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "character_id" },
    );

    resultCharacterId = created.character.id;
  }

  revalidatePath("/live");
  revalidatePath("/profile");
  revalidatePath("/onboarding/character");
  return { characterId: resultCharacterId };
}
