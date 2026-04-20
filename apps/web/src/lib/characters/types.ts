import type { CharacterClipSuggestions } from "./clip-suggestions";

export interface CharacterAppearance {
  age_range: string;
  gender_presentation: string;
  build: string;
  height: string;
  hair: {
    color: string;
    style: string;
    facial_hair?: string;
  };
  skin_tone: string;
  distinguishing_features: string[];
  default_outfit: {
    top: string;
    bottom: string;
    shoes: string;
    accessories: string[];
  };
}

export interface CharacterPhysicalBehavior {
  energy_level: string;
  movement_style: string;
  posture: string;
  typical_gestures: string[];
  walking_pace: string;
  emotional_expressiveness: string;
  comfort_zone: string[];
  behavioral_red_flags: string[];
}

export interface CharacterPersonality {
  big_five: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  temperament: string;
  decision_style: string;
  risk_appetite: string;
  social_style: string;
  under_pressure: string;
  attention_span: string;
  physical_behavior: CharacterPhysicalBehavior;
}

export interface CharacterPreferences {
  food: { likes: string[]; dislikes: string[] };
  activities: { likes: string[]; dislikes: string[] };
  brands: { likes: string[]; dislikes: string[] };
  shopping: string;
  general_tendencies: string[];
}

export interface CharacterVoice {
  tone: string;
  vocabulary: string;
  catchphrases: string[];
}

export interface CharacterTraitEvent {
  clip_node_id: string;
  action: string;
  at: string;
}

export type CamtokEntityType = "pedestrian" | "bike" | "car" | "other";

export interface CamtokContentLayer {
  bio?: string;
  vibe_tags?: string[];
  city_zone?: string;
  preferred_hours?: string[];
  visual_style?: string;
  recurring_story_elements?: string[];
  rivalries_history?: string[];
}

export interface CharacterReferenceImage {
  id: string;
  image_storage_path: string;
  angle: string;
  is_primary: boolean;
  description: string | null;
  sort_order: number;
}

export interface BettingSignals {
  quick_read: string[];
  choice_patterns: Record<string, number>;
  behavior_patterns: Record<string, number>;
  exploitable_tendencies: string[];
  context_modifiers: Record<string, Record<string, number>>;
}

export interface Character {
  id: string;
  creator_user_id: string | null;
  operator_user_id?: string | null;
  slug: string | null;
  name: string;
  tagline: string | null;
  appearance: CharacterAppearance;
  personality: CharacterPersonality;
  preferences: CharacterPreferences;
  backstory: string | null;
  voice: CharacterVoice;
  /** Optional onboarding / gallery paths (intro video, etc.). */
  media?: Record<string, unknown>;
  trait_history: CharacterTraitEvent[];
  betting_signals: BettingSignals;
  total_videos: number;
  total_resolutions: number;
  total_bets_received: number;
  active: boolean;
  camtok_active?: boolean;
  camtok_entity_type?: CamtokEntityType;
  camtok_content?: CamtokContentLayer;
  sort_order: number;
  created_at: string;
}

export interface CharacterWithImages extends Character {
  reference_images: CharacterReferenceImage[];
  /** Curated ideas for /create (canonical slugs only). */
  clip_suggestions?: CharacterClipSuggestions;
}

/**
 * Flatten character data into a string for LLM prompts.
 * This gives the AI everything it needs to predict behavior and generate consistent video.
 */
export function characterToPromptContext(char: Character): string {
  const a = char.appearance;
  const p = char.personality;
  const pref = char.preferences;

  const lines: string[] = [
    `CHARACTER: ${char.name}`,
    char.tagline ? `TAGLINE: ${char.tagline}` : "",
    "",
    "=== APPEARANCE ===",
    `Age: ${a.age_range}, ${a.gender_presentation}, ${a.build}, ${a.height}`,
    `Hair: ${a.hair.color}, ${a.hair.style}${a.hair.facial_hair ? `, ${a.hair.facial_hair}` : ""}`,
    `Skin: ${a.skin_tone}`,
    `Features: ${a.distinguishing_features.join(", ")}`,
    `Outfit: ${a.default_outfit.top}; ${a.default_outfit.bottom}; ${a.default_outfit.shoes}`,
    `Accessories: ${a.default_outfit.accessories.join(", ")}`,
    "",
    "=== PERSONALITY ===",
    `Temperament: ${p.temperament}`,
    `Decision style: ${p.decision_style}`,
    `Risk appetite: ${p.risk_appetite}`,
    `Social style: ${p.social_style}`,
    `Under pressure: ${p.under_pressure}`,
    `Attention span: ${p.attention_span}`,
    "",
    "=== PHYSICAL BEHAVIOR (MUST govern all on-screen movement) ===",
    ...(p.physical_behavior ? [
      `Energy level: ${p.physical_behavior.energy_level}`,
      `Movement style: ${p.physical_behavior.movement_style}`,
      `Posture: ${p.physical_behavior.posture}`,
      `Typical gestures: ${p.physical_behavior.typical_gestures.join(", ")}`,
      `Walking pace: ${p.physical_behavior.walking_pace}`,
      `Emotional expressiveness: ${p.physical_behavior.emotional_expressiveness}`,
      `Comfort zone (acts naturally here): ${p.physical_behavior.comfort_zone.join(", ")}`,
      `Behavioral red flags (NEVER do these): ${p.physical_behavior.behavioral_red_flags.join(", ")}`,
    ] : []),
    "",
    "=== PREFERENCES ===",
    `Food likes: ${pref.food.likes.join(", ")}`,
    `Food dislikes: ${pref.food.dislikes.join(", ")}`,
    `Activity likes: ${pref.activities.likes.join(", ")}`,
    `Activity dislikes: ${pref.activities.dislikes.join(", ")}`,
    `Brand likes: ${pref.brands.likes.join(", ")}`,
    `Brand dislikes: ${pref.brands.dislikes.join(", ")}`,
    `Shopping style: ${pref.shopping}`,
    `Tendencies: ${pref.general_tendencies.join("; ")}`,
  ];

  if (char.backstory) {
    lines.push("", "=== BACKSTORY ===", char.backstory);
  }

  if (char.trait_history.length > 0) {
    lines.push("", "=== PAST BEHAVIOR (from resolved videos) ===");
    for (const t of char.trait_history.slice(-20)) {
      lines.push(`- ${t.action} (${t.at})`);
    }
  }

  return lines.filter((l) => l !== undefined).join("\n");
}

/**
 * Build Kling-compatible appearance description for video prompt prefix.
 */
export function characterToKlingIdentity(char: Character): string {
  const a = char.appearance;
  const parts = [
    `${a.gender_presentation}`,
    `${a.age_range}`,
    `${a.build} build`,
    `${a.hair.color} ${a.hair.style} hair`,
    a.hair.facial_hair ? a.hair.facial_hair : null,
    `${a.skin_tone} skin`,
    a.default_outfit.top,
    a.default_outfit.bottom,
    a.default_outfit.shoes,
    ...a.default_outfit.accessories,
    ...a.distinguishing_features,
  ].filter(Boolean);

  return `SAME CHARACTER: ${char.name}. ${parts.join(", ")}`;
}
