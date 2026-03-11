import { createClient } from "@supabase/supabase-js";

export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createClient(url, key);
}

export type ServerClient = ReturnType<typeof createServerClient>;
export type BrowserClient = ReturnType<typeof createBrowserClient>;
