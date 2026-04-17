import { z } from "zod";

function resolveAppUrl(rawAppUrl?: string): string {
  if (rawAppUrl && rawAppUrl.trim().length > 0) {
    return rawAppUrl;
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && vercelUrl.trim().length > 0) {
    return `https://${vercelUrl}`;
  }
  return "http://localhost:3000";
}

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DB_URL: z.string().optional(),
  LLM_PROVIDER: z.enum(["mock", "anthropic", "openai"]).default("mock"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-3-5-sonnet-20241022"),
  MEDIA_PROVIDER: z.enum(["mock", "seedance", "replicate"]).default("mock"),
  MEDIA_API_KEY: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten());
    throw new Error("Invalid environment variables");
  }

  _env = parsed.data;
  return _env;
}

export function getPublicEnv() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    appUrl: resolveAppUrl(process.env.NEXT_PUBLIC_APP_URL),
  };
}
