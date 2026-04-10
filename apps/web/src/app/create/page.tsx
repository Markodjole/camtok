"use client";

export const dynamic = "force-dynamic";


import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Upload, Loader2, ImageIcon, Film, Trash2, Users, ChevronRight, Plus, ArrowLeft, X, Sparkles } from "lucide-react";
import { CharacterFieldWithSuggestions } from "@/components/create/character-field-suggestions";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  getImagePatterns,
  generateFromImagePattern,
  generateFromCustomImage,
  analyzeCustomImage,
  publishDraft,
  improveVideo,
  getPendingReviewDraft,
  dismissDraft,
  deleteDraft,
} from "@/actions/image-pattern-clips";
import {
  generateFromCharacter,
  publishCharacterDraft,
} from "../../actions/character-clips";
import {
  suggestCharacterClipIdeas,
  type CharacterClipAiOption,
} from "@/actions/character-clip-ai-suggestions";
import { getCharacters } from "@/actions/characters";
import type { CharacterWithImages } from "@/lib/characters/types";
import {
  cliffhangersForLocationAndDescription,
  descriptionsForLocation,
  listLocations,
} from "@/lib/characters/clip-suggestions";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { cn, getMediaUrl } from "@/lib/utils";

const PATTERNS_CACHE_KEY = "create:image_patterns:v2";
const PATTERNS_CACHE_TTL_MS = 10 * 60 * 1000;
const CREATE_REVIEW_CACHE_KEY = "create:pending_review:v1";

/** Enough room for a full scene; server still summarizes for the model. */
const ACTION_TEXT_MAX = 1200;
const TENSION_TEXT_MAX = 450;
const LOCATION_TEXT_MAX = 400;

/** Shared styles for create-page mood/camera pickers (readable, theme-aligned). */
const CREATE_SCENE_SELECT_ITEM =
  "rounded-lg py-3 pl-9 pr-3 text-base data-[highlighted]:bg-primary/15 data-[highlighted]:text-foreground";

type CreateMode = "character" | "image";

function CreatePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const customFileRef = useRef<HTMLInputElement>(null);

  // Mode: character vs image-pattern
  const [mode, setMode] = useState<CreateMode>(
    searchParams.get("character") ? "character" : "character",
  );

  // Characters
  const [characters, setCharacters] = useState<CharacterWithImages[]>([]);
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [locationText, setLocationText] = useState("");

  // Custom character creation
  const [creatingCharacter, setCreatingCharacter] = useState(false);
  const [newCharName, setNewCharName] = useState("");
  const [newCharTagline, setNewCharTagline] = useState("");
  const [newCharBackstory, setNewCharBackstory] = useState("");
  const [newCharFile, setNewCharFile] = useState<File | null>(null);
  const [newCharImagePath, setNewCharImagePath] = useState<string | null>(null);
  const [newCharUploading, setNewCharUploading] = useState(false);
  const [newCharAnalyzing, setNewCharAnalyzing] = useState(false);
  const [newCharAppearance, setNewCharAppearance] = useState<Record<string, unknown> | null>(null);
  const [newCharSaving, setNewCharSaving] = useState(false);
  const newCharFileRef = useRef<HTMLInputElement>(null);

  // Patterns from DB
  const [patterns, setPatterns] = useState<any[]>([]);
  const [patternsLoading, setPatternsLoading] = useState(true);
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(null);

  // Custom image upload
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [customImagePath, setCustomImagePath] = useState<string | null>(null);
  const [customUploading, setCustomUploading] = useState(false);
  const [customAnalyzed, setCustomAnalyzed] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);

  // Structured scene input
  const [actionText, setActionText] = useState("");
  const [tensionText, setTensionText] = useState("");
  const [mood, setMood] = useState("neutral");
  const [camera, setCamera] = useState("auto");
  const [running, setRunning] = useState(false);
  /** User closed the full-screen loader; generation still runs until the server returns. */
  const [generationOverlayDismissed, setGenerationOverlayDismissed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Review state
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewVideoPath, setReviewVideoPath] = useState<string | null>(null);
  /** Fal CDN URL when Kling succeeded but our download/upload failed (hydrated on post). */
  const [reviewFalVideoUrl, setReviewFalVideoUrl] = useState<string | null>(null);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [reviewImagePath, setReviewImagePath] = useState<string | null>(null);
  const [reviewSummary, setReviewSummary] = useState<string | null>(null);
  const [reviewLlmGen, setReviewLlmGen] = useState<any>(null);
  const [reviewCharacterId, setReviewCharacterId] = useState<string | null>(null);
  const [improveFeedback, setImproveFeedback] = useState("");
  const [improving, setImproving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [aiClipDialogOpen, setAiClipDialogOpen] = useState(false);
  const [aiClipLoading, setAiClipLoading] = useState(false);
  const [aiClipOptions, setAiClipOptions] = useState<CharacterClipAiOption[]>([]);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Ignore late `getPendingReviewDraft` results after the user started a new generation. */
  const pendingDraftSeqRef = useRef(0);

  useEffect(() => {
    let mounted = true;

    // Load characters
    getCharacters().then((res) => {
      if (!mounted) return;
      setCharacters(res.characters ?? []);
      setCharactersLoading(false);
      const preselect = searchParams.get("character");
      if (preselect && res.characters?.length) {
        const match = res.characters.find(
          (c) => c.slug === preselect || c.id === preselect,
        );
        if (match) {
          setSelectedCharacterId(match.id);
          setMode("character");
        }
      }
    });

    const readCache = () => {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem(PATTERNS_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { ts: number; patterns: any[] };
        if (!parsed?.patterns || !Array.isArray(parsed.patterns)) return null;
        return parsed;
      } catch {
        return null;
      }
    };

    const writeCache = (nextPatterns: any[]) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(
          PATTERNS_CACHE_KEY,
          JSON.stringify({ ts: Date.now(), patterns: nextPatterns }),
        );
      } catch {
        // ignore cache write failures
      }
    };

    const cached = readCache();
    const cacheFresh = !!cached && Date.now() - cached.ts < PATTERNS_CACHE_TTL_MS;

    if (cached?.patterns?.length) {
      setPatterns(cached.patterns);
      setPatternsLoading(false);
    } else {
      setPatternsLoading(true);
    }

    getImagePatterns().then((res: { patterns: any[]; error?: string }) => {
      if (!mounted) return;
      if (res.patterns && Array.isArray(res.patterns)) {
        setPatterns(res.patterns);
        writeCache(res.patterns);
      }
      if (!cacheFresh) setPatternsLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, [searchParams]);

  useEffect(() => {
    // Source of truth recovery from server in case user navigated away during generation.
    const seqAtStart = pendingDraftSeqRef.current;
    getPendingReviewDraft().then((res) => {
      if (pendingDraftSeqRef.current !== seqAtStart) return;
      const d = res.data;
      if (!d?.reviewJobId || (!d.reviewVideoPath && !d.reviewFalVideoUrl)) return;
      setReviewMode(true);
      setReviewVideoPath(d.reviewVideoPath ?? null);
      setReviewFalVideoUrl(d.reviewFalVideoUrl ?? null);
      setReviewJobId(d.reviewJobId);
      setReviewImagePath(d.reviewImagePath ?? null);
      setReviewSummary(d.reviewSummary ?? null);
      setReviewLlmGen(d.reviewLlmGen ?? null);
      setReviewCharacterId(d.reviewCharacterId ?? null);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          CREATE_REVIEW_CACHE_KEY,
          JSON.stringify({
            reviewVideoPath: d.reviewVideoPath ?? null,
            reviewFalVideoUrl: d.reviewFalVideoUrl ?? null,
            reviewJobId: d.reviewJobId,
            reviewImagePath: d.reviewImagePath,
            reviewSummary: d.reviewSummary,
            reviewLlmGen: d.reviewLlmGen,
            reviewCharacterId: d.reviewCharacterId ?? null,
          }),
        );
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CREATE_REVIEW_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as {
        reviewVideoPath?: string | null;
        reviewFalVideoUrl?: string | null;
        reviewJobId?: string;
        reviewImagePath?: string;
        reviewSummary?: string;
        reviewLlmGen?: any;
        reviewCharacterId?: string;
      };
      if (cached.reviewJobId && (cached.reviewVideoPath || cached.reviewFalVideoUrl)) {
        setReviewMode(true);
        setReviewVideoPath(cached.reviewVideoPath ?? null);
        setReviewFalVideoUrl(cached.reviewFalVideoUrl ?? null);
        setReviewJobId(cached.reviewJobId);
        setReviewImagePath(cached.reviewImagePath ?? null);
        setReviewSummary(cached.reviewSummary ?? null);
        setReviewLlmGen(cached.reviewLlmGen ?? null);
        setReviewCharacterId(cached.reviewCharacterId ?? null);
      }
    } catch {
      // ignore bad cache
    }
  }, []);

  function CinemaLoader({
    label,
    onDismiss,
  }: {
    label: string;
    onDismiss?: () => void;
  }) {
    return (
      <div className="relative rounded-xl border border-border bg-card/95 p-5 shadow-xl backdrop-blur-md">
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close generation overlay"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        <div className="flex items-center justify-center pt-1">
          <div className="relative h-14 w-14">
            <div className="absolute inset-0 rounded-full border-[6px] border-primary/25 border-t-primary animate-spin" />
            <Film className="absolute inset-0 m-auto h-6 w-6 text-primary" />
          </div>
        </div>
        <p className="mt-3 text-center text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-center text-xs text-muted-foreground">Rolling cameras… this can take a few minutes.</p>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-muted-foreground">
          You can close this and keep using the app. Allow browser notifications to get an alert when your clip is ready — or open{" "}
          <span className="font-medium text-foreground">Create</span> again to review.
        </p>
        {onDismiss ? (
          <Button type="button" variant="outline" size="sm" className="mt-4 w-full" onClick={onDismiss}>
            Close and continue in background
          </Button>
        ) : null}
      </div>
    );
  }

  const stopFakeProgress = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  const startFakeProgress = () => {
    stopFakeProgress();
    progressTimerRef.current = setInterval(() => {
      setProgress((p) => {
        if (p >= 92) return p;
        const remaining = 92 - p;
        const step = Math.max(0.4, Math.min(3, remaining * 0.08));
        return Math.min(92, Number((p + step).toFixed(1)));
      });
    }, 700);
  };

  useEffect(() => {
    return () => stopFakeProgress();
  }, []);

  const selectedPattern = patterns.find((p) => p.id === selectedPatternId);
  const selectedCharacter = characters.find((c) => c.id === selectedCharacterId);
  const clipBundle = selectedCharacter?.clip_suggestions;
  const locationIdeas = useMemo(
    () => listLocations(clipBundle ?? { scenes: [] }),
    [clipBundle],
  );
  const actionIdeas = useMemo(
    () => descriptionsForLocation(clipBundle ?? { scenes: [] }, locationText),
    [clipBundle, locationText],
  );
  const cliffIdeas = useMemo(
    () =>
      cliffhangersForLocationAndDescription(
        clipBundle ?? { scenes: [] },
        locationText,
        actionText,
      ),
    [clipBundle, locationText, actionText],
  );
  const hasCuratedScenes = (clipBundle?.scenes?.length ?? 0) > 0;
  const actionIdeasEmptyHint =
    hasCuratedScenes && actionIdeas.length === 0
      ? !locationText.trim()
        ? "Pick a setting from the location ideas first (tap a row to paste it exactly). Then open this field again for movements that belong in that place."
        : "No curated lines match this location text. Choose a location from the list, or write your own movement."
      : undefined;
  const cliffIdeasEmptyHint =
    hasCuratedScenes && cliffIdeas.length === 0
      ? !locationText.trim()
        ? "Pick a location from ideas first, then a movement, then ending beats that fit that pair."
        : actionIdeas.length > 0 && actionText.trim() && !actionIdeas.includes(actionText.trim())
          ? "For curated ending beats, paste a movement line from this location’s list exactly (or write your own ending)."
          : "Pick a location and movement from the paired ideas (exact text), or write your own ending beat."
      : undefined;
  const isCustomMode = !!customImagePath && customAnalyzed;
  const hasSource = mode === "character"
    ? !!selectedCharacterId
    : !!selectedPatternId || isCustomMode;

  function selectPattern(id: string) {
    if (selectedPatternId === id) {
      setSelectedPatternId(null);
      setPreviewImageUrl(null);
      setPreviewTitle(null);
    } else {
      setSelectedPatternId(id);
      clearCustomImage(false);
      const picked = patterns.find((p) => p.id === id);
      if (picked) {
        setPreviewImageUrl(getMediaUrl(picked.image_storage_path) ?? null);
        setPreviewTitle(picked.title || "Selected image");
      }
    }
  }

  function clearCustomImage(resetPreview = true) {
    setCustomFile(null);
    setCustomImagePath(null);
    setCustomAnalyzed(false);
    if (resetPreview) {
      setPreviewImageUrl(null);
      setPreviewTitle(null);
    }
    if (customFileRef.current) customFileRef.current.value = "";
  }

  function toggleCustomSelection() {
    if (isCustomMode) {
      clearCustomImage();
      return;
    }
    if (customFile) {
      setPreviewImageUrl(URL.createObjectURL(customFile));
      setPreviewTitle("Your Image");
    }
  }

  async function handleCustomFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please select an image (JPG, PNG)", variant: "destructive" });
      return;
    }

    setSelectedPatternId(null);
    setCustomFile(file);
    setCustomUploading(true);
    setCustomAnalyzed(false);
    setErrorMsg(null);

    try {
      const { data: { user } } = await getUserQueued();
      if (!user) throw new Error("Not signed in");

      const ext = file.name.split(".").pop() || "jpg";
      const storagePath = `patterns/custom/${user.id}/${Date.now()}.${ext}`;
      const supabase = createBrowserClient();

      const { error: uploadError } = await supabase.storage
        .from("media")
        .upload(storagePath, file, { upsert: true });
      if (uploadError) throw new Error(uploadError.message);

      setCustomImagePath(storagePath);

      const analysis = await analyzeCustomImage(storagePath);
      if (analysis.error) throw new Error(analysis.error);

      setCustomAnalyzed(true);
      setPreviewImageUrl(URL.createObjectURL(file));
      setPreviewTitle("Your Image");
      toast({ title: "Image analyzed", description: "Now describe what happens next", variant: "success" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || "Unknown error", variant: "destructive" });
      clearCustomImage();
    } finally {
      setCustomUploading(false);
    }
  }

  const plotChange = [
    actionText.trim(),
    tensionText.trim() ? `Ending beat: ${tensionText.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  // Location is sent separately as `locationDescription` — do not duplicate it here (avoids truncation surprises).
  const characterPlotChange = [
    actionText.trim(),
    tensionText.trim() ? `Ending beat: ${tensionText.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  async function handleAiSuggestClipIdeas() {
    if (!selectedCharacterId || !selectedCharacter) {
      toast({ title: "Select a character", variant: "destructive" });
      return;
    }
    if (!locationText.trim()) {
      toast({
        title: "Add a location first",
        description: "The AI needs your setting to write movement and cliffhangers that fit.",
        variant: "destructive",
      });
      return;
    }
    setAiClipLoading(true);
    setAiClipOptions([]);
    try {
      const res = await suggestCharacterClipIdeas({
        characterId: selectedCharacterId,
        locationDescription: locationText.trim(),
        ...(mood !== "neutral" ? { mood } : {}),
        ...(camera !== "auto" ? { camera } : {}),
      });
      if (res.error) {
        toast({ title: "AI suggestions failed", description: res.error, variant: "destructive" });
        return;
      }
      if (!res.data?.options?.length) {
        toast({ title: "No suggestions returned", variant: "destructive" });
        return;
      }
      setAiClipOptions(res.data.options);
      setAiClipDialogOpen(true);
    } finally {
      setAiClipLoading(false);
    }
  }

  async function handleGenerate() {
    if (!hasSource || !actionText.trim()) {
      toast({
        title: "Missing fields",
        description: mode === "character"
          ? "Select a character and describe movements"
          : "Select an image and describe the physical actions",
        variant: "destructive",
      });
      return;
    }

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    pendingDraftSeqRef.current += 1;

    // Starting a fresh generation should not be overridden by an older cached review draft.
    setReviewMode(false);
    setReviewVideoPath(null);
    setReviewFalVideoUrl(null);
    setReviewJobId(null);
    setReviewImagePath(null);
    setReviewSummary(null);
    setReviewLlmGen(null);
    setReviewCharacterId(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
    }

    setProgress(15);
    setRunning(true);
    setGenerationOverlayDismissed(false);
    setErrorMsg(null);
    startFakeProgress();

    try {
      let res: { error?: string; data?: any };

      if (mode === "character" && selectedCharacterId) {
        res = await generateFromCharacter({
          characterId: selectedCharacterId,
          locationDescription: locationText.trim(),
          plotChange: characterPlotChange.trim(),
          ...(mood !== "neutral" ? { mood } : {}),
          ...(camera !== "auto" ? { camera } : {}),
        });
      } else if (isCustomMode && customImagePath) {
        res = await generateFromCustomImage({
          imageStoragePath: customImagePath,
          plotChange: plotChange.trim(),
          ...(mood !== "neutral" ? { mood } : {}),
          ...(camera !== "auto" ? { camera } : {}),
        });
      } else if (selectedPatternId) {
        res = await generateFromImagePattern({
          patternId: selectedPatternId,
          plotChange: plotChange.trim(),
          ...(mood !== "neutral" ? { mood } : {}),
          ...(camera !== "auto" ? { camera } : {}),
        });
      } else {
        res = { error: "No source selected" };
      }

      if (res.error) {
        toast({ title: "Generation failed", description: res.error, variant: "destructive" });
        setErrorMsg(res.error);
        setProgress(0);
        setRunning(false);
        stopFakeProgress();
        return;
      }

      const d = res.data;
      if (!d?.jobId || (!d?.videoStoragePath && !d?.falVideoUrl)) {
        stopFakeProgress();
        toast({
          title: "Generation incomplete",
          description: "The server did not return a video. Check the dev server terminal for [char-gen] / [pattern-gen] logs.",
          variant: "destructive",
        });
        setErrorMsg("No video path in response");
        setProgress(0);
        setRunning(false);
        return;
      }

      stopFakeProgress();
      setProgress(100);
      setRunning(false);
      setErrorMsg(null);

      setReviewMode(true);
      setReviewVideoPath(d.videoStoragePath ?? null);
      setReviewFalVideoUrl(d.falVideoUrl ?? null);
      setReviewJobId(d.jobId);
      setReviewImagePath(d.imageStoragePath);
      setReviewSummary(d.sceneSummary);
      setReviewLlmGen(d.llmGeneration);
      setReviewCharacterId(d.characterId ?? null);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          CREATE_REVIEW_CACHE_KEY,
          JSON.stringify({
            reviewVideoPath: d.videoStoragePath ?? null,
            reviewFalVideoUrl: d.falVideoUrl ?? null,
            reviewJobId: d.jobId,
            reviewImagePath: d.imageStoragePath,
            reviewSummary: d.sceneSummary,
            reviewLlmGen: d.llmGeneration,
            reviewCharacterId: d.characterId ?? null,
          }),
        );
      }
      if (d.characterAdaptation?.adapted) {
        toast({
          title: `Adapted for ${selectedCharacter?.name ?? "character"}`,
          description: d.characterAdaptation.explanation || d.characterAdaptation.warnings?.[0] || "Input was adjusted to fit character personality",
          duration: 8000,
        });
      } else if (d.falVideoUrl && !d.videoStoragePath) {
        toast({
          title: "Video ready",
          description: "Preview below; posting saves a copy to your library.",
        });
      } else {
        toast({ title: "Video ready!", description: "Review your clip before posting" });
      }
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification("Video is ready for review", {
          body: "Tap to open /create and review before posting.",
        });
        n.onclick = () => {
          window.focus();
          window.location.href = "/create";
        };
      }
    } catch (err: any) {
      stopFakeProgress();
      toast({ title: "Generation failed", description: err?.message || "Unknown error", variant: "destructive" });
      setErrorMsg(err?.message || "Unknown error");
      setProgress(0);
      setRunning(false);
    }
  }

  async function handlePublish() {
    if (!reviewJobId || (!reviewVideoPath && !reviewFalVideoUrl)) return;
    setPublishing(true);
    try {
      let res: { error?: string; data?: any };
      if (reviewCharacterId) {
        res = await publishCharacterDraft({
          jobId: reviewJobId!,
          videoStoragePath: reviewVideoPath || "",
          falVideoUrl: reviewFalVideoUrl,
          imageStoragePath: reviewImagePath || "",
          sceneSummary: reviewSummary || "",
          llmGeneration: reviewLlmGen,
          characterId: reviewCharacterId,
        });
      } else {
        res = await publishDraft({
          jobId: reviewJobId!,
          videoStoragePath: reviewVideoPath!,
          imageStoragePath: reviewImagePath || "",
          sceneSummary: reviewSummary || "",
          llmGeneration: reviewLlmGen,
        });
      }

      if (res.error) {
        toast({ title: "Publish failed", description: res.error, variant: "destructive" });
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
      }
      toast({ title: "Clip posted!", description: "Your clip is now live", variant: "success" });
      setTimeout(() => router.push("/feed"), 300);
    } catch (err: any) {
      toast({ title: "Publish failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  }

  async function handleImprove() {
    if (!reviewJobId || !reviewVideoPath || !improveFeedback.trim()) {
      toast({ title: "Missing feedback", description: "Describe what should be changed", variant: "destructive" });
      return;
    }
    setImproving(true);
    setErrorMsg(null);
    try {
      const res = await improveVideo({
        jobId: reviewJobId!,
        videoStoragePath: reviewVideoPath!,
        feedback: improveFeedback.trim(),
      });

      if (res.error) {
        toast({ title: "Improvement failed", description: res.error, variant: "destructive" });
        setErrorMsg(res.error);
        return;
      }
      setReviewVideoPath(res.data!.videoStoragePath);
      setImproveFeedback("");
      toast({ title: "Video improved!", description: "Review the new version" });
    } catch (err: any) {
      toast({ title: "Improvement failed", description: err?.message || "Unknown error", variant: "destructive" });
      setErrorMsg(err?.message || "Unknown error");
    } finally {
      setImproving(false);
    }
  }

  async function handleNewCharFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please select an image", variant: "destructive" });
      return;
    }
    setNewCharFile(file);
    setNewCharUploading(true);
    setNewCharAppearance(null);
    try {
      const { data: { user } } = await getUserQueued();
      if (!user) throw new Error("Not signed in");
      const ext = file.name.split(".").pop() || "jpg";
      const storagePath = `characters/custom/${user.id}/${Date.now()}.${ext}`;
      const supabase = createBrowserClient();
      const { error: uploadErr } = await supabase.storage
        .from("media")
        .upload(storagePath, file, { upsert: true });
      if (uploadErr) throw new Error(uploadErr.message);
      setNewCharImagePath(storagePath);
      setNewCharUploading(false);
      setNewCharAnalyzing(true);
      const { analyzeCharacterImage } = await import("@/actions/characters");
      const analysis = await analyzeCharacterImage(storagePath);
      if (analysis.error) throw new Error(analysis.error);
      setNewCharAppearance(analysis.appearance ?? null);
      toast({ title: "Image analyzed", description: "Character appearance detected", variant: "success" });
    } catch (err: any) {
      toast({ title: "Failed", description: err?.message || "Unknown error", variant: "destructive" });
      setNewCharFile(null);
      setNewCharImagePath(null);
    } finally {
      setNewCharUploading(false);
      setNewCharAnalyzing(false);
    }
  }

  async function handleSaveCustomCharacter() {
    if (!newCharName.trim() || !newCharImagePath || !newCharAppearance) {
      toast({ title: "Missing info", description: "Name and image required", variant: "destructive" });
      return;
    }
    setNewCharSaving(true);
    try {
      const { createCustomCharacter } = await import("@/actions/characters");
      const result = await createCustomCharacter({
        name: newCharName.trim(),
        tagline: newCharTagline.trim() || undefined,
        imageStoragePath: newCharImagePath,
        appearance: newCharAppearance,
        backstory: newCharBackstory.trim() || undefined,
      });
      if (result.error) throw new Error(result.error);
      if (result.character) {
        setCharacters((prev) => [...prev, result.character!]);
        setSelectedCharacterId(result.character.id);
        setCreatingCharacter(false);
        setNewCharName("");
        setNewCharTagline("");
        setNewCharBackstory("");
        setNewCharFile(null);
        setNewCharImagePath(null);
        setNewCharAppearance(null);
        toast({ title: "Character created!", description: `${result.character.name} is ready`, variant: "success" });
      }
    } catch (err: any) {
      toast({ title: "Failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setNewCharSaving(false);
    }
  }

  const actionExamples: Record<string, string> = {
    lion_grass: "e.g. lion spots a gazelle, eyes widen, body lowers into a crouch, muscles tense",
    vending_machine: "e.g. kid walks up, inserts a coin, hand moves across the buttons left to right",
    beetle_red_light: "e.g. light turns green, driver steps on gas, engine sputters, car shakes",
    woman_two_outfits: "e.g. she picks up the red dress, holds it up, then turns to look at the black one",
    solo_shopper_aisle: "e.g. he walks down the aisle, picks up a jar, reads the label, looks up at the top shelf",
    couple_grocery: "e.g. she holds up the product, reads the label, shows it to him, he shrugs",
    golf_putt: "e.g. he positions the ball, takes stance, draws the putter back slowly",
    fluffy_kitten: "e.g. kitten walks toward two bowls on the floor, sniffs the left one, then the right",
    woman_sleeping_mask:
      "e.g. chest rises and falls slowly, fingers twitch slightly on the sheet, shadows drift across the bed",
    friends_urban_group:
      "e.g. group walks a few steps closer, laughing, then settles into pose; one person adjusts jacket",
    friends_selfie_pond:
      "e.g. they lean in tighter, peace sign held steady, phone arm shakes slightly from holding pose; breeze moves hair",
    man_cooking_kitchen:
      "e.g. left hand stirs the pan, he leans in to check the food, steam rises; right hand stays steady",
  };

  const tensionExamples: Record<string, string> = {
    lion_grass: "e.g. frozen mid-crouch, ready to pounce",
    vending_machine: "e.g. finger hovering between two buttons",
    beetle_red_light: "e.g. engine stalling, smoke starting to rise",
    woman_two_outfits: "e.g. holding both dresses, looking back and forth",
    solo_shopper_aisle: "e.g. hand reaching toward shelf, hesitating",
    couple_grocery: "e.g. both looking at the product, undecided",
    golf_putt: "e.g. putter drawn back, about to swing",
    fluffy_kitten: "e.g. kitten paused between both bowls, looking up",
    woman_sleeping_mask: "e.g. hand suddenly grips the sheet; or she stirs, hand moving toward the mask",
    friends_urban_group: "e.g. one person’s smile fades as they glance off-camera at something behind the group",
    friends_selfie_pond: "e.g. loud splash in the pond behind them; they freeze mid-smile, about to turn",
    man_cooking_kitchen: "e.g. flame flares up from the pan; he recoils slightly, still mid-reach",
  };

  const actionPlaceholder = mode === "character" && selectedCharacter
    ? `e.g. ${selectedCharacter.name} alone at a quiet counter, one slow reach toward one of two options (keep it simple — no crowds or animals)`
    : selectedPattern
      ? actionExamples[selectedPattern.slug] || "e.g. he walks to the table, picks up the cup, brings it to his lips"
      : isCustomMode
        ? "e.g. she steps forward, reaches out, picks up the item from the shelf"
        : "Select or upload an image first";

  const tensionPlaceholder = selectedPattern
    ? tensionExamples[selectedPattern.slug] || "e.g. frozen mid-action, about to decide"
    : "e.g. hand hovering, about to choose";

  if (!running && reviewMode && (reviewVideoPath || reviewFalVideoUrl)) {
    const videoPlayUrl =
      reviewVideoPath != null && reviewVideoPath !== ""
        ? getMediaUrl(reviewVideoPath) ?? reviewFalVideoUrl
        : reviewFalVideoUrl;
    const isMockClip = reviewLlmGen?.mock_clip === true;
    const falOnly = !!reviewFalVideoUrl && !reviewVideoPath;
    return (
      <AppShell>
        <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
          <div className="space-y-4 p-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Film className="h-5 w-5 text-primary" />
                  Review Your Clip
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isMockClip ? (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100/90">
                    Local mock clip (MEDIA_PROVIDER=mock): Fal / Kling was skipped. Remove mock from env to generate real video.
                  </p>
                ) : null}
                {falOnly ? (
                  <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground/90">
                    Preview from the video provider. When you post, we save a copy to your library (same clip).
                  </p>
                ) : null}
                {videoPlayUrl && (
                  <div className="overflow-hidden rounded-xl border border-border bg-black">
                    <video
                      key={`${reviewVideoPath ?? ""}|${reviewFalVideoUrl ?? ""}`}
                      src={videoPlayUrl}
                      controls
                      autoPlay
                      loop
                      playsInline
                      preload="auto"
                      className="w-full aspect-[9/16] object-contain"
                      onError={() => {
                        toast({
                          title: "Video failed to load",
                          description:
                            "Open the clip URL in a new tab or confirm Supabase is running and NEXT_PUBLIC_SUPABASE_URL matches your storage.",
                          variant: "destructive",
                        });
                      }}
                    />
                  </div>
                )}

                {reviewSummary && (
                  <p className="text-sm text-muted-foreground text-center">{reviewSummary}</p>
                )}
                {reviewCharacterId && typeof reviewLlmGen?.enhanced_plot === "string" && reviewLlmGen.enhanced_plot.trim() ? (
                  <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-sm text-foreground/90 leading-snug">
                    {String(reviewLlmGen.enhanced_plot).trim()}
                  </p>
                ) : null}
                {reviewCharacterId &&
                Array.isArray(reviewLlmGen?.prediction_starters) &&
                reviewLlmGen.prediction_starters.length > 0 ? (
                  <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
                    <p className="text-xs font-medium text-foreground/80">
                      Suggested predictions for viewers (with opening YES odds — they can tap to add after you post)
                    </p>
                    <ul className="space-y-1.5">
                      {(reviewLlmGen.prediction_starters as { label?: string; opening_yes_hint?: number }[]).map(
                        (p, i) => {
                          const hint = typeof p.opening_yes_hint === "number" && Number.isFinite(p.opening_yes_hint)
                            ? Math.max(0.05, Math.min(0.95, p.opening_yes_hint))
                            : 0.5;
                          const yesOdds = Math.round((1 / hint) * 100) / 100;
                          return (
                            <li
                              key={i}
                              className="flex flex-col gap-0.5 rounded-md border border-border/40 bg-card/90 px-2.5 py-2 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-2"
                            >
                              <span className="text-sm text-foreground">{p.label ?? ""}</span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                ~{yesOdds.toFixed(2)}x YES
                              </span>
                            </li>
                          );
                        },
                      )}
                    </ul>
                  </div>
                ) : null}

                <Button
                  className="w-full"
                  size="lg"
                  onClick={handlePublish}
                  disabled={publishing || improving}
                >
                  {publishing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Publishing...
                    </>
                  ) : (
                    "Post to Feed"
                  )}
                </Button>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-2 text-muted-foreground">or improve</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Input
                    placeholder="Describe what should be changed..."
                    value={improveFeedback}
                    onChange={(e) => setImproveFeedback(e.target.value)}
                    maxLength={300}
                    disabled={improving}
                  />
                  <Button
                    className="w-full"
                    variant="outline"
                    size="lg"
                    onClick={handleImprove}
                    disabled={
                      improving || publishing || !improveFeedback.trim() || !reviewVideoPath
                    }
                  >
                    {improving ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Improving...
                      </>
                    ) : (
                      "Improve Video"
                    )}
                  </Button>
                </div>

                {improving && <CinemaLoader label="Improving your clip" />}

                {!!errorMsg && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {errorMsg}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 text-muted-foreground"
                    onClick={async () => {
                      if (reviewJobId) {
                        setDeleting(true);
                        await deleteDraft(reviewJobId, reviewVideoPath || "").catch(() => {});
                        setDeleting(false);
                      }
                      setReviewMode(false);
                      setReviewVideoPath(null);
                      setReviewFalVideoUrl(null);
                      setReviewJobId(null);
                      setReviewImagePath(null);
                      setReviewSummary(null);
                      setReviewLlmGen(null);
                      setImproveFeedback("");
                      setErrorMsg(null);
                      if (typeof window !== "undefined") {
                        window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
                      }
                    }}
                    disabled={improving || publishing || deleting}
                  >
                    Start Over
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={async () => {
                      if (!reviewJobId) return;
                      setDeleting(true);
                      try {
                        await deleteDraft(reviewJobId, reviewVideoPath || "");
                      } catch {}
                      if (typeof window !== "undefined") {
                        window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
                      }
                      router.push("/feed");
                    }}
                    disabled={improving || publishing || deleting}
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-1" />
                    )}
                    {deleting ? "Deleting..." : "Delete Video"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="space-y-4 p-4">
          <Card>
            {!previewImageUrl && !selectedCharacter && (
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Film className="h-5 w-5 text-primary" />
                  Create Clip
                </CardTitle>
              </CardHeader>
            )}
            <CardContent className="space-y-5">
              {/* Mode tabs */}
              {!previewImageUrl && !selectedCharacter && (
                <div className="flex rounded-lg border border-border bg-muted/40 p-1">
                  <button
                    type="button"
                    onClick={() => setMode("character")}
                    className={cn(
                      "flex-1 rounded-md py-2.5 text-sm font-medium transition-all",
                      mode === "character"
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Users className="mr-1.5 inline-block h-4 w-4" />
                    Character
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("image")}
                    className={cn(
                      "flex-1 rounded-md py-2.5 text-sm font-medium transition-all",
                      mode === "image"
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <ImageIcon className="mr-1.5 inline-block h-4 w-4" />
                    Image
                  </button>
                </div>
              )}

              {/* ── CHARACTER PICKER ── */}
              {mode === "character" && (
                <div className="relative">
                  {selectedCharacter ? (
                    <div className="space-y-3">
                      <button
                        type="button"
                        onClick={() => setSelectedCharacterId(null)}
                        className="relative w-full overflow-hidden rounded-xl border-2 border-primary ring-2 ring-primary/30 shadow-2xl"
                      >
                        {(() => {
                          const primary = selectedCharacter.reference_images.find((i) => i.is_primary)
                            ?? selectedCharacter.reference_images[0];
                          const imgUrl = primary ? getMediaUrl(primary.image_storage_path) : null;
                          return imgUrl ? (
                            <img src={imgUrl} alt={selectedCharacter.name} className="h-[50vh] w-full object-cover bg-black/30" />
                          ) : (
                            <div className="flex h-[50vh] items-center justify-center bg-muted">
                              <Users className="h-16 w-16 text-muted-foreground/40" />
                            </div>
                          );
                        })()}
                        <div className="absolute right-3 top-3 rounded-full bg-primary p-1.5">
                          <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3">
                          <p className="text-lg font-bold text-white">{selectedCharacter.name}</p>
                          {selectedCharacter.tagline && (
                            <p className="text-xs text-white/70">{selectedCharacter.tagline}</p>
                          )}
                        </div>
                      </button>
                      <CharacterFieldWithSuggestions
                        id="locationText"
                        label="Location / Setting"
                        hint={
                          <p className="text-[11px] text-muted-foreground">
                            Sent only as setting — describe movement below so nothing is duplicated or cut off.
                            Each location here unlocks matching scene lines and cliffhangers for {selectedCharacter.name}.
                          </p>
                        }
                        placeholder="e.g. rooftop bar, park bench, city street"
                        value={locationText}
                        onChange={setLocationText}
                        maxLength={LOCATION_TEXT_MAX}
                        suggestions={locationIdeas}
                        suggestionsTitle={`Settings for ${selectedCharacter.name} — each row is paired with specific scenes`}
                      />

                      <Button
                        type="button"
                        variant="secondary"
                        className="w-full gap-2"
                        disabled={!locationText.trim() || aiClipLoading || running}
                        onClick={() => void handleAiSuggestClipIdeas()}
                      >
                        {aiClipLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating ideas…
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4" />
                            AI suggest movement & cliffhanger
                          </>
                        )}
                      </Button>
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Uses your profile + location + mood/camera. Picks follow video rules (smooth motion, in-character,
                        no speech, paired cliffhangers). Set{" "}
                        <span className="font-medium text-foreground">LLM_MODEL_CHARACTER_CLIP_SUGGEST</span> (ideas + video
                        prompt JSON) or <span className="font-medium text-foreground">LLM_MODEL_CHARACTER_VIDEO</span> for
                        Kling scenes only — default is <span className="font-medium text-foreground">gpt-4o</span> if unset.
                      </p>

                      <button
                        type="button"
                        onClick={() => router.push(`/character/${selectedCharacter.slug}`)}
                        className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                      >
                        <span>View {selectedCharacter.name} profile</span>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  ) : charactersLoading ? (
                    <CinemaLoader label="Loading characters" />
                  ) : creatingCharacter ? (
                    <div className="space-y-4">
                      <button
                        type="button"
                        onClick={() => setCreatingCharacter(false)}
                        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                      >
                        <ArrowLeft className="h-4 w-4" /> Back to characters
                      </button>
                      <p className="text-sm font-medium text-foreground">New character</p>

                      <input ref={newCharFileRef} type="file" accept="image/*" className="hidden" onChange={handleNewCharFileChange} />
                      {newCharFile ? (
                        <div className="relative overflow-hidden rounded-xl border-2 border-primary aspect-[3/4] max-h-[280px]">
                          <img src={URL.createObjectURL(newCharFile)} alt="New character" className="h-full w-full object-cover" />
                          {(newCharUploading || newCharAnalyzing) && (
                            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
                              <Loader2 className="h-8 w-8 text-white animate-spin" />
                              <span className="text-xs text-white">{newCharAnalyzing ? "Analyzing appearance..." : "Uploading..."}</span>
                            </div>
                          )}
                          {newCharAppearance && (
                            <div className="absolute right-2 top-2 rounded-full bg-green-500 p-1.5">
                              <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => newCharFileRef.current?.click()}
                          className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 transition hover:border-primary/50 hover:bg-muted/50"
                        >
                          <Upload className="h-8 w-8 text-muted-foreground" />
                          <span className="text-sm font-medium text-muted-foreground">Upload character photo</span>
                        </button>
                      )}

                      <div className="space-y-2">
                        <Input placeholder="Character name" value={newCharName} onChange={(e) => setNewCharName(e.target.value)} maxLength={50} />
                        <Input placeholder="Tagline (optional)" value={newCharTagline} onChange={(e) => setNewCharTagline(e.target.value)} maxLength={100} />
                        <textarea
                          placeholder="Backstory (optional)"
                          value={newCharBackstory}
                          onChange={(e) => setNewCharBackstory(e.target.value)}
                          maxLength={500}
                          rows={3}
                          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
                        />
                      </div>

                      <Button
                        className="w-full"
                        size="lg"
                        onClick={handleSaveCustomCharacter}
                        disabled={!newCharName.trim() || !newCharAppearance || newCharSaving}
                      >
                        {newCharSaving ? (
                          <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
                        ) : (
                          <><Plus className="h-4 w-4" /> Create Character</>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      {characters.map((c) => {
                        const primary = c.reference_images.find((i) => i.is_primary) ?? c.reference_images[0];
                        const imgUrl = primary ? getMediaUrl(primary.image_storage_path) : null;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setSelectedCharacterId(c.id)}
                            className="relative overflow-hidden rounded-xl border-2 border-border hover:border-primary/50 transition-all aspect-[3/4]"
                          >
                            {imgUrl ? (
                              <img src={imgUrl} alt={c.name} className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-muted">
                                <Users className="h-10 w-10 text-muted-foreground/40" />
                              </div>
                            )}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2.5">
                              <p className="text-sm font-bold text-white">{c.name}</p>
                              {c.tagline && (
                                <p className="text-[10px] text-white/60 line-clamp-1">{c.tagline}</p>
                              )}
                              <div className="mt-1 flex gap-1">
                                <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[9px] text-white">
                                  {c.personality.temperament}
                                </span>
                              </div>
                            </div>
                            {c.total_videos > 0 && (
                              <div className="absolute right-2 top-2 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] text-white">
                                {c.total_videos} clips
                              </div>
                            )}
                          </button>
                        );
                      })}

                      <button
                        type="button"
                        onClick={() => setCreatingCharacter(true)}
                        className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/30 transition hover:border-primary/50 hover:bg-muted/50 aspect-[3/4]"
                      >
                        <Plus className="h-8 w-8 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground">Create your own</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── IMAGE PATTERN PICKER ── */}
              {mode === "image" && (
              <div className="relative">
                {previewImageUrl ? (
                  <div className="space-y-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (isCustomMode) {
                          clearCustomImage();
                        } else {
                          setSelectedPatternId(null);
                          setPreviewImageUrl(null);
                          setPreviewTitle(null);
                        }
                      }}
                      className="relative w-full overflow-hidden rounded-xl border-2 border-primary ring-2 ring-primary/30 shadow-2xl"
                    >
                      <img
                        src={previewImageUrl}
                        alt={previewTitle || "Selected image"}
                        className="h-[58vh] w-full object-cover bg-black/30"
                      />
                      <div className="absolute right-3 top-3 rounded-full bg-primary p-1.5">
                        <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      {previewTitle && (
                        <div className="absolute bottom-2 left-2 rounded-md bg-black/60 px-3 py-1 text-sm text-white">
                          {previewTitle}
                        </div>
                      )}
                    </button>
                  </div>
                ) : patternsLoading ? (
                  <CinemaLoader label="Loading image patterns" />
                ) : (
                  <div className="grid grid-cols-3 gap-2.5">
                    {patterns.map((p: any) => {
                      const imgUrl = getMediaUrl(p.image_storage_path);
                      const isSelected = selectedPatternId === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => selectPattern(p.id)}
                          className={cn(
                            "relative overflow-hidden rounded-lg border-2 transition-all aspect-[9/16]",
                            isSelected
                              ? "border-primary ring-2 ring-primary/30"
                              : "border-border hover:border-primary/50",
                          )}
                        >
                          {imgUrl && <img src={imgUrl} alt={p.title} className="h-full w-full object-cover" />}
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1.5">
                            <p className="text-[10px] font-medium text-white truncate">{p.title}</p>
                          </div>
                        </button>
                      );
                    })}

                    <input
                      ref={customFileRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleCustomFileChange}
                    />
                    {customFile && customImagePath ? (
                      <button
                        type="button"
                        onClick={toggleCustomSelection}
                        className={cn(
                          "relative overflow-hidden rounded-lg border-2 transition-all aspect-[9/16]",
                          isCustomMode ? "border-primary ring-2 ring-primary/30" : "border-border",
                        )}
                      >
                        <img src={URL.createObjectURL(customFile)} alt="Your image" className="h-full w-full object-cover" />
                        {customUploading && (
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <Loader2 className="h-6 w-6 text-white animate-spin" />
                          </div>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1.5">
                          <p className="text-[10px] font-medium text-white truncate">Your Image</p>
                        </div>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => customFileRef.current?.click()}
                        disabled={customUploading}
                        className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 transition-colors hover:border-primary/50 hover:bg-muted/50 aspect-[9/16]"
                      >
                        <Upload className="h-6 w-6 text-muted-foreground" />
                        <span className="text-[10px] font-medium text-muted-foreground px-1 text-center">
                          Upload your image
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
              )}

              {/* Structured scene input */}
              <div className="space-y-4">
                {mode === "character" && selectedCharacter ? (
                  <>
                    <CharacterFieldWithSuggestions
                      id="actionText"
                      label="Describe movements"
                      hint={
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Describe what happens around {selectedCharacter.name} (place, people, tension). How they
                          move and react comes from their profile — not a new role you invent. Use{" "}
                          <span className="font-medium text-foreground">AI suggest</span> above for LLM options, or the
                          list below when your location matches a curated row (exact wording).
                        </p>
                      }
                      placeholder={actionPlaceholder}
                      value={actionText}
                      onChange={setActionText}
                      maxLength={ACTION_TEXT_MAX}
                      disabled={!hasSource}
                      multiline
                      rows={5}
                      textAreaClassName="min-h-[120px]"
                      suggestions={actionIdeas}
                      suggestionsTitle={`Scenes for this location — ${selectedCharacter.name}`}
                      emptyMessage={actionIdeasEmptyHint}
                    />
                    <CharacterFieldWithSuggestions
                      id="tensionText"
                      label={
                        <>
                          Cliffhanger / ending beat{" "}
                          <span className="text-muted-foreground font-normal">(optional)</span>
                        </>
                      }
                      placeholder={tensionPlaceholder}
                      value={tensionText}
                      onChange={setTensionText}
                      maxLength={TENSION_TEXT_MAX}
                      disabled={!hasSource}
                      multiline
                      rows={3}
                      textAreaClassName="min-h-[72px]"
                      suggestions={cliffIdeas}
                      suggestionsTitle={`Ending beats for this location + movement — ${selectedCharacter.name}`}
                      emptyMessage={cliffIdeasEmptyHint}
                    />
                  </>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="actionText">
                        Describe movements
                      </label>
                      <textarea
                        id="actionText"
                        placeholder={actionPlaceholder}
                        value={actionText}
                        onChange={(e) => setActionText(e.target.value)}
                        maxLength={ACTION_TEXT_MAX}
                        disabled={!hasSource}
                        rows={5}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y min-h-[120px]"
                      />
                      <p
                        className={cn(
                          "text-xs text-right",
                          actionText.length > ACTION_TEXT_MAX * 0.9
                            ? "text-amber-600 dark:text-amber-500"
                            : "text-muted-foreground",
                        )}
                      >
                        {actionText.length}/{ACTION_TEXT_MAX}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-sm font-medium" htmlFor="tensionText">
                        Cliffhanger / ending beat{" "}
                        <span className="text-muted-foreground font-normal">(optional)</span>
                      </label>
                      <textarea
                        id="tensionText"
                        placeholder={tensionPlaceholder}
                        value={tensionText}
                        onChange={(e) => setTensionText(e.target.value)}
                        maxLength={TENSION_TEXT_MAX}
                        disabled={!hasSource}
                        rows={3}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y min-h-[72px]"
                      />
                      <p
                        className={cn(
                          "text-xs text-right",
                          tensionText.length > TENSION_TEXT_MAX * 0.9
                            ? "text-amber-600 dark:text-amber-500"
                            : "text-muted-foreground",
                        )}
                      >
                        {tensionText.length}/{TENSION_TEXT_MAX}
                      </p>
                    </div>
                  </>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Mood</label>
                    <Select value={mood} onValueChange={setMood} disabled={!hasSource}>
                      <SelectTrigger
                        className={cn(
                          "h-12 min-h-12 w-full rounded-lg border-border bg-card px-4 text-base text-foreground shadow-sm",
                          "focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background",
                          "data-[placeholder]:text-muted-foreground [&_svg]:rotate-180",
                        )}
                      >
                        <SelectValue placeholder="Auto" />
                      </SelectTrigger>
                      <SelectContent
                        side="top"
                        sideOffset={8}
                        position="popper"
                        className={cn(
                          "z-[100] max-h-[min(22rem,55vh)] w-[var(--radix-select-trigger-width)] rounded-xl border-border bg-card p-1.5 text-foreground shadow-xl",
                          "data-[state=open]:animate-in data-[state=closed]:animate-out",
                        )}
                      >
                        <SelectItem value="neutral" className={CREATE_SCENE_SELECT_ITEM}>
                          Auto
                        </SelectItem>
                        <SelectItem value="tense" className={CREATE_SCENE_SELECT_ITEM}>
                          Tense / Suspenseful
                        </SelectItem>
                        <SelectItem value="calm" className={CREATE_SCENE_SELECT_ITEM}>
                          Calm / Slow
                        </SelectItem>
                        <SelectItem value="energetic" className={CREATE_SCENE_SELECT_ITEM}>
                          Energetic / Fast
                        </SelectItem>
                        <SelectItem value="playful" className={CREATE_SCENE_SELECT_ITEM}>
                          Playful / Light
                        </SelectItem>
                        <SelectItem value="dramatic" className={CREATE_SCENE_SELECT_ITEM}>
                          Dramatic / Cinematic
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Camera</label>
                    <Select value={camera} onValueChange={setCamera} disabled={!hasSource}>
                      <SelectTrigger
                        className={cn(
                          "h-12 min-h-12 w-full rounded-lg border-border bg-card px-4 text-base text-foreground shadow-sm",
                          "focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background",
                          "data-[placeholder]:text-muted-foreground [&_svg]:rotate-180",
                        )}
                      >
                        <SelectValue placeholder="Auto" />
                      </SelectTrigger>
                      <SelectContent
                        side="top"
                        sideOffset={8}
                        position="popper"
                        className={cn(
                          "z-[100] max-h-[min(22rem,55vh)] w-[var(--radix-select-trigger-width)] rounded-xl border-border bg-card p-1.5 text-foreground shadow-xl",
                          "data-[state=open]:animate-in data-[state=closed]:animate-out",
                        )}
                      >
                        <SelectItem value="auto" className={CREATE_SCENE_SELECT_ITEM}>
                          Auto
                        </SelectItem>
                        <SelectItem value="follow" className={CREATE_SCENE_SELECT_ITEM}>
                          Follow shot
                        </SelectItem>
                        <SelectItem value="static" className={CREATE_SCENE_SELECT_ITEM}>
                          Static / Locked
                        </SelectItem>
                        <SelectItem value="closeup" className={CREATE_SCENE_SELECT_ITEM}>
                          Close-up
                        </SelectItem>
                        <SelectItem value="pov" className={CREATE_SCENE_SELECT_ITEM}>
                          POV / First person
                        </SelectItem>
                        <SelectItem value="orbit" className={CREATE_SCENE_SELECT_ITEM}>
                          Slow orbit
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Progress */}
              {running && progress > 0 && (
                <div className="space-y-2">
                  {generationOverlayDismissed && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center text-[11px] text-muted-foreground">
                      Video still generating. Allow notifications for an alert when it is ready, or stay on this page — the review step will appear here.
                    </div>
                  )}
                  <Progress value={progress} />
                  <p className="text-center text-xs text-muted-foreground">
                    {generationOverlayDismissed
                      ? "Working in the background."
                      : "You can close the full-screen loader and keep using the app."}
                  </p>
                </div>
              )}

              {/* Error */}
              {!!errorMsg && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  Generation failed: {errorMsg}
                </div>
              )}

              {/* Generate button */}
              <Button
                className="w-full"
                size="lg"
                onClick={handleGenerate}
                disabled={running || !hasSource || !actionText.trim()}
              >
                {running ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <ImageIcon className="h-4 w-4" />
                    Generate Clip
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {running && !generationOverlayDismissed && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-6 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-gen-loader-title"
          onClick={() => setGenerationOverlayDismissed(true)}
        >
          <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p id="create-gen-loader-title" className="sr-only">
              Generating video
            </p>
            <CinemaLoader
              label="Generating your video"
              onDismiss={() => setGenerationOverlayDismissed(true)}
            />
          </div>
        </div>
      )}

      <Dialog open={aiClipDialogOpen} onOpenChange={setAiClipDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl gap-0 overflow-hidden p-0" showClose>
          <DialogHeader className="border-b border-border px-6 py-4 text-left">
            <DialogTitle>
              AI scene ideas{selectedCharacter ? ` — ${selectedCharacter.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              Each block is one movement line plus ending beats written for your location and this character. Choose a
              pair to fill the form.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[min(32rem,70vh)] px-6 py-4">
            <div className="space-y-4 pr-2">
              {aiClipOptions.map((opt, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-muted/30 p-4 space-y-3"
                >
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Option {i + 1} — movement
                  </p>
                  <p className="text-sm leading-relaxed text-foreground">{opt.description}</p>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-1">
                    Ending beats (pick one)
                  </p>
                  <div className="flex flex-col gap-2">
                    {opt.cliffhangers.map((cliff, j) => (
                      <Button
                        key={j}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto min-h-10 justify-start whitespace-normal py-2 px-3 text-left text-xs leading-snug"
                        onClick={() => {
                          setActionText(opt.description.slice(0, ACTION_TEXT_MAX));
                          setTensionText(cliff.slice(0, TENSION_TEXT_MAX));
                          setAiClipDialogOpen(false);
                          toast({
                            title: "Filled movement & cliffhanger",
                            description: "You can still edit the text before generating.",
                            variant: "success",
                          });
                        }}
                      >
                        {cliff}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

    </AppShell>
  );
}

export default function CreatePage() {
  return (
    <Suspense fallback={<AppShell><div className="p-4 text-sm text-muted-foreground">Loading create page...</div></AppShell>}>
      <CreatePageClient />
    </Suspense>
  );
}
