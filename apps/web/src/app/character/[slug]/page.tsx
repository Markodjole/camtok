import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CharacterAiChat } from "@/components/character/character-ai-chat";
import {
  getCharacterBySlug,
  getCharacterClips,
  getCharacterTraitEvents,
  getCharacterRecentOutcomes,
  getUserVsCharacterStats,
} from "@/actions/characters";
import {
  getMediaUrl,
  formatRelativeTime,
  formatCompactNumber,
} from "@/lib/utils";
import type { CharacterWithImages } from "@/lib/characters/types";

interface CharacterPageProps {
  params: Promise<{ slug: string }>;
}

export default async function CharacterProfilePage({
  params,
}: CharacterPageProps) {
  const { slug } = await params;
  const { character } = await getCharacterBySlug(slug);

  if (!character) {
    notFound();
  }

  const [{ clips }, { events }, recentOutcomes, vsStats] = await Promise.all([
    getCharacterClips(character.id),
    getCharacterTraitEvents(character.id),
    getCharacterRecentOutcomes(character.id, 5),
    getUserVsCharacterStats(character.id),
  ]);

  const primaryImage =
    character.reference_images.find((img) => img.is_primary) ??
    character.reference_images[0];
  const heroSrc = getMediaUrl(primaryImage?.image_storage_path);

  return (
    <AppShell>
      <div className="h-full overflow-y-auto">
        {/* Back button */}
        <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm px-4 py-2">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </Link>
        </div>

        <div className="space-y-4 px-4 pb-8">
          {/* Hero / Header */}
          <div className="relative overflow-hidden rounded-2xl bg-card border border-border">
            {heroSrc ? (
              <div className="relative aspect-[3/4] max-h-[360px] w-full">
                <Image
                  src={heroSrc}
                  alt={character.name}
                  fill
                  className="object-cover"
                  priority
                />
                <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent" />
              </div>
            ) : (
              <div className="aspect-[3/4] max-h-[360px] w-full bg-secondary" />
            )}
            <div className="relative -mt-20 px-4 pb-4 z-[1]">
              <h1 className="text-2xl font-bold text-foreground">
                {character.name}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                slug: {character.slug ?? "n/a"}
              </p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              label="Videos"
              value={formatCompactNumber(character.total_videos)}
            />
            <StatCard
              label="Resolved"
              value={formatCompactNumber(character.total_resolutions)}
            />
            <StatCard
              label="Bets"
              value={formatCompactNumber(character.total_bets_received)}
            />
          </div>

          {/* Betting Edge — user-facing patterns */}
          <BettingEdgeSection character={character} />

          {/* Your Record vs this character */}
          {vsStats.totalBets > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>You vs {character.name}</span>
                  <span className={`text-lg font-bold ${vsStats.netProfit >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {vsStats.netProfit >= 0 ? "+" : ""}${vsStats.netProfit.toFixed(2)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xl font-bold text-foreground">{vsStats.winRate}%</p>
                    <p className="text-[11px] text-muted-foreground">Win Rate</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-green-500">{vsStats.wins}</p>
                    <p className="text-[11px] text-muted-foreground">Wins</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-red-500">{vsStats.losses}</p>
                    <p className="text-[11px] text-muted-foreground">Losses</p>
                  </div>
                </div>
                {vsStats.recentResults.length > 0 && (
                  <div className="mt-3 flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground mr-1">Recent:</span>
                    {vsStats.recentResults.slice(0, 8).map((r, i) => (
                      <span
                        key={i}
                        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${
                          r.won
                            ? "bg-green-500/20 text-green-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {r.won ? "W" : "L"}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Last 5 Outcomes */}
          {recentOutcomes.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Last {recentOutcomes.length} Outcomes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {recentOutcomes.map((o, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-sm">
                    <span className="mt-1 text-primary font-mono text-xs">
                      {i + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground leading-tight">{o.action}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(o.date)}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Profile data */}
          <CollapsibleCard title="Profile Data" defaultOpen={false}>
            <div className="space-y-1.5 text-sm">
              <KeyValueRow label="age_range" value={character.appearance.age_range} />
              <KeyValueRow label="gender_presentation" value={character.appearance.gender_presentation} />
              <KeyValueRow label="build" value={character.appearance.build} />
              <KeyValueRow label="height" value={character.appearance.height} />
              <KeyValueRow
                label="hair"
                value={`${character.appearance.hair.color}, ${character.appearance.hair.style}${character.appearance.hair.facial_hair ? `, ${character.appearance.hair.facial_hair}` : ""}`}
              />
              <KeyValueRow label="skin_tone" value={character.appearance.skin_tone} />
              <KeyValueRow label="outfit_top" value={character.appearance.default_outfit.top} />
              <KeyValueRow label="outfit_bottom" value={character.appearance.default_outfit.bottom} />
              <KeyValueRow label="shoes" value={character.appearance.default_outfit.shoes} />
            </div>
          </CollapsibleCard>

          {/* Personality */}
          <PersonalitySection character={character} />

          {/* Preferences */}
          <PreferencesSection character={character} />

          {/* Trait history */}
          {events.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent Behavior</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {events.slice(0, 20).map((evt, i) => (
                  <div
                    key={(evt.id as string) ?? i}
                    className="flex items-start gap-3 text-sm"
                  >
                    <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground">
                        {evt.action_taken as string}
                      </p>
                      {evt.context ? (
                        <p className="text-xs text-muted-foreground">
                          {String(evt.context)}
                        </p>
                      ) : null}
                      {Array.isArray(evt.trait_tags) &&
                        (evt.trait_tags as string[]).length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(evt.trait_tags as string[]).map((tag) => (
                              <Badge
                                key={tag}
                                variant="secondary"
                                className="text-[10px]"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {formatRelativeTime(evt.created_at as string)}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Video gallery */}
          {clips.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Clips</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2">
                  {clips.map((clip) => {
                    const poster = getMediaUrl(
                      clip.poster_storage_path as string | null,
                    );
                    return (
                      <Link
                        key={clip.id as string}
                        href={`/clip/${clip.id}`}
                        className="group overflow-hidden rounded-lg border border-border bg-secondary/30 transition hover:border-primary/40"
                      >
                        <div className="relative aspect-[9/16]">
                          {poster ? (
                            <Image
                              src={poster}
                              alt=""
                              fill
                              className="object-cover transition group-hover:scale-105"
                            />
                          ) : (
                            <div className="h-full w-full bg-secondary" />
                          )}
                        </div>
                        {clip.scene_summary ? (
                          <p className="line-clamp-2 px-2 py-1.5 text-xs text-muted-foreground">
                            {String(clip.scene_summary)}
                          </p>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* CTA */}
          <Button asChild className="w-full" size="lg">
            <Link href={`/create?character=${slug}`}>
              Create clip with {character.name}
            </Link>
          </Button>
        </div>
      </div>
      <CharacterAiChat characterId={character.id} characterName={character.name} />
    </AppShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-center">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

const BIG_FIVE_LABELS: Record<string, string> = {
  openness: "Open",
  conscientiousness: "Conscientious",
  extraversion: "Extraverted",
  agreeableness: "Agreeable",
  neuroticism: "Neurotic",
};

function PersonalitySection({ character }: { character: CharacterWithImages }) {
  const p = character.personality;
  const bigFive = p.big_five;

  return (
    <CollapsibleCard title="Personality" defaultOpen={false}>
      <div className="space-y-4">
        {/* Big Five */}
        <div className="space-y-2.5">
          {Object.entries(bigFive).map(([key, val]) => (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {BIG_FIVE_LABELS[key] ?? key}
                </span>
                <span className="font-medium text-foreground">
                  {Math.round(val * 100)}%
                </span>
              </div>
              <Progress value={val * 100} className="h-1.5" />
            </div>
          ))}
        </div>

        <div className="space-y-1.5 text-sm">
          <KeyValueRow label="temperament" value={p.temperament} />
          <KeyValueRow label="decision_style" value={p.decision_style} />
          <KeyValueRow label="risk_appetite" value={p.risk_appetite} />
          <KeyValueRow label="social_style" value={p.social_style} />
          <KeyValueRow label="under_pressure" value={p.under_pressure} />
          <KeyValueRow label="attention_span" value={p.attention_span} />
        </div>
      </div>
    </CollapsibleCard>
  );
}

function PreferencesSection({
  character,
}: {
  character: CharacterWithImages;
}) {
  const pref = character.preferences;

  return (
    <CollapsibleCard title="Preferences" defaultOpen={false}>
      <div className="space-y-4">
        <PreferenceGroup title="Food" likes={pref.food.likes} dislikes={pref.food.dislikes} />
        <PreferenceGroup
          title="Activities"
          likes={pref.activities.likes}
          dislikes={pref.activities.dislikes}
        />
        <PreferenceGroup
          title="Brands"
          likes={pref.brands.likes}
          dislikes={pref.brands.dislikes}
        />

        {pref.shopping && <KeyValueRow label="shopping_style" value={pref.shopping} />}

        {pref.general_tendencies.length > 0 && <KeyValueRow label="general_tendencies" value={pref.general_tendencies.join(" | ")} />}
      </div>
    </CollapsibleCard>
  );
}

function CollapsibleCard({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <details className="group" open={defaultOpen}>
        <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-4">
          <CardTitle>{title}</CardTitle>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground transition-transform group-open:rotate-180"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <CardContent>{children}</CardContent>
      </details>
    </Card>
  );
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 pb-1">
      <span className="text-xs font-mono text-muted-foreground">{label}</span>
      <span className="text-right text-sm text-foreground">{value}</span>
    </div>
  );
}

function PreferenceGroup({
  title,
  likes,
  dislikes,
}: {
  title: string;
  likes: string[];
  dislikes: string[];
}) {
  if (likes.length === 0 && dislikes.length === 0) return null;

  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-foreground">
        {title}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="mt-2 space-y-1.5 pl-1">
        {likes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {likes.map((l) => (
              <Badge key={l} variant="success" className="text-[10px]">
                {l}
              </Badge>
            ))}
          </div>
        )}
        {dislikes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {dislikes.map((d) => (
              <Badge key={d} variant="destructive" className="text-[10px]">
                {d}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function BettingEdgeSection({ character }: { character: CharacterWithImages }) {
  const signals = character.betting_signals;
  if (!signals || !signals.quick_read?.length) return null;

  const choicePatterns = signals.choice_patterns ?? {};
  const behaviorPatterns = signals.behavior_patterns ?? {};

  const sortedChoices = Object.entries(choicePatterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const sortedBehaviors = Object.entries(behaviorPatterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary"
          >
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
          Betting Edge
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick read */}
        <div>
          <p className="mb-1.5 text-xs font-semibold text-primary uppercase tracking-wider">
            Quick read
          </p>
          <ul className="space-y-1">
            {signals.quick_read.map((line) => (
              <li key={line} className="text-sm text-foreground">
                • {line}
              </li>
            ))}
          </ul>
        </div>

        {/* Choice patterns with probability bars */}
        {sortedChoices.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Choice patterns
            </p>
            <div className="space-y-2">
              {sortedChoices.map(([key, val]) => (
                <div key={key} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono font-medium text-primary">
                      {Math.round(val * 100)}%
                    </span>
                  </div>
                  <Progress value={val * 100} className="h-1.5" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Behavior patterns */}
        {sortedBehaviors.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Behavior patterns
            </p>
            <div className="space-y-2">
              {sortedBehaviors.map(([key, val]) => (
                <div key={key} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-foreground">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono font-medium text-primary">
                      {Math.round(val * 100)}%
                    </span>
                  </div>
                  <Progress value={val * 100} className="h-1.5" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Exploitable tendencies */}
        {signals.exploitable_tendencies?.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-yellow-500 uppercase tracking-wider">
              Exploitable tendencies
            </p>
            <ul className="space-y-0.5">
              {signals.exploitable_tendencies.map((t) => (
                <li key={t} className="text-xs text-muted-foreground">
                  → {t}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
