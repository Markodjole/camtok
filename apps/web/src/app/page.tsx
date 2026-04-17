import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isLocalSupabase =
    process.env.NODE_ENV === "development" &&
    (supabaseUrl.includes("127.0.0.1") || supabaseUrl.includes("localhost"));

  if (isLocalSupabase) {
    redirect("/auth/login");
  }

  const supabase = await createServerClient();
  let user: { id: string } | null = null;
  try {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    user = authUser;
  } catch {
    user = null;
  }

  if (user) {
    redirect("/live");
  }

  redirect("/auth/login");
}
