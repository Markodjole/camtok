/**
 * Canonical base URL for Supabase `emailRedirectTo` / OAuth `redirectTo`.
 *
 * Why production emails sometimes pointed at localhost:
 * 1. **Wrong env on Vercel** — `NEXT_PUBLIC_APP_URL=http://localhost:3000` (copy-paste from .env.local)
 *    gets baked into the client bundle; Supabase puts that in the confirmation link as `redirect_to`.
 * 2. **Hosted Supabase + browser on localhost** — `window.location.origin` is localhost; if env was
 *    missing, that value was sent and ended up in the email.
 * 3. **Dashboard email template** — a custom template that links to `{{ .SiteURL }}` instead of
 *    `{{ .ConfirmationURL }}` ignores `emailRedirectTo` for the visible URL. Fix: use the repo
 *    template in `supabase/templates/confirmation.html` and `supabase config push`.
 *
 * Resolution order when using **hosted** Supabase (…supabase.co):
 *   - Sanitized `NEXT_PUBLIC_APP_URL`, then `NEXT_PUBLIC_SITE_URL`, then `VERCEL_URL` / `NEXT_PUBLIC_VERCEL_URL`
 *   - Else non-localhost `window.location.origin` (production / preview tab)
 *   - Else production fallback (local dev hitting hosted backend — never put localhost in email)
 *
 * Local Supabase (127.0.0.1 / localhost URL): use env or `window.location.origin` including localhost.
 */

function trimQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function isLocalhostOrigin(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return true;
  }
}

function isHostedSupabase(): boolean {
  return /\.supabase\.co\b/i.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

function vercelHttpsOrigin(): string | undefined {
  const raw =
    process.env.NEXT_PUBLIC_VERCEL_URL ??
    process.env.VERCEL_URL ??
    process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL;
  if (!raw) return undefined;
  const v = trimQuotes(raw).replace(/\/$/, "");
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${v}`;
}

/** First https, non-localhost URL from candidates (for hosted Supabase email redirects). */
function firstPublicHttpsBase(candidates: Array<string | undefined | null>): string | null {
  for (const raw of candidates) {
    if (!raw) continue;
    const v = trimQuotes(raw).replace(/\/$/, "");
    if (!v.startsWith("https://")) continue;
    if (isLocalhostOrigin(v)) continue;
    return v;
  }
  return null;
}

export function getAuthRedirectBase(): string {
  const hosted = isHostedSupabase();

  if (hosted) {
    const fromEnv = firstPublicHttpsBase([
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.NEXT_PUBLIC_SITE_URL,
      vercelHttpsOrigin(),
    ]);
    if (fromEnv) return fromEnv;

    if (typeof window !== "undefined") {
      const w = trimQuotes(window.location.origin).replace(/\/$/, "");
      if (!isLocalhostOrigin(w)) return w;
    }

    // Dev machine signing up against hosted Supabase — localhost must not be emailed.
    return "https://camtok-web.vercel.app";
  }

  const fromEnv = [process.env.NEXT_PUBLIC_APP_URL, process.env.NEXT_PUBLIC_SITE_URL]
    .map((raw) => {
      if (!raw) return null;
      const v = trimQuotes(raw).replace(/\/$/, "");
      return /^https?:\/\//.test(v) ? v : null;
    })
    .find(Boolean);
  if (fromEnv) return fromEnv;

  if (typeof window !== "undefined") {
    return trimQuotes(window.location.origin).replace(/\/$/, "");
  }

  const v = vercelHttpsOrigin();
  if (v) return v;
  return "http://localhost:3000";
}

export function getAuthCallbackUrl(next = "/live"): string {
  const base = getAuthRedirectBase();
  const params = new URLSearchParams({ next });
  return `${base}/auth/callback?${params.toString()}`;
}
