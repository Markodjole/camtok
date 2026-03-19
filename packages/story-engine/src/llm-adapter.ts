import { z } from "zod";
import { isFeatureEnabled, LlmValidationError } from "@bettok/core";
import OpenAI from "openai";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LlmAdapter {
  generate(messages: LlmMessage[]): Promise<LlmResponse>;
}

class MockLlmAdapter implements LlmAdapter {
  async generate(messages: LlmMessage[]): Promise<LlmResponse> {
    const userMessage = messages.find((m) => m.role === "user")?.content || "";
    await new Promise((r) => setTimeout(r, 200));

    return {
      content: JSON.stringify({ mock: true, prompt_length: userMessage.length }),
      inputTokens: userMessage.length,
      outputTokens: 100,
      latencyMs: 200,
    };
  }
}

class OpenAIAdapter implements LlmAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model || "gpt-4o-mini";
  }

  async generate(messages: LlmMessage[]): Promise<LlmResponse> {
    const start = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content || "{}";
    const latencyMs = Date.now() - start;

    console.log(
      `[LLM] model=${this.model} input=${response.usage?.prompt_tokens ?? 0} output=${response.usage?.completion_tokens ?? 0} ms=${latencyMs}`,
    );

    return {
      content,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
    };
  }
}

let _adapter: LlmAdapter | null = null;

export function getLlmAdapter(): LlmAdapter {
  if (_adapter) return _adapter;

  const apiKey = process.env.LLM_API_KEY;
  const provider = process.env.LLM_PROVIDER || "mock";
  const model = process.env.LLM_MODEL;

  if (provider === "openai" && apiKey) {
    _adapter = new OpenAIAdapter(apiKey, model || "gpt-4o-mini");
    return _adapter;
  }

  if (isFeatureEnabled("ENABLE_REAL_LLM") && apiKey) {
    _adapter = new OpenAIAdapter(apiKey, model || "gpt-4o-mini");
    return _adapter;
  }

  _adapter = new MockLlmAdapter();
  return _adapter;
}

export function setLlmAdapter(adapter: LlmAdapter): void {
  _adapter = adapter;
}

export async function generateAndValidate<T>(
  messages: LlmMessage[],
  schema: z.ZodType<T>,
  purpose: string
): Promise<{ data: T; response: LlmResponse }> {
  const adapter = getLlmAdapter();
  const response = await adapter.generate(messages);

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    throw new LlmValidationError(purpose, ["Failed to parse JSON output"]);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new LlmValidationError(
      purpose,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    );
  }

  return { data: result.data, response };
}
