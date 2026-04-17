import { notFound, redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { OwnerLiveControlPanel } from "@/components/live/OwnerLiveControlPanel";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function GoLivePage({
  params,
}: {
  params: Promise<{ characterId: string }>;
}) {
  const { characterId } = await params;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/auth/login?redirect=/live/go/${characterId}`);

  const { data: character } = await supabase
    .from("characters")
    .select("id, name, owner_user_id")
    .eq("id", characterId)
    .maybeSingle();
  if (!character) notFound();
  const isOwner = (character as { owner_user_id: string | null }).owner_user_id === user.id;
  const allowDevBypass = process.env.NODE_ENV !== "production";
  if (!isOwner && !allowDevBypass) {
    redirect("/characters");
  }

  return (
    <AppShell>
      <div className="h-full overflow-y-auto">
        <OwnerLiveControlPanel characterId={characterId} />
      </div>
    </AppShell>
  );
}
