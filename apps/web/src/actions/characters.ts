"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import type { Character, CharacterWithImages, CharacterReferenceImage, BettingSignals } from "@/lib/characters/types";
import { getClipSuggestionsForSlug } from "@/lib/characters/clip-suggestions";

function detectAngleFromFilename(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("front")) return "front";
  if (n.includes("left_45") || n.includes("45_left")) return "left_45";
  if (n.includes("right_45") || n.includes("45_right")) return "right_45";
  if (n.includes("left")) return "left";
  if (n.includes("right")) return "right";
  if (n.includes("side")) return "side";
  if (n.includes("back")) return "back";
  if (n.includes("close")) return "closeup";
  return "front";
}

async function listFallbackStorageImages(
  serviceClient: Awaited<ReturnType<typeof createServiceClient>>,
  character: Character,
): Promise<CharacterReferenceImage[]> {
  const slug = character.slug ?? "";
  if (!slug) return [];

  const folders = [`characters/${slug}`, `patterns/characters/${slug}`];
  const discovered: CharacterReferenceImage[] = [];

  for (const folder of folders) {
    const { data } = await serviceClient.storage.from("media").list(folder, {
      limit: 50,
      sortBy: { column: "name", order: "asc" },
    });
    if (!data?.length) continue;

    data
      .filter((f) => !!f.name && /\.(png|jpe?g|webp)$/i.test(f.name))
      .forEach((f, idx) => {
        const path = `${folder}/${f.name}`;
        discovered.push({
          id: `${character.id}:${path}`,
          image_storage_path: path,
          angle: detectAngleFromFilename(f.name),
          is_primary: idx === 0,
          description: "Storage fallback image",
          sort_order: idx,
        });
      });
  }

  return discovered;
}

async function hydrateReferenceImages(
  serviceClient: Awaited<ReturnType<typeof createServiceClient>>,
  character: Character,
  dbImages: CharacterReferenceImage[],
): Promise<CharacterReferenceImage[]> {
  if (dbImages.length > 0) return dbImages;
  return listFallbackStorageImages(serviceClient, character);
}

export async function getCharacters(): Promise<{
  characters: CharacterWithImages[];
  error?: string;
}> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from("characters")
    .select("*")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) return { characters: [], error: error.message };

  const characters = (data ?? []) as Character[];

  if (characters.length === 0) return { characters: [] };

  const charIds = characters.map((c) => c.id);
  const { data: images } = await serviceClient
    .from("character_reference_images")
    .select("*")
    .in("character_id", charIds)
    .order("sort_order", { ascending: true });

  const imagesByChar = new Map<string, CharacterReferenceImage[]>();
  for (const img of (images ?? []) as (CharacterReferenceImage & { character_id: string })[]) {
    const list = imagesByChar.get(img.character_id) ?? [];
    list.push(img);
    imagesByChar.set(img.character_id, list);
  }

  const hydrated = await Promise.all(
    characters.map(async (c) => ({
      ...c,
      reference_images: await hydrateReferenceImages(
        serviceClient,
        c,
        imagesByChar.get(c.id) ?? [],
      ),
      clip_suggestions: getClipSuggestionsForSlug(c.slug),
    })),
  );

  // Always show the signed-in user's characters first, then predefined/global ones.
  const ordered = [...hydrated].sort((a, b) => {
    const aMine = !!user && a.creator_user_id === user.id;
    const bMine = !!user && b.creator_user_id === user.id;
    if (aMine !== bMine) return aMine ? -1 : 1;
    return a.sort_order - b.sort_order;
  });

  return { characters: ordered };
}

export async function getCharacterBySlug(slug: string): Promise<{
  character: CharacterWithImages | null;
  error?: string;
}> {
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from("characters")
    .select("*")
    .eq("slug", slug)
    .eq("active", true)
    .single();

  if (error || !data) return { character: null, error: error?.message ?? "Not found" };

  const char = data as Character;

  const { data: images } = await serviceClient
    .from("character_reference_images")
    .select("*")
    .eq("character_id", char.id)
    .order("sort_order", { ascending: true });

  return {
    character: {
      ...char,
      reference_images: await hydrateReferenceImages(
        serviceClient,
        char,
        (images ?? []) as CharacterReferenceImage[],
      ),
      clip_suggestions: getClipSuggestionsForSlug(char.slug),
    },
  };
}

export async function getCharacterById(id: string): Promise<{
  character: CharacterWithImages | null;
  error?: string;
}> {
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from("characters")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) return { character: null, error: error?.message ?? "Not found" };

  const char = data as Character;

  const { data: images } = await serviceClient
    .from("character_reference_images")
    .select("*")
    .eq("character_id", char.id)
    .order("sort_order", { ascending: true });

  return {
    character: {
      ...char,
      reference_images: await hydrateReferenceImages(
        serviceClient,
        char,
        (images ?? []) as CharacterReferenceImage[],
      ),
      clip_suggestions: getClipSuggestionsForSlug(char.slug),
    },
  };
}

export async function getCharacterClips(characterId: string): Promise<{
  clips: Array<Record<string, unknown>>;
  error?: string;
}> {
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from("clip_nodes")
    .select("id, video_storage_path, poster_storage_path, scene_summary, status, winning_outcome_text, published_at, created_at")
    .eq("character_id", characterId)
    .not("published_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return { clips: [], error: error.message };
  return { clips: (data ?? []) as Record<string, unknown>[] };
}

export async function getCharacterTraitEvents(characterId: string): Promise<{
  events: Array<Record<string, unknown>>;
  error?: string;
}> {
  const serviceClient = await createServiceClient();

  const { data, error } = await serviceClient
    .from("character_trait_events")
    .select("*")
    .eq("character_id", characterId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return { events: [], error: error.message };
  return { events: (data ?? []) as Record<string, unknown>[] };
}

/**
 * Record a trait event after a video resolves.
 * Appends to trait_history AND evolves the character's personality/preferences
 * based on what they did — the character learns and changes over time.
 */
export async function recordCharacterTraitEvent(input: {
  characterId: string;
  clipNodeId: string;
  actionTaken: string;
  context?: string;
  traitTags?: string[];
  confidence?: number;
}): Promise<{ error?: string }> {
  const serviceClient = await createServiceClient();

  const { error: insertErr } = await serviceClient
    .from("character_trait_events")
    .insert({
      character_id: input.characterId,
      clip_node_id: input.clipNodeId,
      action_taken: input.actionTaken,
      context: input.context ?? null,
      trait_tags: input.traitTags ?? [],
      confidence: input.confidence ?? 1.0,
    });

  if (insertErr) return { error: insertErr.message };

  const { data: char } = await serviceClient
    .from("characters")
    .select("*")
    .eq("id", input.characterId)
    .single();

  if (!char) return {};

  const history = Array.isArray(char.trait_history) ? char.trait_history : [];
  history.push({
    clip_node_id: input.clipNodeId,
    action: input.actionTaken,
    at: new Date().toISOString(),
  });

  const updatePayload: Record<string, unknown> = {
    trait_history: history,
    total_resolutions: (Number(char.total_resolutions) || 0) + 1,
  };

  try {
    const evolution = await evolveCharacterPersonality(
      char as Character,
      input.actionTaken,
      input.context,
    );
    if (evolution) {
      updatePayload.personality = evolution.personality;
      if (evolution.preferencesUpdate) {
        updatePayload.preferences = evolution.preferences;
      }
      console.log(`[character-evolution] ${char.name}: ${JSON.stringify(evolution.changes)}`);
    }
  } catch (err) {
    console.error("[character-evolution] Failed:", (err as Error)?.message);
  }

  await serviceClient
    .from("characters")
    .update(updatePayload)
    .eq("id", input.characterId);

  return {};
}

const EVOLUTION_STEP = 0.03;
const PERSONALITY_MIN = 0.05;
const PERSONALITY_MAX = 0.95;

function clampScore(val: number): number {
  return Math.max(PERSONALITY_MIN, Math.min(PERSONALITY_MAX, val));
}

/**
 * Use LLM to analyze what the character did and nudge their personality accordingly.
 * Small incremental changes (±0.02-0.05) per resolution — over many videos the
 * character genuinely evolves.
 */
async function evolveCharacterPersonality(
  char: Character,
  actionTaken: string,
  context?: string,
): Promise<{
  personality: Record<string, unknown>;
  preferences: Record<string, unknown>;
  preferencesUpdate: boolean;
  changes: string[];
} | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") return null;

  const p = char.personality;
  const pref = char.preferences;

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You analyze a character's action from a resolved video and determine how it shifts their personality.

CHARACTER: ${char.name}
Current personality:
- openness: ${p.big_five.openness}
- conscientiousness: ${p.big_five.conscientiousness}
- extraversion: ${p.big_five.extraversion}
- agreeableness: ${p.big_five.agreeableness}
- neuroticism: ${p.big_five.neuroticism}
- temperament: "${p.temperament}"
- decision_style: "${p.decision_style}"
- risk_appetite: "${p.risk_appetite}"

Current preferences:
- food likes: ${pref.food.likes.join(", ")}
- activity likes: ${pref.activities.likes.join(", ")}
- tendencies: ${pref.general_tendencies.join("; ")}

Rules:
1. Each Big Five dimension shifts by -0.04 to +0.04 per action. Most actions shift 1-2 dimensions, rarely all 5.
2. If the action is CONSISTENT with current personality, shift is 0 or very small (+0.01).
3. If the action CONTRADICTS current personality (shy person initiates conversation), shift is larger (+0.03 to +0.04).
4. Temperament/decision_style/risk_appetite only change after repeated pattern — if the action strongly contradicts current label AND current Big Five scores already reflect the shift (e.g. extraversion went from 0.2 to 0.4), update the text label.
5. If the action reveals a new preference (chose a specific food, did a specific activity), add it.
6. Return ONLY dimensions that change, not all of them.

Return JSON:
{
  "big_five_deltas": { "openness"?: number, "extraversion"?: number, ... },
  "temperament_update": null or "new temperament label",
  "decision_style_update": null or "new label",
  "risk_appetite_update": null or "new label",
  "new_likes": { "food"?: ["item"], "activities"?: ["item"], "brands"?: ["item"] },
  "new_tendencies": ["new tendency text"] or [],
  "reasoning": "1-2 sentences explaining why these shifts make sense"
}`,
      },
      {
        role: "user",
        content: `${char.name} just did this in a resolved video:\nAction: "${actionTaken}"${context ? `\nContext: ${context}` : ""}\n\nHow does this change them?`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const changes: string[] = [];

    const bigFive = { ...p.big_five };
    const deltas = parsed.big_five_deltas ?? {};
    for (const [dim, delta] of Object.entries(deltas)) {
      if (typeof delta === "number" && dim in bigFive) {
        const old = bigFive[dim as keyof typeof bigFive];
        bigFive[dim as keyof typeof bigFive] = clampScore(old + delta);
        if (Math.abs(delta) >= 0.01) {
          changes.push(`${dim}: ${old.toFixed(2)} → ${bigFive[dim as keyof typeof bigFive].toFixed(2)}`);
        }
      }
    }

    const newPersonality: Record<string, unknown> = { ...p, big_five: bigFive };
    if (parsed.temperament_update && typeof parsed.temperament_update === "string") {
      newPersonality.temperament = parsed.temperament_update;
      changes.push(`temperament: "${p.temperament}" → "${parsed.temperament_update}"`);
    }
    if (parsed.decision_style_update && typeof parsed.decision_style_update === "string") {
      newPersonality.decision_style = parsed.decision_style_update;
      changes.push(`decision_style: "${p.decision_style}" → "${parsed.decision_style_update}"`);
    }
    if (parsed.risk_appetite_update && typeof parsed.risk_appetite_update === "string") {
      newPersonality.risk_appetite = parsed.risk_appetite_update;
      changes.push(`risk_appetite: "${p.risk_appetite}" → "${parsed.risk_appetite_update}"`);
    }

    let preferencesUpdate = false;
    const newPref = JSON.parse(JSON.stringify(pref));
    const newLikes = parsed.new_likes ?? {};
    for (const [cat, items] of Object.entries(newLikes)) {
      if (Array.isArray(items) && items.length > 0 && cat in newPref) {
        const existing = (newPref as any)[cat]?.likes ?? [];
        for (const item of items) {
          if (typeof item === "string" && !existing.includes(item)) {
            existing.push(item);
            changes.push(`+preference: ${cat} → ${item}`);
            preferencesUpdate = true;
          }
        }
      }
    }
    const newTendencies = parsed.new_tendencies ?? [];
    if (Array.isArray(newTendencies)) {
      for (const t of newTendencies) {
        if (typeof t === "string" && !newPref.general_tendencies.includes(t)) {
          newPref.general_tendencies.push(t);
          changes.push(`+tendency: ${t}`);
          preferencesUpdate = true;
        }
      }
    }

    if (changes.length === 0) return null;

    if (parsed.reasoning) {
      changes.push(`reason: ${parsed.reasoning}`);
    }

    return {
      personality: newPersonality,
      preferences: newPref,
      preferencesUpdate,
      changes,
    };
  } catch {
    return null;
  }
}

/**
 * Analyze an uploaded character image with the LLM to extract appearance data.
 */
export async function analyzeCharacterImage(imageStoragePath: string): Promise<{
  error?: string;
  appearance?: Record<string, unknown>;
}> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
    return { error: "LLM not configured" };
  }

  const serviceClient = await createServiceClient();
  const { data: imgBytes } = await serviceClient.storage
    .from("media")
    .download(imageStoragePath);
  if (!imgBytes) return { error: "Image not found in storage" };

  const buffer = new Uint8Array(await imgBytes.arrayBuffer());
  const base64 = Buffer.from(buffer).toString("base64");
  const ext = imageStoragePath.split(".").pop()?.toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const res = await client.chat.completions.create({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Analyze this character image. Return JSON with these fields:
{
  "age_range": "e.g. mid-20s",
  "gender_presentation": "e.g. male, female, androgynous",
  "build": "e.g. slim, athletic, stocky",
  "height": "e.g. average, tall, short (estimate)",
  "hair": { "color": "", "style": "", "facial_hair": "" },
  "skin_tone": "",
  "distinguishing_features": ["tattoo on left arm", "scar above eyebrow"],
  "default_outfit": { "top": "", "bottom": "", "shoes": "", "accessories": [] }
}
Be specific and visual. Describe only what you see.`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this character's appearance:" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  });

  const raw = res.choices[0]?.message?.content;
  if (!raw) return { error: "LLM returned empty" };

  try {
    return { appearance: JSON.parse(raw) };
  } catch {
    return { error: "Failed to parse appearance" };
  }
}

/**
 * Create a user-owned custom character.
 */
const DEFAULT_BETTING_SIGNALS: BettingSignals = {
  quick_read: [],
  choice_patterns: {},
  behavior_patterns: {},
  exploitable_tendencies: [],
  context_modifiers: {},
};

export async function createCustomCharacter(input: {
  name: string;
  tagline?: string;
  imageStoragePath: string;
  appearance: Record<string, unknown>;
  personality?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  backstory?: string;
  voice?: Record<string, unknown>;
  betting_signals?: BettingSignals;
  media?: Record<string, unknown>;
  camtok_entity_type?: "pedestrian" | "bike" | "car" | "other";
  camtok_active?: boolean;
  camtok_content?: Record<string, unknown>;
  additionalImagePaths?: Array<{ path: string; angle?: string; isPrimary?: boolean }>;
}): Promise<{ error?: string; character?: CharacterWithImages }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

  const personality = input.personality ?? {
    big_five: {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
    },
    temperament: "balanced",
    decision_style: "moderate",
    risk_appetite: "moderate",
    social_style: "adaptable",
    under_pressure: "stays composed",
    attention_span: "average",
  };

  const preferences = input.preferences ?? {
    food: { likes: [], dislikes: [] },
    activities: { likes: [], dislikes: [] },
    brands: { likes: [], dislikes: [] },
    shopping: "no preference specified",
    general_tendencies: [],
  };

  const voice = input.voice ?? { tone: "neutral", vocabulary: "casual", catchphrases: [] };
  const betting_signals = input.betting_signals ?? DEFAULT_BETTING_SIGNALS;
  const media = input.media ?? {};
  const camtokEntityType = input.camtok_entity_type ?? "pedestrian";
  const camtokActive = input.camtok_active ?? true;
  const camtokContent = input.camtok_content ?? {};

  const { data: charRow, error: insertErr } = await serviceClient
    .from("characters")
    .insert({
      creator_user_id: user.id,
      slug: `${slug}_${Date.now()}`,
      name: input.name,
      tagline: input.tagline || null,
      appearance: input.appearance,
      personality,
      preferences,
      backstory: input.backstory || null,
      voice,
      betting_signals,
      media,
      operator_user_id: user.id,
      camtok_entity_type: camtokEntityType,
      camtok_active: camtokActive,
      camtok_content: camtokContent,
      trait_history: [],
      total_videos: 0,
      total_resolutions: 0,
      total_bets_received: 0,
      active: true,
      sort_order: 99,
    })
    .select()
    .single();

  if (insertErr || !charRow) {
    return { error: insertErr?.message ?? "Failed to create character" };
  }

  const char = charRow as Character;

  const extra = input.additionalImagePaths ?? [];
  const rows: Array<{
    character_id: string;
    image_storage_path: string;
    angle: string;
    is_primary: boolean;
    description: string;
    sort_order: number;
  }> = [
    {
      character_id: char.id,
      image_storage_path: input.imageStoragePath,
      angle: "front",
      is_primary: true,
      description: "Primary reference image",
      sort_order: 0,
    },
    ...extra.map((e, i) => ({
      character_id: char.id,
      image_storage_path: e.path,
      angle: e.angle ?? `extra_${i + 1}`,
      is_primary: !!e.isPrimary,
      description: "Onboarding reference",
      sort_order: i + 1,
    })),
  ];

  await serviceClient.from("character_reference_images").insert(rows);

  const { data: images } = await serviceClient
    .from("character_reference_images")
    .select("*")
    .eq("character_id", char.id)
    .order("sort_order", { ascending: true });

  revalidatePath("/create");

  return {
    character: {
      ...char,
      reference_images: (images ?? []) as CharacterReferenceImage[],
    },
  };
}

/**
 * Update a character owned by the current user (same row shape as seeded characters).
 */
export async function updateUserCharacter(
  characterId: string,
  input: {
    name?: string;
    tagline?: string | null;
    appearance?: Record<string, unknown>;
    personality?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    backstory?: string | null;
    voice?: Record<string, unknown>;
    betting_signals?: BettingSignals;
    media?: Record<string, unknown>;
    camtok_entity_type?: "pedestrian" | "bike" | "car" | "other";
    camtok_active?: boolean;
    camtok_content?: Record<string, unknown>;
  },
): Promise<{ error?: string; character?: CharacterWithImages }> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const serviceClient = await createServiceClient();

  const { data: existing, error: fetchErr } = await serviceClient
    .from("characters")
    .select("*")
    .eq("id", characterId)
    .maybeSingle();

  if (fetchErr || !existing) return { error: fetchErr?.message ?? "Character not found" };
  if (existing.creator_user_id !== user.id) return { error: "Not allowed" };

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.tagline !== undefined) patch.tagline = input.tagline;
  if (input.appearance !== undefined) patch.appearance = input.appearance;
  if (input.personality !== undefined) patch.personality = input.personality;
  if (input.preferences !== undefined) patch.preferences = input.preferences;
  if (input.backstory !== undefined) patch.backstory = input.backstory;
  if (input.voice !== undefined) patch.voice = input.voice;
  if (input.betting_signals !== undefined) patch.betting_signals = input.betting_signals;
  if (input.media !== undefined) patch.media = input.media;
  if (input.camtok_entity_type !== undefined) patch.camtok_entity_type = input.camtok_entity_type;
  if (input.camtok_active !== undefined) patch.camtok_active = input.camtok_active;
  if (input.camtok_content !== undefined) patch.camtok_content = input.camtok_content;

  const { data: updated, error: updErr } = await serviceClient
    .from("characters")
    .update(patch)
    .eq("id", characterId)
    .select()
    .single();

  if (updErr || !updated) return { error: updErr?.message ?? "Update failed" };

  const char = updated as Character;
  const { data: images } = await serviceClient
    .from("character_reference_images")
    .select("*")
    .eq("character_id", char.id)
    .order("sort_order", { ascending: true });

  revalidatePath("/create");
  revalidatePath("/live");

  return {
    character: {
      ...char,
      reference_images: (images ?? []) as CharacterReferenceImage[],
    },
  };
}

/**
 * Get a user's win rate against a specific character.
 */
export async function getUserVsCharacterStats(
  characterId: string,
): Promise<{
  totalBets: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  recentResults: Array<{ won: boolean; amount: number; date: string }>;
}> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const empty = { totalBets: 0, wins: 0, losses: 0, winRate: 0, netProfit: 0, recentResults: [] };
  if (!user) return empty;

  const serviceClient = await createServiceClient();

  const { data: bets } = await serviceClient
    .from("bets")
    .select("id, stake_amount, odds_at_bet, status, payout_amount, created_at, clip_node_id")
    .eq("user_id", user.id)
    .in("status", ["won", "lost", "settled"]);

  if (!bets || bets.length === 0) return empty;

  const { data: charClips } = await serviceClient
    .from("clip_nodes")
    .select("id")
    .eq("character_id", characterId);

  if (!charClips || charClips.length === 0) return empty;

  const charClipIds = new Set(charClips.map((c) => c.id));
  const characterBets = bets.filter((b) => charClipIds.has(b.clip_node_id));

  if (characterBets.length === 0) return empty;

  let wins = 0;
  let losses = 0;
  let netProfit = 0;
  const recentResults: Array<{ won: boolean; amount: number; date: string }> = [];

  for (const b of characterBets) {
    const won = b.status === "won";
    const payout = Number(b.payout_amount ?? 0);
    const stake = Number(b.stake_amount ?? 0);
    const profit = won ? payout - stake : -stake;

    if (won) wins++;
    else losses++;

    netProfit += profit;
    recentResults.push({ won, amount: profit, date: b.created_at });
  }

  recentResults.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    totalBets: characterBets.length,
    wins,
    losses,
    winRate: characterBets.length > 0 ? Math.round((wins / characterBets.length) * 100) : 0,
    netProfit: Math.round(netProfit * 100) / 100,
    recentResults: recentResults.slice(0, 10),
  };
}

/**
 * Get the last N resolution outcomes for a character (public, no auth needed).
 */
export async function getCharacterRecentOutcomes(
  characterId: string,
  limit = 5,
): Promise<Array<{
  action: string;
  date: string;
  clipId: string;
}>> {
  const serviceClient = await createServiceClient();

  const { data } = await serviceClient
    .from("character_trait_events")
    .select("action_taken, created_at, clip_node_id")
    .eq("character_id", characterId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((e) => ({
    action: e.action_taken as string,
    date: e.created_at as string,
    clipId: e.clip_node_id as string,
  }));
}
