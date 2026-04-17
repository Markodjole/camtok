import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function GoLiveIndexPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login?redirect=/live/go");
  }

  const { data: characters } = await supabase
    .from("characters")
    .select("id, name")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  let devCharacters: Array<{ id: string; name: string }> = [];
  const allowDevBypass = process.env.NODE_ENV !== "production";
  if (allowDevBypass && (!characters || characters.length === 0)) {
    const { data } = await supabase
      .from("characters")
      .select("id, name")
      .order("created_at", { ascending: false })
      .limit(50);
    devCharacters = data ?? [];
  }
  const list = (characters && characters.length > 0 ? characters : devCharacters) ?? [];

  return (
    <AppShell>
      <div className="mx-auto h-full max-w-md overflow-y-auto p-4">
        <h1 className="text-2xl font-semibold">Go live</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick which character profile you want to stream from.
        </p>

        <div className="mt-4 space-y-2">
          {allowDevBypass && (!characters || characters.length === 0) && devCharacters.length > 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              Dev mode: no owned characters found, showing all characters so you can test streaming locally.
            </div>
          ) : null}
          {list.map((character) => (
            <Link
              key={character.id}
              href={`/live/go/${character.id}`}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-3 text-sm hover:bg-muted/40"
            >
              <span>{character.name}</span>
              <span className="text-primary">Go live</span>
            </Link>
          ))}
        </div>

        {list.length === 0 && (
          <div className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No owned characters found. Create one first to start streaming.
          </div>
        )}
      </div>
    </AppShell>
  );
}
