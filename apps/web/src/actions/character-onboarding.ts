"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  analyzeCharacterImage,
  createCustomCharacter,
  updateUserCharacter,
} from "@/actions/characters";
import type { BettingSignals } from "@/lib/characters/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type OnboardingMiniGameKey =
  | "yellow_light"
  | "cut_off"
  | "gps_vs_shortcut"
  | "traffic_jam"
  | "missed_turn_react"
  | "speed_camera";

export type SpeedTendency = "always_legal" | "slightly_above" | "significantly_above" | "whatever";
export type OvertakingStyle = "never" | "when_safe" | "regularly" | "any_gap";
export type PatienceLevel = "very_patient" | "normal" | "gets_frustrated" | "road_rage";
export type RiskLevel = "ultra_careful" | "calculated" | "risk_taker" | "full_send";
export type VehicleStyle = "sporty" | "practical" | "flashy" | "beater";
export type RouteType = "city_center" | "suburbs" | "highway" | "mixed";
export type Transmission = "manual" | "automatic" | "na";

export type CharacterOnboardingDraft = {
  step?: number;
  // Step 0 – Driver identity
  characterName?: string;
  tagline?: string;
  backstory?: string;
  cityZone?: string;
  // Step 1 – Vehicle
  entityType?: "pedestrian" | "bike" | "scooter" | "car" | "motorcycle" | "other";
  vehicleStyle?: VehicleStyle;
  transmission?: Transmission;
  typicalRoutes?: RouteType;
  // Step 2 – Driving style
  speedTendency?: SpeedTendency;
  overtakingStyle?: OvertakingStyle;
  patienceLevel?: PatienceLevel;
  riskLevel?: RiskLevel;
  // Step 3 – Quick decisions mini-game
  miniGame?: Partial<Record<OnboardingMiniGameKey, "a" | "b">>;
  // Photo
  primaryImagePath?: string;
  extraImagePaths?: string[];
};

// ─── Constants ───────────────────────────────────────────────────────────────

const EMPTY_SIGNALS: BettingSignals = {
  quick_read: [],
  choice_patterns: {},
  behavior_patterns: {},
  exploitable_tendencies: [],
  context_modifiers: {},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 24);
}

function clamp01(n: number) {
  return Math.max(0.05, Math.min(0.95, n));
}

// ─── Heuristic core ──────────────────────────────────────────────────────────

function heuristicCore(draft: CharacterOnboardingDraft) {
  const mg = draft.miniGame ?? {};

  // --- Driving profile scores (0-1) ---
  let aggression = 0.4;       // How aggressive the driver is
  let patience = 0.6;         // How patient
  let riskAppetite = 0.4;     // How much risk they take
  let routeFlexibility = 0.5; // Adapts routes easily
  let ruleFollowing = 0.6;    // Follows traffic rules

  // Mini-game: yellow_light
  if (mg.yellow_light === "a") { ruleFollowing += 0.12; riskAppetite -= 0.06; }
  else if (mg.yellow_light === "b") { aggression += 0.1; riskAppetite += 0.12; ruleFollowing -= 0.1; }

  // Mini-game: cut_off
  if (mg.cut_off === "a") { patience += 0.1; aggression -= 0.08; }
  else if (mg.cut_off === "b") { aggression += 0.15; patience -= 0.1; }

  // Mini-game: gps_vs_shortcut
  if (mg.gps_vs_shortcut === "a") { ruleFollowing += 0.07; routeFlexibility -= 0.05; }
  else if (mg.gps_vs_shortcut === "b") { routeFlexibility += 0.15; ruleFollowing -= 0.05; }

  // Mini-game: traffic_jam
  if (mg.traffic_jam === "a") { patience += 0.12; routeFlexibility -= 0.06; }
  else if (mg.traffic_jam === "b") { patience -= 0.1; routeFlexibility += 0.12; aggression += 0.05; }

  // Mini-game: missed_turn_react
  if (mg.missed_turn_react === "a") { patience += 0.1; riskAppetite -= 0.05; }
  else if (mg.missed_turn_react === "b") { patience -= 0.12; riskAppetite += 0.08; aggression += 0.07; }

  // Mini-game: speed_camera
  if (mg.speed_camera === "a") { ruleFollowing += 0.1; riskAppetite -= 0.06; }
  else if (mg.speed_camera === "b") { ruleFollowing -= 0.08; riskAppetite += 0.08; }

  // Style selectors
  const speed = draft.speedTendency ?? "slightly_above";
  if (speed === "always_legal") { ruleFollowing += 0.1; riskAppetite -= 0.05; }
  else if (speed === "significantly_above") { riskAppetite += 0.12; ruleFollowing -= 0.08; aggression += 0.08; }
  else if (speed === "whatever") { riskAppetite += 0.18; ruleFollowing -= 0.15; aggression += 0.12; }

  const overtaking = draft.overtakingStyle ?? "when_safe";
  if (overtaking === "never") { patience += 0.08; riskAppetite -= 0.1; }
  else if (overtaking === "regularly") { aggression += 0.1; riskAppetite += 0.08; }
  else if (overtaking === "any_gap") { aggression += 0.2; riskAppetite += 0.15; patience -= 0.12; }

  const pat = draft.patienceLevel ?? "normal";
  if (pat === "very_patient") { patience += 0.15; aggression -= 0.1; }
  else if (pat === "gets_frustrated") { patience -= 0.12; aggression += 0.1; }
  else if (pat === "road_rage") { patience -= 0.25; aggression += 0.22; riskAppetite += 0.1; }

  const risk = draft.riskLevel ?? "calculated";
  if (risk === "ultra_careful") { riskAppetite -= 0.15; ruleFollowing += 0.1; }
  else if (risk === "risk_taker") { riskAppetite += 0.15; ruleFollowing -= 0.08; aggression += 0.06; }
  else if (risk === "full_send") { riskAppetite += 0.25; ruleFollowing -= 0.15; aggression += 0.15; }

  // Clamp all
  const dp = {
    aggression: clamp01(aggression),
    patience: clamp01(patience),
    risk_appetite: clamp01(riskAppetite),
    route_flexibility: clamp01(routeFlexibility),
    rule_following: clamp01(ruleFollowing),
  };

  // --- Build personality for character system ---
  const personality = {
    big_five: {
      openness: clamp01(0.35 + dp.route_flexibility * 0.45),
      conscientiousness: clamp01(0.3 + dp.rule_following * 0.55),
      extraversion: clamp01(0.3 + dp.aggression * 0.5),
      agreeableness: clamp01(0.7 - dp.aggression * 0.5),
      neuroticism: clamp01(0.2 + (1 - dp.patience) * 0.55),
    },
    temperament:
      dp.aggression > 0.6
        ? "assertive behind the wheel — moves with purpose and doesn't wait"
        : dp.patience > 0.65
          ? "calm driver — low stress, let the road come to them"
          : "composed most of the time, can spike under pressure",
    decision_style:
      dp.route_flexibility > 0.6
        ? "adaptive — switches routes instantly, treats a missed turn as a new adventure"
        : "methodical — plans the route, sticks to it, frustration when it breaks",
    risk_appetite:
      dp.risk_appetite > 0.65
        ? "elevated risk tolerance — shortcut through the junction, yellow means go"
        : dp.risk_appetite < 0.38
          ? "risk-averse — safety margin first, always"
          : "calculated risk-taker — reads the situation before committing",
    social_style:
      dp.aggression > 0.55
        ? "expressive driver — honks, gestures, makes their presence known"
        : "passive — avoids confrontation on the road",
    under_pressure:
      dp.patience < 0.4
        ? "escalates quickly under road stress — rushed decisions, erratic moves"
        : "handles pressure steadily — keeps composure even in traffic",
    attention_span:
      dp.route_flexibility > 0.55
        ? "high road awareness — spots gaps, shortcuts, alternative routes on the fly"
        : "focused on planned route — less situational scanning",
    driving_profile: dp,
    physical_behavior: {
      energy_level:
        dp.aggression > 0.6 ? "high — impatient, always moving" : "medium — steady pace",
      movement_style:
        dp.risk_appetite > 0.6 ? "sharp, decisive movements" : "smooth, predictable",
      posture: dp.aggression > 0.55 ? "leaning forward, hands gripping" : "relaxed upright",
      typical_gestures: dp.aggression > 0.5 ? ["steering corrections", "expressive hand signals"] : ["minimal gestures", "calm adjustments"],
      walking_pace: dp.aggression > 0.6 ? "fast" : "average",
      emotional_expressiveness: dp.aggression > 0.55 ? "high" : "moderate",
      comfort_zone: ["familiar routes", "city navigation", "local shortcuts"],
      behavioral_red_flags:
        dp.patience < 0.35
          ? ["impatient gap-forcing", "late braking", "reactive lane changes"]
          : [],
    },
  };

  // --- Betting signals for the market AI ---
  const betting_signals: BettingSignals = {
    quick_read: [
      `${personality.decision_style.split("—")[0].trim()} (~${Math.round(dp.route_flexibility * 100)}% flexibility)`,
      `${dp.patience > 0.55 ? "patient" : "impatient"} under traffic pressure (~${Math.round(dp.patience * 100)}%)`,
      `${personality.risk_appetite.split("—")[0].trim()} (~${Math.round(dp.risk_appetite * 100)}%)`,
    ],
    choice_patterns: {
      take_the_turn: clamp01(0.25 + dp.aggression * 0.4 + dp.route_flexibility * 0.2),
      continue_straight: clamp01(0.3 + dp.rule_following * 0.35 + dp.patience * 0.2),
      slow_down_stop: clamp01(0.1 + (1 - dp.risk_appetite) * 0.35 + dp.patience * 0.15),
      sharp_maneuver: clamp01(0.1 + dp.aggression * 0.35 + dp.risk_appetite * 0.2),
    },
    behavior_patterns: {
      misses_turn: clamp01(0.05 + (1 - dp.patience) * 0.3 + dp.aggression * 0.15),
      takes_shortcut: clamp01(0.1 + dp.route_flexibility * 0.4 + dp.aggression * 0.15),
      sticks_to_plan: clamp01(0.2 + dp.rule_following * 0.4 + (1 - dp.route_flexibility) * 0.2),
      late_reaction: clamp01(0.05 + dp.aggression * 0.25 + (1 - dp.patience) * 0.2),
    },
    exploitable_tendencies: [
      ...(dp.patience < 0.35 ? ["Rushes gaps — higher miss-turn rate under time pressure"] : []),
      ...(dp.risk_appetite > 0.65 ? ["Will go for aggressive moves when crowd pushes it"] : []),
      ...(dp.route_flexibility > 0.65 ? ["Adapts instantly — misses market window by re-routing"] : []),
      ...(dp.rule_following > 0.7 ? ["Predictable — sticks to main roads, rarely surprises"] : []),
    ],
    context_modifiers: {
      under_time_pressure: {
        misses_turn: clamp01(0.15 + (1 - dp.patience) * 0.4),
        sharp_maneuver: clamp01(0.1 + dp.aggression * 0.35),
      },
      light_traffic: {
        takes_shortcut: clamp01(0.15 + dp.route_flexibility * 0.4),
        sharp_maneuver: clamp01(0.08 + dp.risk_appetite * 0.3),
      },
    },
  };

  return { personality, betting_signals };
}

// ─── Server actions ───────────────────────────────────────────────────────────

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { authenticated: false };

  const { data: profile } = await supabase
    .from("profiles")
    .select("character_onboarding_completed_at, primary_character_id, character_onboarding_draft, display_name, username")
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

export async function saveCharacterOnboardingDraft(draft: CharacterOnboardingDraft): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    { character_id: characterId, image_storage_path: primaryPath, angle: "front", is_primary: true, description: "Primary (driver onboarding)", sort_order: 0 },
    ...extras.map((path, i) => ({
      character_id: characterId, image_storage_path: path, angle: `extra_${i + 1}`, is_primary: false, description: "Additional (driver onboarding)", sort_order: i + 1,
    })),
  ];
  await serviceClient.from("character_reference_images").insert(rows);
}

export async function finalizeCharacterOnboarding(input: {
  draft: CharacterOnboardingDraft;
  updateExisting?: boolean;
}): Promise<{ error?: string; characterId?: string }> {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("primary_character_id, display_name, username")
    .eq("id", user.id)
    .maybeSingle();

  const draft = input.draft;
  const name = draft.characterName?.trim() || profile?.display_name || profile?.username || "Driver";

  if (!draft.primaryImagePath?.trim()) {
    return { error: "Add at least one photo to finish." };
  }

  const appearanceRes = await analyzeCharacterImage(draft.primaryImagePath.trim());
  const appearance =
    appearanceRes.appearance && typeof appearanceRes.appearance === "object"
      ? (appearanceRes.appearance as Record<string, unknown>)
      : {};

  const { personality, betting_signals } = heuristicCore(draft);
  const dp = (personality.driving_profile ?? {}) as Record<string, number>;

  // Build camtok content layer from driving data
  const speedLabel: Record<string, string> = {
    always_legal: "law-abiding",
    slightly_above: "slightly above limit",
    significantly_above: "significantly above limit",
    whatever: "no regard for limits",
  };
  const overtakeLabel: Record<string, string> = {
    never: "never overtakes",
    when_safe: "overtakes when safe",
    regularly: "regular overtaker",
    any_gap: "overtakes any gap",
  };
  const patienceLabel: Record<string, string> = {
    very_patient: "very patient",
    normal: "normal patience",
    gets_frustrated: "gets frustrated",
    road_rage: "road rage",
  };

  const camtokContent = {
    bio: draft.backstory?.trim() || undefined,
    vibe_tags: [
      speedLabel[draft.speedTendency ?? "slightly_above"] ?? draft.speedTendency,
      overtakeLabel[draft.overtakingStyle ?? "when_safe"] ?? draft.overtakingStyle,
      patienceLabel[draft.patienceLevel ?? "normal"] ?? draft.patienceLevel,
    ].filter(Boolean),
    city_zone: draft.cityZone?.trim() || undefined,
    visual_style: draft.vehicleStyle ?? undefined,
    recurring_story_elements: [
      draft.typicalRoutes ? `usual routes: ${draft.typicalRoutes.replace("_", " ")}` : "",
      draft.transmission ? `drives ${draft.transmission}` : "",
    ].filter(Boolean),
    rivalries_history: [],
  };

  const preferences = {
    food: { likes: [], dislikes: [] },
    activities: { likes: ["driving", "city navigation"], dislikes: [] },
    brands: { likes: [], dislikes: [] },
    shopping: "practical",
    general_tendencies: [
      `aggression score: ${Math.round(dp.aggression * 100)}%`,
      `patience score: ${Math.round(dp.patience * 100)}%`,
      `risk appetite: ${Math.round(dp.risk_appetite * 100)}%`,
      `route flexibility: ${Math.round(dp.route_flexibility * 100)}%`,
    ],
  };

  const voice = {
    tone: dp.aggression > 0.6 ? "direct and assertive" : "calm and measured",
    vocabulary: "everyday driving language",
    catchphrases: [],
  };

  const entityType = (draft.entityType ?? "car") as "pedestrian" | "bike" | "car" | "other";
  const extras = (draft.extraImagePaths ?? []).filter(Boolean).slice(0, 8);

  const primaryId = profile?.primary_character_id ?? null;
  const shouldUpdate = !!primaryId && !!input.updateExisting;

  let resultCharacterId: string | undefined;

  if (shouldUpdate && primaryId) {
    const upd = await updateUserCharacter(primaryId, {
      name,
      tagline: draft.tagline?.trim() || null,
      appearance,
      personality,
      preferences,
      backstory: draft.backstory?.trim() || null,
      voice,
      betting_signals,
      media: extras.length ? { extra_image_paths: extras } : {},
      camtok_entity_type: entityType,
      camtok_active: true,
      camtok_content: camtokContent,
    });
    if (upd.error || !upd.character) return { error: upd.error ?? "Update failed" };
    await replaceReferenceImages(serviceClient, primaryId, draft.primaryImagePath.trim(), extras);
    await serviceClient.from("profiles").update({
      primary_character_id: primaryId,
      character_onboarding_completed_at: new Date().toISOString(),
      character_onboarding_draft: {} as never,
    }).eq("id", user.id);
    resultCharacterId = primaryId;
  } else {
    const created = await createCustomCharacter({
      name,
      tagline: draft.tagline?.trim() || undefined,
      imageStoragePath: draft.primaryImagePath.trim(),
      appearance,
      personality,
      preferences,
      backstory: draft.backstory?.trim() || undefined,
      voice,
      betting_signals,
      media: extras.length ? { extra_image_paths: extras } : {},
      camtok_entity_type: entityType,
      camtok_active: true,
      camtok_content: camtokContent,
      additionalImagePaths: extras.map((path) => ({ path })),
    });
    if (created.error || !created.character) return { error: created.error ?? "Create failed" };
    await serviceClient.from("profiles").update({
      primary_character_id: created.character.id,
      character_onboarding_completed_at: new Date().toISOString(),
      character_onboarding_draft: {} as never,
    }).eq("id", user.id);
    resultCharacterId = created.character.id;
  }

  revalidatePath("/live");
  revalidatePath("/profile");
  revalidatePath("/onboarding/character");
  return { characterId: resultCharacterId };
}
