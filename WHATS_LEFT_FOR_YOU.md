# What’s left for you to do

Status after this automated pass:

- [x] **Supabase project created & linked** — `bettok` (ref: `jiecaxoziolwefitdfqg`, region: West EU / Ireland).
- [x] **Migrations applied** — all 37 migrations `00001`…`00037` are now in sync with the remote DB (`supabase migration list` shows matching Local/Remote columns).
- [x] **Local env configured** — `apps/web/.env.local` is in place.
- [x] **Repo pushed to GitHub** — `https://github.com/Markodjole/camtok.git`, branch `main` tracks `origin/main`.
- [x] **Production build verified** — `pnpm exec turbo build --filter=@bettok/web` succeeds locally (9 tasks successful).

What still requires **your** accounts (cannot be automated without your credentials):

---

## 1. Verify the Storage `media` bucket policies

The `media` bucket is created by migration `00002`. If uploads fail on the live app, open **Supabase → Storage → Policies** and confirm authenticated users can **INSERT** into `media` with path like `clips/{user_id}/*`.

---

## 2. Deploy on Vercel

The Vercel CLI is installed but not logged in on this machine. Either:

**Option A — via dashboard (recommended):**

1. Go to **[vercel.com](https://vercel.com)** → **Add New… → Project**.
2. Import `Markodjole/camtok`.
3. **Root Directory:** leave as repo root. The included `vercel.json` already sets:
   - Framework: `nextjs`
   - Install: `pnpm install`
   - Build: `pnpm exec turbo build --filter=@bettok/web`
   - Output: `apps/web/.next`
4. Add **Environment Variables** (copy from your local `apps/web/.env.local`):
   - `NEXT_PUBLIC_SUPABASE_URL` → `https://jiecaxoziolwefitdfqg.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → (anon key from Supabase → Settings → API)
   - `SUPABASE_SERVICE_ROLE_KEY` → (service_role key from Supabase → Settings → API)
   - Plus any Fal AI / other keys present in `.env.local`.
5. **Deploy**, then copy the resulting URL.

**Option B — via CLI:**

```bash
vercel login
vercel link
vercel --prod
```

(Then add env vars via `vercel env add` or the dashboard.)

---

## 3. Set Supabase auth URLs

Dashboard-only step. After you have the Vercel URL:

1. Supabase dashboard → **Authentication → URL Configuration**.
2. **Site URL:** `https://<your-vercel-url>`
3. **Redirect URLs:** add
   - `https://<your-vercel-url>/**`
   - `https://<your-vercel-url>/auth/callback`
4. Save.

---

## 4. Open on your phone

Navigate to your Vercel URL in mobile Safari/Chrome; add to home screen for an app-like shortcut.

---

For build-command reference see **DEPLOY.md**.
