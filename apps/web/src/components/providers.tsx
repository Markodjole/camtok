"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { useUserStore } from "@/stores/user-store";
import { ToastProvider } from "@/components/ui/toast";
import { ensureWalletLiveBalance } from "@/actions/wallet";

function AuthSync() {
  const setProfile = useUserStore((s) => s.setProfile);
  const setWallet = useUserStore((s) => s.setWallet);
  const setLoading = useUserStore((s) => s.setLoading);
  const loadInflightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient();

    function loadUser(): Promise<void> {
      if (loadInflightRef.current) return loadInflightRef.current;

      const run = (async () => {
        const {
          data: { user },
        } = await getUserQueued();

        if (!user) {
          setProfile(null);
          setWallet(null);
          return;
        }

        const ensured = await ensureWalletLiveBalance();
        if ("error" in ensured) return;
        if (ensured.profile) setProfile(ensured.profile as never);
        if (ensured.wallet) setWallet(ensured.wallet as never);
      })().finally(() => {
        setLoading(false);
        loadInflightRef.current = null;
      });

      loadInflightRef.current = run;
      return run;
    }

    void loadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) {
        setProfile(null);
        setWallet(null);
        setLoading(false);
        return;
      }
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void loadUser();
      }
    });

    return () => subscription.unsubscribe();
  }, [setProfile, setWallet, setLoading]);

  return null;
}

function OrientationLock() {
  useEffect(() => {
    const tryLock = async () => {
      try {
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (orientation: "portrait" | "portrait-primary" | "portrait-secondary") => Promise<void>;
        };
        if (typeof orientation?.lock === "function") {
          await orientation.lock("portrait");
        }
      } catch {
        // Some browsers require fullscreen/PWA context or don't support lock.
      }
    };

    void tryLock();
    const onChange = () => void tryLock();
    window.addEventListener("orientationchange", onChange);
    window.addEventListener("focus", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("orientationchange", onChange);
      window.removeEventListener("focus", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);

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
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthSync />
        <OrientationLock />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
