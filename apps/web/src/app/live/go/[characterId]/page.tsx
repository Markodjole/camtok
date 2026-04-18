import { notFound, redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { OwnerLiveControlPanel } from "@/components/live/OwnerLiveControlPanel";

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
    .select("id, name, creator_user_id")
    .eq("id", characterId)
    .maybeSingle();
  if (!character) notFound();
  const isOwner = (character as { creator_user_id: string | null }).creator_user_id === user.id;
  const allowDevBypass = process.env.NODE_ENV !== "production";
  if (!isOwner && !allowDevBypass) {
    redirect("/characters");
  }

  return <OwnerLiveControlPanel characterId={characterId} />;
}
