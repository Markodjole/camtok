"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronRight, Sparkles } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCharacters } from "@/actions/characters";
import { getMediaUrl, formatCompactNumber } from "@/lib/utils";

type CharacterRow = {
  id: string;
  slug: string | null;
  name: string;
  tagline: string | null;
  total_videos: number;
  total_resolutions: number;
  total_bets_received: number;
  betting_signals?: {
    quick_read?: string[];
    choice_patterns?: Record<string, number>;
    behavior_patterns?: Record<string, number>;
  } | null;
  reference_images: Array<{
    image_storage_path: string;
    is_primary: boolean;
  }>;
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-2 py-1.5 text-center">
      <p className="text-sm font-semibold text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function CharacterCard({ c }: { c: CharacterRow }) {
  const primary = c.reference_images.find((x) => x.is_primary) ?? c.reference_images[0];
  const imageUrl = getMediaUrl(primary?.image_storage_path ?? null);

  const topChoice = useMemo(() => {
    const entries = Object.entries(c.betting_signals?.choice_patterns ?? {});
    if (entries.length === 0) return null;
    entries.sort(([, a], [, b]) => b - a);
    return entries[0];
  }, [c.betting_signals]);

  const topBehavior = useMemo(() => {
    const entries = Object.entries(c.betting_signals?.behavior_patterns ?? {});
    if (entries.length === 0) return null;
    entries.sort(([, a], [, b]) => b - a);
    return entries[0];
  }, [c.betting_signals]);

  const profileHref = c.slug ? `/character/${c.slug}` : `/character/${c.id}`;
  const createHref = c.slug ? `/create?character=${c.slug}` : `/create`;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex">
          <Link href={profileHref} className="relative h-28 w-24 shrink-0 bg-muted">
            {imageUrl ? (
              <Image src={imageUrl} alt={c.name} fill className="object-cover" />
            ) : null}
          </Link>
          <div className="flex-1 space-y-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <Link href={profileHref} className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{c.name}</p>
                {c.tagline ? (
                  <p className="line-clamp-1 text-[11px] text-muted-foreground">{c.tagline}</p>
                ) : null}
              </Link>
              <Link href={profileHref} className="text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <Stat label="Videos" value={formatCompactNumber(c.total_videos)} />
              <Stat label="Resolved" value={formatCompactNumber(c.total_resolutions)} />
              <Stat label="Bets" value={formatCompactNumber(c.total_bets_received)} />
            </div>

            <div className="space-y-1">
              {topChoice ? (
                <Badge variant="secondary" className="mr-1 text-[10px]">
                  Choice: {topChoice[0].replace(/_/g, " ")} ({Math.round(topChoice[1] * 100)}%)
                </Badge>
              ) : null}
              {topBehavior ? (
                <Badge variant="outline" className="text-[10px]">
                  Behavior: {topBehavior[0].replace(/_/g, " ")} ({Math.round(topBehavior[1] * 100)}%)
                </Badge>
              ) : null}
            </div>

            <div className="flex gap-2">
              <Button asChild size="sm" className="h-7 text-[11px]">
                <Link href={createHref}>Create with {c.name}</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" className="h-7 text-[11px]">
                <Link href={profileHref}>View stats</Link>
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CharactersPage() {
  const [loading, setLoading] = useState(true);
  const [characters, setCharacters] = useState<CharacterRow[]>([]);

  useEffect(() => {
    async function load() {
      const { characters: rows } = await getCharacters();
      setCharacters((rows ?? []) as CharacterRow[]);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar p-4">
        <div className="mb-4">
          <h1 className="text-lg font-bold">Characters</h1>
          <p className="text-xs text-muted-foreground">
            Explore behavior patterns, stats, and predictability before betting.
          </p>
        </div>

        <Card className="mb-3 border-primary/30 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BarChart3 className="h-4 w-4 text-primary" />
              Stats-first mode
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-muted-foreground">
            No story fluff. Focus on probabilities, recent outcomes, and win-rate patterns.
          </CardContent>
        </Card>

        <div className="space-y-3 pb-2">
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-3">
                    <Skeleton className="h-24 w-full" />
                  </CardContent>
                </Card>
              ))
            : characters.map((c) => <CharacterCard key={c.id} c={c} />)}
        </div>

        <Button asChild variant="secondary" className="mt-2 gap-2">
          <Link href="/create">
            <Sparkles className="h-4 w-4" />
            Create new character clip
          </Link>
        </Button>
      </div>
    </AppShell>
  );
}

