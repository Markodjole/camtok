/**
 * Character clip planning (multi-scene Kling JSON + AI suggestions).
 * Supports OpenAI or Anthropic (e.g. Claude Opus 4.6) via env.
 */

export type CharacterClipLlmBackend = "openai" | "anthropic";

export function getCharacterClipLlmBackend(): CharacterClipLlmBackend {
  const raw = (
    process.env.CHARACTER_CLIP_LLM_BACKEND ||
    process.env.LLM_PROVIDER_CHARACTER_CLIPS ||
    ""
  ).toLowerCase();
  if (raw === "anthropic") return "anthropic";
  return "openai";
}

/** Dedupe comma-separated negative prompt tokens (case-insensitive). */
export function mergeNegativePromptLayers(...layers: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const layer of layers) {
    for (const part of (layer || "").split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join(", ");
}

function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return (m?.[1] ?? t).trim();
}

/**
 * JSON object completion for character clip planning.
 * OpenAI model resolution (first match): openaiModelOverride → LLM_MODEL_CHARACTER_CLIP_SUGGEST →
 * LLM_MODEL_CHARACTER_VIDEO → LLM_MODEL_IMAGE_PATTERNS → LLM_MODEL → default gpt-4o.
 * Anthropic: ANTHROPIC_API_KEY + ANTHROPIC_MODEL_CHARACTER_CLIPS (default claude-opus-4-6).
 */
export async function completeCharacterClipJson(input: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** When backend is openai, overrides the character-video model (e.g. suggestions). */
  openaiModelOverride?: string;
}): Promise<string | null> {
  const backend = getCharacterClipLlmBackend();
  const temp = input.temperature ?? 0.4;
  const maxTok = input.maxTokens ?? 8192;

  if (backend === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.error("[character-clip-llm] CHARACTER_CLIP_LLM_BACKEND=anthropic but ANTHROPIC_API_KEY is missing");
      return null;
    }
    const model =
      process.env.ANTHROPIC_MODEL_CHARACTER_CLIPS ||
      process.env.ANTHROPIC_MODEL ||
      "claude-opus-4-6";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTok,
        temperature: temp,
        system: `${input.system}\n\nRespond with a single valid JSON object only. No markdown code fences or commentary before or after the JSON.`,
        messages: [{ role: "user", content: input.user }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[character-clip-llm] Anthropic error", res.status, errBody.slice(0, 500));
      return null;
    }

    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const block = data.content?.find((c) => c.type === "text" || typeof c.text === "string");
    const text = typeof block?.text === "string" ? block.text : "";
    return stripJsonFence(text) || null;
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error("[character-clip-llm] OpenAI backend but LLM_API_KEY is missing");
    return null;
  }

  const model =
    input.openaiModelOverride ||
    process.env.LLM_MODEL_CHARACTER_CLIP_SUGGEST ||
    process.env.LLM_MODEL_CHARACTER_VIDEO ||
    process.env.LLM_MODEL_IMAGE_PATTERNS ||
    process.env.LLM_MODEL ||
    "gpt-4o";

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: temp,
    max_tokens: maxTok,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  });

  const raw = res.choices[0]?.message?.content?.trim();
  return raw ? stripJsonFence(raw) : null;
}

export function characterClipLlmConfigured(): boolean {
  if (getCharacterClipLlmBackend() === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  return !!process.env.LLM_API_KEY;
}
