import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

const MAX_JSON = 12_000;

function truncateJson(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 1);
    if (s.length <= MAX_JSON) return s;
    return `${s.slice(0, MAX_JSON)}\n… (truncated)`;
  } catch {
    return String(value);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> },
) {
  try {
    const { clipId } = await params;
    const body = await req.json().catch(() => ({}));
    const history = Array.isArray(body?.messages)
      ? body.messages
          .filter(
            (m: unknown) =>
              m &&
              typeof m === "object" &&
              ["user", "assistant"].includes(String((m as { role?: unknown }).role)) &&
              typeof (m as { content?: unknown }).content === "string",
          )
          .slice(-12)
          .map((m: { role: string; content: string }) => ({
            role: m.role as "user" | "assistant",
            content: m.content.slice(0, 1200),
          }))
      : [];

    if (history.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    const service = await createServiceClient();
    const { data: clip, error: clipErr } = await service
      .from("clip_nodes")
      .select(
        "id, scene_summary, transcript, llm_generation_json, character_id, genre, tone, status, video_analysis_text",
      )
      .eq("id", clipId)
      .maybeSingle();

    if (clipErr || !clip) {
      return NextResponse.json({ error: "Clip not found" }, { status: 404 });
    }

    const characterId = clip.character_id as string | null;
    let characterBlock = "";
    let eventsBlock = "none yet";

    if (characterId) {
      const [{ data: character }, { data: events }] = await Promise.all([
        service.from("characters").select("*").eq("id", characterId).single(),
        service
          .from("character_trait_events")
          .select("action_taken, created_at, trait_tags, context")
          .eq("character_id", characterId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      if (character) {
        characterBlock = `
FEATURED CHARACTER: ${character.name}
TAGLINE: ${character.tagline ?? ""}

APPEARANCE:
${JSON.stringify(character.appearance, null, 1)}

PERSONALITY:
${JSON.stringify(character.personality, null, 1)}

PREFERENCES:
${JSON.stringify(character.preferences, null, 1)}

BETTING SIGNALS:
${JSON.stringify(character.betting_signals ?? {}, null, 1)}

STATS: ${character.total_videos} videos, ${character.total_resolutions} resolutions, ${character.total_bets_received} bets received

BACKSTORY: ${character.backstory ?? "none"}
`;
        eventsBlock =
          (events ?? []).map((e) => `- ${e.action_taken} (${e.created_at})`).join("\n") || "none yet";
      }
    }

    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey || process.env.LLM_PROVIDER !== "openai") {
      const fallback = [clip.scene_summary, clip.transcript].filter(Boolean).join(" — ") || "No summary.";
      return NextResponse.json({ answer: fallback.slice(0, 500) });
    }

    const videoBlock = `
THIS FEED VIDEO (clip id ${clip.id})
STATUS: ${clip.status ?? "unknown"}
GENRE: ${clip.genre ?? "—"}
TONE: ${clip.tone ?? "—"}

SCENE SUMMARY:
${clip.scene_summary ?? "none"}

ON-SCREEN TRANSCRIPT / DIALOGUE:
${clip.transcript ?? "none"}

VIDEO ANALYSIS NOTES (if any):
${clip.video_analysis_text ?? "none"}

GENERATION / SCENE PLAN (JSON, may include multi-scene prompts and outcomes):
${truncateJson(clip.llm_generation_json)}
`;

    const systemParts = [
      `You are a helpful assistant for a short-form video feed. The user is watching ONE specific clip. Answer naturally like a normal chatbot.`,
      `Use ONLY the data below. Do not invent plot, dialogue, or character traits that are not supported by the data. If something is unknown, say so.`,
      videoBlock,
    ];

    if (characterBlock) {
      systemParts.push(
        characterBlock,
        `RECENT BEHAVIOR (from resolved videos):\n${eventsBlock}`,
      );
    } else {
      systemParts.push(
        "This clip has no linked character. Answer only from the video metadata above — do not invent a character profile.",
      );
    }

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: systemParts.join("\n\n"),
        },
        ...history,
      ],
    });

    const answer = res.choices[0]?.message?.content?.trim() || "No response.";
    return NextResponse.json({ answer });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed" },
      { status: 500 },
    );
  }
}
