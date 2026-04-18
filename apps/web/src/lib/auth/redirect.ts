/**
 * Canonical auth redirect base URL.
 *
 * Order of preference:
 *   1. NEXT_PUBLIC_APP_URL (production canonical, set on Vercel)
 *   2. window.location.origin (fallback for local dev / previews without the var)
 *
 * We prefer the env var because Supabase's hosted Auth service validates
 * emailRedirectTo / redirectTo against the project's allowlist and falls back
 * to Site URL when the value is not allowed. Using a canonical, allowlisted
 * URL guarantees confirmation mails point to production, not localhost.
 */
export function getAuthRedirectBase(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl && /^https?:\/\//.test(envUrl)) {
    return envUrl.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "https://camtok-web.vercel.app";
}

export function getAuthCallbackUrl(next = "/feed"): string {
  const base = getAuthRedirectBase();
  const params = new URLSearchParams({ next });
  return `${base}/auth/callback?${params.toString()}`;
}
