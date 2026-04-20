"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Sparkles, Upload } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import {
  type CharacterOnboardingDraft,
  type OnboardingMiniGameKey,
  getCharacterOnboardingState,
  saveCharacterOnboardingDraft,
  finalizeCharacterOnboarding,
} from "@/actions/character-onboarding";
import { getCharacterById, getCharacters } from "@/actions/characters";
import { cn } from "@/lib/utils";
import {
  isLikelyImageFile,
  isLikelyVideoFile,
  normalizeImageUploadContentType,
  normalizeVideoUploadContentType,
} from "@/lib/storage/upload-content-type";

const STEPS = ["You", "Photos & video", "Quick choices", "Profile", "Archetypes", "Review"] as const;

const MINI_GAME: Array<{
  key: OnboardingMiniGameKey;
  title: string;
  a: string;
  b: string;
}> = [
  {
    key: "snack_aisle",
    title: "Snack run",
    a: "Grab the usual favorites",
    b: "Try something new that catches your eye",
  },
  {
    key: "crosswalk",
    title: "Crosswalk",
    a: "Go when it feels clear, keep momentum",
    b: "Wait for the signal even if others cross",
  },
  {
    key: "party_invite",
    title: "Invite drops in chat",
    a: "Say yes and figure logistics later",
    b: "Ask who / where / when before committing",
  },
  {
    key: "group_project",
    title: "Group project",
    a: "Step up to coordinate the team",
    b: "Take a clear slice you can own solo",
  },
  {
    key: "return_policy",
    title: "Big purchase",
    a: "Read return policy and warranty first",
    b: "Buy now, handle details if it breaks",
  },
  {
    key: "weekend_plan",
    title: "Weekend energy",
    a: "Spontaneous plan beats a quiet weekend",
    b: "Comfortable routine beats surprise chaos",
  },
];

function InnerOnboarding() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const forceUpdate = searchParams.get("update") === "1";

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);
  const [primaryCharacterId, setPrimaryCharacterId] = useState<string | null>(null);
  const [platformSlugs, setPlatformSlugs] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** Finished onboarding before — show a hub instead of forcing them through the wizard again. */
  const [alreadyCompletedHub, setAlreadyCompletedHub] = useState(false);

  const [draft, setDraft] = useState<CharacterOnboardingDraft>({
    miniGame: {},
    favoriteCharacterSlugs: [],
  });

  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await getCharacterOnboardingState();
      if (cancelled) return;
      if (!state.authenticated) {
        router.replace("/auth/login");
        return;
      }
      if (state.completed && !forceUpdate) {
        setHasCompletedOnboarding(true);
        setAlreadyCompletedHub(true);
        setLoading(false);
        return;
      }
      setHasCompletedOnboarding(!!state.completed);
      setPrimaryCharacterId(state.primaryCharacterId);
      setDraft((prev) => ({
        ...state.draft,
        miniGame: { ...prev.miniGame, ...state.draft.miniGame },
        favoriteCharacterSlugs:
          state.draft.favoriteCharacterSlugs ?? prev.favoriteCharacterSlugs ?? [],
        characterName: state.draft.characterName ?? state.displayName ?? prev.characterName,
      }));
      setStep(typeof state.draft.step === "number" ? state.draft.step : 0);

      const chars = await getCharacters();
      const slugs = (chars.characters ?? [])
        .filter((c) => !c.creator_user_id)
        .map((c) => c.slug)
        .filter((s): s is string => !!s);
      setPlatformSlugs(slugs);

      if (forceUpdate && state.primaryCharacterId) {
        const ch = await getCharacterById(state.primaryCharacterId);
        if (ch.character && !cancelled) {
          const c = ch.character;
          setDraft((prev) => ({
            ...prev,
            characterName: c.name,
            tagline: c.tagline ?? "",
            backstory: c.backstory ?? "",
            entityType: c.camtok_entity_type ?? "pedestrian",
            cityZone:
              typeof c.camtok_content?.city_zone === "string" ? (c.camtok_content.city_zone as string) : "",
            preferredHours: Array.isArray(c.camtok_content?.preferred_hours)
              ? (c.camtok_content.preferred_hours as string[]).join(", ")
              : "",
            visualStyle:
              typeof c.camtok_content?.visual_style === "string" ? (c.camtok_content.visual_style as string) : "",
            recurringStoryElements: Array.isArray(c.camtok_content?.recurring_story_elements)
              ? (c.camtok_content.recurring_story_elements as string[]).join(", ")
              : "",
            foodLikes: c.preferences?.food?.likes?.join(", ") ?? "",
            foodDislikes: c.preferences?.food?.dislikes?.join(", ") ?? "",
            activityLikes: c.preferences?.activities?.likes?.join(", ") ?? "",
            activityDislikes: c.preferences?.activities?.dislikes?.join(", ") ?? "",
            brandLikes: c.preferences?.brands?.likes?.join(", ") ?? "",
            brandDislikes: c.preferences?.brands?.dislikes?.join(", ") ?? "",
            shoppingStyle: c.preferences?.shopping ?? "",
            speakingTone: c.voice?.tone ?? "",
            vocabulary: c.voice?.vocabulary ?? "",
            catchphrases: c.voice?.catchphrases?.join(", ") ?? "",
            primaryImagePath: c.reference_images?.[0]?.image_storage_path ?? prev.primaryImagePath,
          }));
        }
      }

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, forceUpdate]);

  const persistDraft = useCallback(
    async (next: CharacterOnboardingDraft, nextStep?: number) => {
      const merged = { ...next, step: nextStep ?? step };
      setDraft(merged);
      const { error } = await saveCharacterOnboardingDraft(merged);
      if (error) {
        toast({ title: "Could not save progress", description: error, variant: "destructive" });
      }
    },
    [step, toast],
  );

  async function uploadToMedia(file: File, label: string) {
    const {
      data: { user },
    } = await getUserQueued();
    if (!user) throw new Error("Not signed in");
    const ext = file.name.split(".").pop() || (isLikelyVideoFile(file) ? "mp4" : "jpg");
    const storagePath = `user_characters/${user.id}/${label}_${Date.now()}.${ext}`;
    const contentType = isLikelyVideoFile(file)
      ? normalizeVideoUploadContentType(file)
      : normalizeImageUploadContentType(file);
    const buf = await file.arrayBuffer();
    const safeName = file.name.replace(/[^\w.-]+/g, "_") || "upload";
    const body = new File([buf], safeName, { type: contentType, lastModified: file.lastModified });
    const supabase = createBrowserClient();
    const { error } = await supabase.storage.from("media").upload(storagePath, body, {
      upsert: true,
      contentType,
    });
    if (error) throw new Error(error.message);
    return storagePath;
  }

  async function onPickPrimaryImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !isLikelyImageFile(file)) {
      toast({ title: "Pick an image", description: "JPG, PNG, WebP, or HEIC", variant: "destructive" });
      return;
    }
    try {
      const path = await uploadToMedia(file, "primary");
      const next = { ...draft, primaryImagePath: path };
      await persistDraft(next);
      toast({ title: "Photo uploaded", variant: "success" });
    } catch (err: unknown) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onPickExtraImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !isLikelyImageFile(file)) {
      toast({ title: "Pick an image", description: "JPG, PNG, WebP, or HEIC", variant: "destructive" });
      return;
    }
    try {
      const path = await uploadToMedia(file, "extra");
      const extras = [...(draft.extraImagePaths ?? []), path].slice(0, 6);
      const next = { ...draft, extraImagePaths: extras };
      await persistDraft(next);
      toast({ title: "Extra photo saved", variant: "success" });
    } catch (err: unknown) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function onPickVideo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !isLikelyVideoFile(file)) {
      toast({ title: "Pick a short video", description: "MP4, WebM, or MOV", variant: "destructive" });
      return;
    }
    try {
      const path = await uploadToMedia(file, "intro");
      const next = { ...draft, introVideoPath: path };
      await persistDraft(next);
      toast({ title: "Intro video saved", variant: "success" });
    } catch (err: unknown) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  function setMini(key: OnboardingMiniGameKey, value: "a" | "b") {
    const next = {
      ...draft,
      miniGame: { ...draft.miniGame, [key]: value },
    };
    void persistDraft(next);
  }

  function toggleArchetype(slug: string) {
    const cur = new Set(draft.favoriteCharacterSlugs ?? []);
    if (cur.has(slug)) cur.delete(slug);
    else cur.add(slug);
    const next = { ...draft, favoriteCharacterSlugs: Array.from(cur).slice(0, 6) };
    void persistDraft(next);
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      const res = await finalizeCharacterOnboarding({
        draft,
        updateExisting: forceUpdate && !!primaryCharacterId,
      });
      if (res.error) {
        toast({ title: "Could not build character", description: res.error, variant: "destructive" });
        return;
      }
      toast({
        title: hasCompletedOnboarding && forceUpdate ? "Character updated" : "Character ready",
        description: "Your Camtok live profile is ready for route play and market decisions.",
        variant: "success",
      });
      router.replace("/live");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  if (alreadyCompletedHub) {
    return (
      <AppShell>
        <div className="flex h-full flex-col overflow-y-auto p-4">
          <Card className="mx-auto w-full max-w-md">
            <CardHeader>
              <CardTitle>You already have a character</CardTitle>
              <CardDescription>
                Optional: refresh your profile data, photos, and signals. Or go back to live.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button asChild>
                <Link href="/onboarding/character?update=1">Edit my character</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/live">Back to live</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="space-y-4 p-4 pb-32">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Character builder
            </p>
            <h1 className="text-2xl font-bold tracking-tight">Build your on-screen self</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Camtok-native setup: live entity type, safety bounds, route context, and behavior profile from
              your answers.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Step {step + 1} / {STEPS.length}
              </span>
              <span>{STEPS[step]}</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>

          {step === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Identity</CardTitle>
                <CardDescription>Core profile for live runs and markets.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="cname">
                    Character name
                  </label>
                  <Input
                    id="cname"
                    value={draft.characterName ?? ""}
                    onChange={(e) => setDraft({ ...draft, characterName: e.target.value })}
                    onBlur={() => persistDraft({ ...draft, characterName: draft.characterName })}
                    placeholder="e.g. Alex"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="tag">
                    Tagline
                  </label>
                  <Input
                    id="tag"
                    value={draft.tagline ?? ""}
                    onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                    onBlur={() => persistDraft({ ...draft, tagline: draft.tagline })}
                    placeholder="One line vibe"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Entity type</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["pedestrian", "bike", "car", "other"] as const).map((t) => (
                      <Button
                        key={t}
                        type="button"
                        variant={(draft.entityType ?? "pedestrian") === t ? "default" : "outline"}
                        onClick={() => {
                          const next = { ...draft, entityType: t };
                          setDraft(next);
                          void persistDraft(next);
                        }}
                        className="capitalize"
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="bio">
                    Short backstory
                  </label>
                  <textarea
                    id="bio"
                    className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[100px] w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                    value={draft.backstory ?? ""}
                    onChange={(e) => setDraft({ ...draft, backstory: e.target.value })}
                    onBlur={() => persistDraft({ ...draft, backstory: draft.backstory })}
                    placeholder="Where you’re from, what you care about, what annoys you — plain language is perfect."
                  />
                </div>
                <Input
                  placeholder="City / zone (e.g. Belgrade - Dorcol)"
                  value={draft.cityZone ?? ""}
                  onChange={(e) => setDraft({ ...draft, cityZone: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, cityZone: draft.cityZone })}
                />
                <Input
                  placeholder="Preferred hours (comma separated, e.g. evening, late-night)"
                  value={draft.preferredHours ?? ""}
                  onChange={(e) => setDraft({ ...draft, preferredHours: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, preferredHours: draft.preferredHours })}
                />
              </CardContent>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Photos & optional intro clip</CardTitle>
                <CardDescription>
                  We analyze your primary photo into the same appearance JSON used for Kling. Add angles if
                  you have them.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" className="gap-2" asChild>
                    <label>
                      <Upload className="h-4 w-4" />
                      Primary photo
                      <input type="file" accept="image/*" className="hidden" onChange={onPickPrimaryImage} />
                    </label>
                  </Button>
                  <Button type="button" variant="outline" className="gap-2" asChild>
                    <label>
                      <Upload className="h-4 w-4" />
                      Extra angle
                      <input type="file" accept="image/*" className="hidden" onChange={onPickExtraImage} />
                    </label>
                  </Button>
                  <Button type="button" variant="secondary" className="gap-2" asChild>
                    <label>
                      <Upload className="h-4 w-4" />
                      Intro video (optional)
                      <input type="file" accept="video/*" className="hidden" onChange={onPickVideo} />
                    </label>
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Primary: {draft.primaryImagePath ?? "not set"}</p>
                  <p>Extras: {(draft.extraImagePaths ?? []).length} file(s)</p>
                  <p>Video: {draft.introVideoPath ?? "—"}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Quick choices</CardTitle>
                <CardDescription>Fast “game” moments — we map them into Big Five style weights.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {MINI_GAME.map((g) => (
                  <div key={g.key} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-semibold">{g.title}</p>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Button
                        type="button"
                        variant={draft.miniGame?.[g.key] === "a" ? "default" : "outline"}
                        className="h-auto whitespace-normal py-3 text-left"
                        onClick={() => setMini(g.key, "a")}
                      >
                        {g.a}
                      </Button>
                      <Button
                        type="button"
                        variant={draft.miniGame?.[g.key] === "b" ? "default" : "outline"}
                        className="h-auto whitespace-normal py-3 text-left"
                        onClick={() => setMini(g.key, "b")}
                      >
                        {g.b}
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Preferences & voice</CardTitle>
                <CardDescription>Comma-separated lists are fine.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="Foods you love"
                  value={draft.foodLikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, foodLikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, foodLikes: draft.foodLikes })}
                />
                <Input
                  placeholder="Foods you avoid"
                  value={draft.foodDislikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, foodDislikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, foodDislikes: draft.foodDislikes })}
                />
                <Input
                  placeholder="Activities / hobbies"
                  value={draft.activityLikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, activityLikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, activityLikes: draft.activityLikes })}
                />
                <Input
                  placeholder="Activities you dislike"
                  value={draft.activityDislikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, activityDislikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, activityDislikes: draft.activityDislikes })}
                />
                <Input
                  placeholder="Brands you like"
                  value={draft.brandLikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, brandLikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, brandLikes: draft.brandLikes })}
                />
                <Input
                  placeholder="Brands you avoid"
                  value={draft.brandDislikes ?? ""}
                  onChange={(e) => setDraft({ ...draft, brandDislikes: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, brandDislikes: draft.brandDislikes })}
                />
                <Input
                  placeholder="Shopping style in one sentence"
                  value={draft.shoppingStyle ?? ""}
                  onChange={(e) => setDraft({ ...draft, shoppingStyle: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, shoppingStyle: draft.shoppingStyle })}
                />
                <Input
                  placeholder="Speaking tone"
                  value={draft.speakingTone ?? ""}
                  onChange={(e) => setDraft({ ...draft, speakingTone: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, speakingTone: draft.speakingTone })}
                />
                <Input
                  placeholder="Vocabulary (slang, formal, mixed…)"
                  value={draft.vocabulary ?? ""}
                  onChange={(e) => setDraft({ ...draft, vocabulary: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, vocabulary: draft.vocabulary })}
                />
                <Input
                  placeholder="Catchphrases (comma separated)"
                  value={draft.catchphrases ?? ""}
                  onChange={(e) => setDraft({ ...draft, catchphrases: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, catchphrases: draft.catchphrases })}
                />
                <Input
                  placeholder="Visual style (street, sporty, minimal...)"
                  value={draft.visualStyle ?? ""}
                  onChange={(e) => setDraft({ ...draft, visualStyle: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, visualStyle: draft.visualStyle })}
                />
                <Input
                  placeholder="Recurring story elements (comma separated)"
                  value={draft.recurringStoryElements ?? ""}
                  onChange={(e) => setDraft({ ...draft, recurringStoryElements: e.target.value })}
                  onBlur={() => persistDraft({ ...draft, recurringStoryElements: draft.recurringStoryElements })}
                />
                <Input
                  placeholder="Max mission radius meters (e.g. 5000)"
                  inputMode="numeric"
                  value={draft.maxMissionRadiusMeters ?? ""}
                  onChange={(e) => setDraft({ ...draft, maxMissionRadiusMeters: e.target.value })}
                  onBlur={() =>
                    persistDraft({
                      ...draft,
                      maxMissionRadiusMeters: draft.maxMissionRadiusMeters,
                    })
                  }
                />
                <Input
                  placeholder="Forbidden zones (comma separated)"
                  value={draft.safetyForbiddenZones ?? ""}
                  onChange={(e) => setDraft({ ...draft, safetyForbiddenZones: e.target.value })}
                  onBlur={() =>
                    persistDraft({
                      ...draft,
                      safetyForbiddenZones: draft.safetyForbiddenZones,
                    })
                  }
                />
              </CardContent>
            </Card>
          )}

          {step === 4 && (
            <Card>
              <CardHeader>
                <CardTitle>Archetype resonance</CardTitle>
                <CardDescription>
                  Pick up to six default characters you feel closest to — we fold that into tendencies and
                  betting signals.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {platformSlugs.map((slug) => {
                  const active = draft.favoriteCharacterSlugs?.includes(slug);
                  return (
                    <button
                      key={slug}
                      type="button"
                      onClick={() => toggleArchetype(slug)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                        active
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/40",
                      )}
                    >
                      {slug.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {step === 5 && (
            <Card>
              <CardHeader>
                <CardTitle>Review</CardTitle>
                <CardDescription>
                  We merge your live profile, photos, choices, and behavior baseline into one Camtok
                  character row ready for stream routing and market turns.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Name:</span> {draft.characterName}
                </p>
                <p>
                  <span className="font-medium text-foreground">Primary photo:</span>{" "}
                  {draft.primaryImagePath ? "set" : "missing"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Entity type:</span>{" "}
                  {draft.entityType ?? "pedestrian"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Mini-game:</span>{" "}
                  {Object.keys(draft.miniGame ?? {}).length}/{MINI_GAME.length} answered
                </p>
                <Button
                  type="button"
                  className="mt-4 w-full gap-2"
                  disabled={submitting || !draft.primaryImagePath || !draft.characterName?.trim()}
                  onClick={handleFinish}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {forceUpdate && primaryCharacterId ? "Update character" : "Create character"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Sit above AppShell bottom nav (z-50, h-16); was z-20 bottom-0 and fully hidden behind nav */}
          <div className="fixed bottom-16 left-0 right-0 z-[60] border-t border-border bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <div className="mx-auto flex max-w-lg items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1"
                disabled={step === 0}
                onClick={() => {
                  const ns = step - 1;
                  setStep(ns);
                  void persistDraft(draft, ns);
                }}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  type="button"
                  size="sm"
                  className="gap-1"
                  onClick={() => {
                    const ns = step + 1;
                    setStep(ns);
                    void persistDraft(draft, ns);
                  }}
                >
                  Next
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Finish in the card above</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

export default function CharacterOnboardingPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="flex flex-1 items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </AppShell>
      }
    >
      <InnerOnboarding />
    </Suspense>
  );
}
