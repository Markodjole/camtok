"use server";

import { createServerClient } from "@/lib/supabase/server";
import { getCharacterById } from "./characters";
import { characterToPromptContext } from "@/lib/characters/types";
import {
  characterClipLlmConfigured,
  completeCharacterClipJson,
  getCharacterClipLlmBackend,
} from "@/lib/llm/character-clip-json";

export type CharacterClipAiOption = {
  description: string;
  cliffhangers: string[];
};

const ACTION_MAX = 900;
const CLIFF_MAX = 400;
const OPTIONS_COUNT = 4;
const CLIFFS_PER_OPTION = 3;

/**
 * LLM-generated movement + cliffhanger pairs for /create (character mode).
 * Uses the same behavioral rules as video generation (Kling / compose frame).
 */
export async function suggestCharacterClipIdeas(input: {
  characterId: string;
  locationDescription: string;
  mood?: string;
  camera?: string;
}): Promise<{ data?: { options: CharacterClipAiOption[] }; error?: string }> {
  const location = (input.locationDescription || "").trim();
  if (!location) return { error: "Add a location first" };

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in" };

  const { character, error: charErr } = await getCharacterById(input.characterId);
  if (charErr || !character || !character.active) {
    return { error: "Character not found" };
  }
  if (character.creator_user_id && character.creator_user_id !== user.id) {
    return { error: "You cannot use this character" };
  }

  if (!characterClipLlmConfigured()) {
    const backend = getCharacterClipLlmBackend();
    return {
      error:
        backend === "anthropic"
          ? "AI suggestions require ANTHROPIC_API_KEY (CHARACTER_CLIP_LLM_BACKEND=anthropic)"
          : "AI suggestions require LLM_API_KEY",
    };
  }

  const ctx = characterToPromptContext(character);
  const mood = (input.mood || "neutral").trim();
  const camera = (input.camera || "auto").trim();

  const system = `You write FUN, PUNCHY, BETTABLE scene setups for short AI video (Kling image-to-video). Think relatable micro-stories (diner tip, gym signup, text send, two doors) — not generic "tension". A viewer who sees ONE frame at the cut must understand (1) exactly what situation ${character.name} is in and (2) what two or three concrete outcomes they could bet on.

PIPELINE:
- LOCATION is sent separately to an image composer — do NOT open "description" with "In [place]…" / "At the [place]…". Start with ${character.name} or a physical verb.
- "description" fills the main movement field: it must make the STAKES obvious in plain language, then the motion leading toward a freeze.
- Each "cliffhanger" is the ending beat: frozen moment, NO resolution, NO speech.

SIMPLE CAST (STRICT — Kling fails on busy scenes):
- **Only ${character.name} moves** in any meaningful way. Prefer **zero** other people; if needed, **one** static background figure (clerk facing away, unmoving) — never pairs arguing, families, teams, crowds, queues of people, or choreographed groups.
- **No animals** (no dogs, cats, birds, insects as focus). No stadiums, parades, pickup games with multiple players, or "group approaches".
- Dilemmas come from **two or three props / buttons / doors / products / screens**, not from multiple actors.
- Pick **calm, sparse locations** in the user's LOCATION (empty aisle, quiet counter after hours, solo booth, one machine) — never suggest "crowded", "tournament", "funeral procession", "food truck line", etc.

CHARACTER DATA (behavior is law — do not invent a new personality or job for them):
${ctx}

STYLE — DESCRIPTION (2–4 short sentences, hard-hitting, entertaining):
- Sentence 1: One clear logline a stranger would get — **who, where, what choice** — in words a friend would repeat. (e.g. "${character.name} at the diner counter with the leather bill folder — deciding whether to tip the waitress or stiff her.")
- Next sentences: **one unhurried physical beat** (or two only if both are slow and simple). **Everyday pace** — not rushing, not a montage. Prefer slowly, pauses, holds — avoid quickly, rushes, frantically, rapid-fire unless the dilemma is explicitly about a deadline. Match PHYSICAL BEHAVIOR (energy = readable, not frantic).
- Avoid mushy mood writing ("a sense of uncertainty fills the air"). Name objects and body positions instead.

STYLE — CLIFFHANGERS (${CLIFFS_PER_OPTION} per option, each a different phrasing of the SAME visible fork):
- Every cliffhanger MUST name BOTH options (or all THREE) using **color, side, shape, material** — **never** spelled words on screens or signs (video AI draws nonsense letters). e.g. "Thumb between **green-lit tile** and **red-lit tile** on the phone — neither pressed", "Palm on the **brass** door handle, eyes on the **white** door still closed", "**White** sneaker laced, **black** sneaker still boxed — one foot raised, undecided".
- Short clauses, strong verbs, present tense. No dialogue, no sounds.
- The last frame logic: we see the fork; we do not see the pick.

VARIETY: The ${OPTIONS_COUNT} options must differ in TYPE of dilemma (money vs pride, safety vs curiosity, social vs object, time pressure vs temptation, etc.), not just reword the same fork.

MOOD/CAMERA: mood=${mood}, camera=${camera}. If not neutral, bias pacing/tension. Never write "the camera…" — only what appears on screen.

OUTPUT: JSON only, no markdown:
{
  "options": [
    {
      "description": "string",
      "cliffhangers": ["string", "string", "string"]
    }
  ]
}
Return exactly ${OPTIONS_COUNT} options; each exactly ${CLIFFS_PER_OPTION} cliffhangers.`;

  const userMsg = `LOCATION (user already set this — weave in via props only, no opener clause):\n${location}\n\nGenerate the JSON. Every option must be obviously bettable: name the competing outcomes in both description (stakes) and each cliffhanger (visible A vs B).\n\nKeep every option strictly single-protagonist: only ${character.name} moves; no crowds, teams, or animals.`;

  try {
    const raw = await completeCharacterClipJson({
      system,
      user: userMsg,
      temperature: 0.42,
      maxTokens: 2800,
    });
    if (!raw) return { error: "Empty model response" };

    const parsed = JSON.parse(raw) as { options?: unknown };
    const rawOpts = Array.isArray(parsed.options) ? parsed.options : [];

    const options: CharacterClipAiOption[] = [];
    for (const row of rawOpts) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const desc =
        typeof r.description === "string" ? r.description.trim().slice(0, ACTION_MAX) : "";
      const cliffsRaw = Array.isArray(r.cliffhangers) ? r.cliffhangers : [];
      const cliffhangers = cliffsRaw
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.trim().slice(0, CLIFF_MAX))
        .slice(0, CLIFFS_PER_OPTION);
      if (desc && cliffhangers.length >= 1) {
        options.push({ description: desc, cliffhangers });
      }
    }

    if (options.length === 0) {
      return { error: "Could not parse valid suggestions" };
    }

    return { data: { options } };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Suggestion failed";
    return { error: msg };
  }
}
