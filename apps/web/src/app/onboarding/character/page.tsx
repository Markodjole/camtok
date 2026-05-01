"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Sparkles, Upload } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import {
  type CharacterOnboardingDraft,
  type SpeedTendency,
  type OvertakingStyle,
  type PatienceLevel,
  type RiskLevel,
  type VehicleStyle,
  type RouteType,
  type Transmission,
  getCharacterOnboardingState,
  saveCharacterOnboardingDraft,
  finalizeCharacterOnboarding,
} from "@/actions/character-onboarding";
import {
  isLikelyImageFile,
  normalizeImageUploadContentType,
} from "@/lib/storage/upload-content-type";
import { cn } from "@/lib/utils";
import type { ComfortVsSpeed, PathStyle } from "@/lib/live/routing/drivingRouteStyle";

const STEPS = ["Vehicle", "Driving", "Review"] as const;

type Chip<T extends string> = { value: T; label: string };

const VEHICLE_TYPES: Chip<CharacterOnboardingDraft["entityType"] & string>[] = [
  { value: "car", label: "Car" },
  { value: "motorcycle", label: "Motorcycle" },
  { value: "bike", label: "Bike" },
  { value: "scooter", label: "Scooter" },
  { value: "other", label: "Other" },
];

const VEHICLE_STYLES: Chip<VehicleStyle>[] = [
  { value: "sporty", label: "Sporty" },
  { value: "practical", label: "Practical" },
  { value: "flashy", label: "Flashy" },
  { value: "beater", label: "Beater" },
];

const TRANSMISSIONS: Chip<Transmission>[] = [
  { value: "manual", label: "Manual" },
  { value: "automatic", label: "Automatic" },
  { value: "na", label: "N/A" },
];

const ROUTE_TYPES: Chip<RouteType>[] = [
  { value: "city_center", label: "City center" },
  { value: "suburbs", label: "Suburbs" },
  { value: "highway", label: "Highway" },
  { value: "mixed", label: "Mixed" },
];

const SPEED_TENDENCIES: Chip<SpeedTendency>[] = [
  { value: "always_legal", label: "Always legal" },
  { value: "slightly_above", label: "Slightly above" },
  { value: "significantly_above", label: "Significantly above" },
  { value: "whatever", label: "Whatever feels right" },
];

const OVERTAKING_STYLES: Chip<OvertakingStyle>[] = [
  { value: "never", label: "Never" },
  { value: "when_safe", label: "When clearly safe" },
  { value: "regularly", label: "Regularly" },
  { value: "any_gap", label: "Any gap works" },
];

const PATIENCE_LEVELS: Chip<PatienceLevel>[] = [
  { value: "very_patient", label: "Very patient" },
  { value: "normal", label: "Normal" },
  { value: "gets_frustrated", label: "Gets frustrated" },
  { value: "road_rage", label: "Road rage" },
];

const RISK_LEVELS: Chip<RiskLevel>[] = [
  { value: "ultra_careful", label: "Ultra careful" },
  { value: "calculated", label: "Calculated" },
  { value: "risk_taker", label: "Risk taker" },
  { value: "full_send", label: "Full send" },
];

const ROUTE_COMFORT: Chip<ComfortVsSpeed>[] = [
  { value: "comfort", label: "Comfort first — calmer ETA routing" },
  { value: "balanced", label: "Balanced" },
  { value: "speed", label: "Time matters — fastest sensible route" },
];

const ROUTE_PATH: Chip<PathStyle>[] = [
  {
    value: "smooth",
    label: "Smoother roads — prefers avoiding highways when driving",
  },
  { value: "balanced", label: "Balanced road choice" },
  { value: "direct", label: "Direct — shortcuts & major roads OK" },
];

function ChipGroup<T extends string>({
  chips,
  value,
  onChange,
}: {
  chips: Chip<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onChange(c.value)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            value === c.value
              ? "border-primary bg-primary/15 text-foreground"
              : "border-border text-muted-foreground hover:border-primary/40",
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function InnerOnboarding() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const forceUpdate = searchParams.get("update") === "1";

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);
  const [primaryCharacterId, setPrimaryCharacterId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [alreadyCompletedHub, setAlreadyCompletedHub] = useState(false);

  const [draft, setDraft] = useState<CharacterOnboardingDraft>({ miniGame: {} });

  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await getCharacterOnboardingState();
      if (cancelled) return;
      if (!state.authenticated) { router.replace("/auth/login"); return; }
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
        characterName: state.draft.characterName ?? state.displayName ?? prev.characterName,
      }));
      setStep(typeof state.draft.step === "number" ? state.draft.step : 0);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [router, forceUpdate]);

  const persistDraft = useCallback(
    async (next: CharacterOnboardingDraft, nextStep?: number) => {
      const merged = { ...next, step: nextStep ?? step };
      setDraft(merged);
      const { error } = await saveCharacterOnboardingDraft(merged);
      if (error) toast({ title: "Could not save progress", description: error, variant: "destructive" });
    },
    [step, toast],
  );

  async function uploadToMedia(file: File, label: string) {
    const { data: { user } } = await getUserQueued();
    if (!user) throw new Error("Not signed in");
    const ext = file.name.split(".").pop() || "jpg";
    const storagePath = `user_characters/${user.id}/${label}_${Date.now()}.${ext}`;
    const contentType = normalizeImageUploadContentType(file);
    const buf = await file.arrayBuffer();
    const safeName = file.name.replace(/[^\w.-]+/g, "_") || "upload";
    const body = new File([buf], safeName, { type: contentType, lastModified: file.lastModified });
    const supabase = createBrowserClient();
    const { error } = await supabase.storage.from("media").upload(storagePath, body, { upsert: true, contentType });
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
      await persistDraft({ ...draft, primaryImagePath: path });
      toast({ title: "Photo uploaded", variant: "success" });
    } catch (err: unknown) {
      toast({ title: "Upload failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    }
  }

  function chip<T extends string>(
    field: keyof CharacterOnboardingDraft,
    value: T,
  ) {
    const next = { ...draft, [field]: value };
    void persistDraft(next);
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      const res = await finalizeCharacterOnboarding({ draft, updateExisting: forceUpdate && !!primaryCharacterId });
      if (res.error) {
        toast({ title: "Could not build driver profile", description: res.error, variant: "destructive" });
        return;
      }
      toast({
        title: hasCompletedOnboarding && forceUpdate ? "Driver profile updated" : "Driver profile ready",
        description: "Your Camtok driver character is set up. Go live!",
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
              <CardTitle>Driver profile set up</CardTitle>
              <CardDescription>Update your vehicle, style, or driving behavior — or go straight to live.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button asChild><Link href="/onboarding/character?update=1">Edit driver profile</Link></Button>
              <Button variant="outline" asChild><Link href="/live">Back to live</Link></Button>
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
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Driver profile builder</p>
            <h1 className="text-2xl font-bold tracking-tight">Quick driver setup</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Short setup with only key choices. No extra questions.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Step {step + 1} / {STEPS.length}</span>
              <span>{STEPS[step]}</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>

          {/* ── Step 0: Vehicle ── */}
          {step === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Vehicle</CardTitle>
                <CardDescription>Select what you drive and upload one photo.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Vehicle type</label>
                  <ChipGroup
                    chips={VEHICLE_TYPES}
                    value={draft.entityType}
                    onChange={(v) => chip("entityType", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Vehicle vibe</label>
                  <ChipGroup
                    chips={VEHICLE_STYLES}
                    value={draft.vehicleStyle}
                    onChange={(v) => chip("vehicleStyle", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Transmission</label>
                  <ChipGroup
                    chips={TRANSMISSIONS}
                    value={draft.transmission}
                    onChange={(v) => chip("transmission", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Typical routes</label>
                  <ChipGroup
                    chips={ROUTE_TYPES}
                    value={draft.typicalRoutes}
                    onChange={(v) => chip("typicalRoutes", v)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Driver photo</label>
                  <Button type="button" variant="outline" className="gap-2" asChild>
                    <label>
                      <Upload className="h-4 w-4" />
                      {draft.primaryImagePath ? "Change photo" : "Upload photo"}
                      <input type="file" accept="image/*" className="hidden" onChange={onPickPrimaryImage} />
                    </label>
                  </Button>
                  {draft.primaryImagePath && (
                    <p className="text-xs text-emerald-500">Photo uploaded</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Step 1: Driving style ── */}
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Driving style</CardTitle>
                <CardDescription>Pick concise behavior presets.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Speed tendency</label>
                  <ChipGroup
                    chips={SPEED_TENDENCIES}
                    value={draft.speedTendency}
                    onChange={(v) => chip("speedTendency", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Overtaking</label>
                  <ChipGroup
                    chips={OVERTAKING_STYLES}
                    value={draft.overtakingStyle}
                    onChange={(v) => chip("overtakingStyle", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Patience in traffic</label>
                  <ChipGroup
                    chips={PATIENCE_LEVELS}
                    value={draft.patienceLevel}
                    onChange={(v) => chip("patienceLevel", v)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Risk level</label>
                  <ChipGroup
                    chips={RISK_LEVELS}
                    value={draft.riskLevel}
                    onChange={(v) => chip("riskLevel", v)}
                  />
                </div>
                <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 p-4 space-y-4">
                  <p className="text-sm font-semibold text-foreground">
                    Navigation while live
                  </p>
                  <p className="text-xs text-muted-foreground">
                    These tune Google routes and where blue decision pins appear. Viewers see short tags on the map (e.g. “Avoids highways”).
                  </p>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Comfort vs speed</label>
                    <ChipGroup
                      chips={ROUTE_COMFORT}
                      value={draft.routeComfortVsSpeed}
                      onChange={(v) => chip("routeComfortVsSpeed", v)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Route shape</label>
                    <ChipGroup
                      chips={ROUTE_PATH}
                      value={draft.routePathStyle}
                      onChange={(v) => chip("routePathStyle", v)}
                    />
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background/80 p-3 text-left">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!!draft.routeEcoConscious}
                      onChange={(e) => {
                        void persistDraft({
                          ...draft,
                          routeEcoConscious: e.target.checked,
                        });
                      }}
                    />
                    <span>
                      <span className="text-sm font-medium">Eco & toll saver</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Prefer fewer tolls and a lighter routing footprint when supported.
                      </span>
                    </span>
                  </label>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Step 2: Review ── */}
          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Review</CardTitle>
                <CardDescription>
                  Final check before creating the profile.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p><span className="font-medium text-foreground">Photo:</span> {draft.primaryImagePath ? "set" : "missing — go back to Step 1"}</p>
                <p><span className="font-medium text-foreground">Vehicle:</span> {draft.entityType ?? "not set"} · {draft.vehicleStyle ?? ""} · {draft.transmission ?? ""}</p>
                <p><span className="font-medium text-foreground">Speed:</span> {draft.speedTendency?.replace("_", " ") ?? "not set"}</p>
                <p><span className="font-medium text-foreground">Overtaking:</span> {draft.overtakingStyle?.replace("_", " ") ?? "not set"}</p>
                <p><span className="font-medium text-foreground">Patience:</span> {draft.patienceLevel?.replace("_", " ") ?? "not set"}</p>
                <p><span className="font-medium text-foreground">Risk level:</span> {draft.riskLevel?.replace("_", " ") ?? "not set"}</p>
                <p>
                  <span className="font-medium text-foreground">Live routing:</span>{" "}
                  {draft.routeComfortVsSpeed ?? "auto from answers"} ·{" "}
                  {draft.routePathStyle ?? "auto"} ·{" "}
                  {draft.routeEcoConscious ? "eco on" : "eco off"}
                </p>
                <Button
                  type="button"
                  className="mt-4 w-full gap-2"
                  disabled={submitting || !draft.primaryImagePath}
                  onClick={handleFinish}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {forceUpdate && primaryCharacterId ? "Update driver profile" : "Create driver profile"}
                </Button>
                {!draft.primaryImagePath && (
                  <p className="text-xs text-amber-500">
                    Photo required.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Navigation ── */}
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
