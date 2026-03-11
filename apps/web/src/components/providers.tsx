"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { useUserStore } from "@/stores/user-store";
import { ToastProvider } from "@/components/ui/toast";
import { ensureProfileAndWallet } from "@/actions/wallet";

function AuthSync() {
  const setProfile = useUserStore((s) => s.setProfile);
  const setWallet = useUserStore((s) => s.setWallet);
  const setLoading = useUserStore((s) => s.setLoading);

  useEffect(() => {
    const supabase = createBrowserClient();

    async function loadUser() {
      const {
        data: { user },
      } = await getUserQueued();

      if (!user) {
        setLoading(false);
        return;
      }

      const [profileRes, walletRes] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase.from("wallets").select("*").eq("user_id", user.id).maybeSingle(),
      ]);

      let profile = profileRes.data;
      let wallet = walletRes.data;

      if (!profile || !wallet) {
        const ensured = await ensureProfileAndWallet();
        if (!("error" in ensured)) {
          profile = ensured.profile as never;
          wallet = ensured.wallet as never;
        }
      }

      if (profile) setProfile(profile);
      if (wallet) setWallet(wallet);
      setLoading(false);
    }

    loadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setProfile(null);
        setWallet(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [setProfile, setWallet, setLoading]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 90_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthSync />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
