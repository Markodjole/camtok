"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, Pencil, Sparkles, Trophy, Target, TrendingUp, Navigation, AlertTriangle, Gauge } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserStore } from "@/stores/user-store";
import { createBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

function StatItem({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 py-3">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <p className="text-xl font-bold">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { profile, isLoading } = useUserStore();

  async function handleLogout() {
    const supabase = createBrowserClient();
    await supabase.auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  const initials = profile?.display_name
    ? profile.display_name.charAt(0).toUpperCase()
    : profile?.username?.charAt(0).toUpperCase() ?? "?";

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="space-y-4 p-4">
          {/* Profile Header */}
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-6">
              {isLoading ? (
                <>
                  <Skeleton className="h-20 w-20 rounded-full" />
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-3 w-20" />
                </>
              ) : (
                <>
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/20 text-primary">
                    <span className="text-3xl font-bold">{initials}</span>
                  </div>
                  <div className="text-center">
                    <h2 className="text-xl font-bold">
                      {profile?.display_name ?? "Anonymous"}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      @{profile?.username ?? "unknown"}
                    </p>
                  </div>
                  {profile?.role && profile.role !== "viewer" && (
                    <Badge variant="default">{profile.role}</Badge>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Betting stats */}
          <Card>
            <CardContent className="p-0">
              <div className="flex divide-x divide-border">
                <StatItem icon={Target} label="Bets" value={profile?.total_bets ?? 0} />
                <StatItem icon={Trophy} label="Wins" value={profile?.total_wins ?? 0} />
                <StatItem icon={TrendingUp} label="Predictions" value={profile?.total_predictions ?? 0} />
              </div>
            </CardContent>
          </Card>

          {/* Driver stats */}
          <Card>
            <CardContent className="p-0">
              <div className="flex divide-x divide-border">
                <StatItem icon={Navigation} label="Sessions" value={(profile as Record<string, unknown> & { sessions_total?: number })?.sessions_total ?? 0} />
                <StatItem icon={AlertTriangle} label="Missed turns" value={(profile as Record<string, unknown> & { missed_turns_total?: number })?.missed_turns_total ?? 0} />
                <StatItem icon={Gauge} label="Km driven" value={Math.round(((profile as Record<string, unknown> & { total_distance_km?: number })?.total_distance_km ?? 0))} />
              </div>
            </CardContent>
          </Card>

          {/* Bio */}
          {profile?.bio && (
            <Card>
              <CardContent className="py-4">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {profile.bio}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <div className="space-y-2">
            <Button asChild variant="outline" className="w-full justify-start gap-2">
              <Link href="/profile/edit">
                <Pencil className="h-4 w-4" />
                Edit Profile
              </Link>
            </Button>

            <Button asChild variant="outline" className="w-full justify-start gap-2">
              <Link
                href={
                  profile?.character_onboarding_completed_at
                    ? "/onboarding/character?update=1"
                    : "/onboarding/character"
                }
              >
                <Sparkles className="h-4 w-4" />
                My driver profile
              </Link>
            </Button>

            <Separator />

            <Button
              variant="destructive"
              className="w-full justify-start gap-2"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
              Log Out
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
