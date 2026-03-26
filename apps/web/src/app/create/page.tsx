"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Loader2, ImageIcon, Film } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import {
  getImagePatterns,
  generateFromImagePattern,
  generateFromCustomImage,
  analyzeCustomImage,
  publishDraft,
  improveVideo,
  getPendingReviewDraft,
} from "@/actions/image-pattern-clips";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { cn, getMediaUrl } from "@/lib/utils";

const PATTERNS_CACHE_KEY = "create:image_patterns:v1";
const PATTERNS_CACHE_TTL_MS = 10 * 60 * 1000;
const CREATE_REVIEW_CACHE_KEY = "create:pending_review:v1";

export default function CreatePage() {
  const router = useRouter();
  const { toast } = useToast();
  const customFileRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();

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

  // Shared state
  const [plotChange, setPlotChange] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Review state
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewVideoPath, setReviewVideoPath] = useState<string | null>(null);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [reviewImagePath, setReviewImagePath] = useState<string | null>(null);
  const [reviewSummary, setReviewSummary] = useState<string | null>(null);
  const [reviewLlmGen, setReviewLlmGen] = useState<any>(null);
  const [improveFeedback, setImproveFeedback] = useState("");
  const [improving, setImproving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    let mounted = true;

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

    // Always refresh in background to keep it up to date.
    // If cache is fresh, this runs silently with no loader flicker.
    getImagePatterns().then((res: { patterns: any[]; error?: string }) => {
      if (!mounted) return;
      if (res.patterns && Array.isArray(res.patterns)) {
        setPatterns(res.patterns);
        writeCache(res.patterns);
      }
      // Show loader only when we had no usable cache.
      if (!cacheFresh) setPatternsLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // Source of truth recovery from server in case user navigated away during generation.
    getPendingReviewDraft().then((res) => {
      const d = res.data;
      if (!d || !d.reviewVideoPath || !d.reviewJobId) return;
      setReviewMode(true);
      setReviewVideoPath(d.reviewVideoPath);
      setReviewJobId(d.reviewJobId);
      setReviewImagePath(d.reviewImagePath ?? null);
      setReviewSummary(d.reviewSummary ?? null);
      setReviewLlmGen(d.reviewLlmGen ?? null);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          CREATE_REVIEW_CACHE_KEY,
          JSON.stringify({
            reviewVideoPath: d.reviewVideoPath,
            reviewJobId: d.reviewJobId,
            reviewImagePath: d.reviewImagePath,
            reviewSummary: d.reviewSummary,
            reviewLlmGen: d.reviewLlmGen,
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
        reviewVideoPath?: string;
        reviewJobId?: string;
        reviewImagePath?: string;
        reviewSummary?: string;
        reviewLlmGen?: any;
      };
      if (cached.reviewVideoPath && cached.reviewJobId) {
        setReviewMode(true);
        setReviewVideoPath(cached.reviewVideoPath);
        setReviewJobId(cached.reviewJobId);
        setReviewImagePath(cached.reviewImagePath ?? null);
        setReviewSummary(cached.reviewSummary ?? null);
        setReviewLlmGen(cached.reviewLlmGen ?? null);
      }
    } catch {
      // ignore bad cache
    }
  }, []);

  function CinemaLoader({ label }: { label: string }) {
    return (
      <div className="rounded-xl border border-border bg-muted/85 p-5 shadow-xl backdrop-blur-sm">
        <div className="flex items-center justify-center">
          <div className="relative h-14 w-14">
            <div className="absolute inset-0 rounded-full border-[6px] border-primary/25 border-t-primary animate-spin" />
            <Film className="absolute inset-0 m-auto h-6 w-6 text-primary" />
          </div>
        </div>
        <p className="mt-3 text-center text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-center text-xs text-muted-foreground">Rolling cameras... please wait</p>
      </div>
    );
  }

  const selectedPattern = patterns.find((p) => p.id === selectedPatternId);
  const isCustomMode = !!customImagePath && customAnalyzed;
  const hasSource = !!selectedPatternId || isCustomMode;

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

  function handleGenerate() {
    if (!hasSource || !plotChange.trim()) {
      toast({ title: "Missing fields", description: "Select or upload an image, and describe what happens", variant: "destructive" });
      return;
    }

    setProgress(15);
    setRunning(true);
    setErrorMsg(null);

    startTransition(async () => {
      let res: { error?: string; data?: any };

      if (isCustomMode && customImagePath) {
        res = await generateFromCustomImage({
          imageStoragePath: customImagePath,
          plotChange: plotChange.trim(),
        });
      } else if (selectedPatternId) {
        res = await generateFromImagePattern({
          patternId: selectedPatternId,
          plotChange: plotChange.trim(),
        });
      } else {
        res = { error: "No image selected" };
      }

      if (res.error) {
        toast({ title: "Generation failed", description: res.error, variant: "destructive" });
        setErrorMsg(res.error);
        setProgress(0);
        setRunning(false);
        return;
      }

      const d = res.data;
      setProgress(100);
      setRunning(false);
      setErrorMsg(null);

      setReviewMode(true);
      setReviewVideoPath(d.videoStoragePath);
      setReviewJobId(d.jobId);
      setReviewImagePath(d.imageStoragePath);
      setReviewSummary(d.sceneSummary);
      setReviewLlmGen(d.llmGeneration);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          CREATE_REVIEW_CACHE_KEY,
          JSON.stringify({
            reviewVideoPath: d.videoStoragePath,
            reviewJobId: d.jobId,
            reviewImagePath: d.imageStoragePath,
            reviewSummary: d.sceneSummary,
            reviewLlmGen: d.llmGeneration,
          }),
        );
      }
      toast({ title: "Video ready!", description: "Review your clip before posting" });
      if (typeof window !== "undefined" && "Notification" in window) {
        if (Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
        if (Notification.permission === "granted") {
          const n = new Notification("Video is ready for review", {
            body: "Tap to open /create and review before posting.",
          });
          n.onclick = () => {
            window.focus();
            window.location.href = "/create";
          };
        }
      }
    });
  }

  function handlePublish() {
    if (!reviewJobId || !reviewVideoPath) return;
    setPublishing(true);
    startTransition(async () => {
      const res = await publishDraft({
        jobId: reviewJobId!,
        videoStoragePath: reviewVideoPath!,
        imageStoragePath: reviewImagePath || "",
        sceneSummary: reviewSummary || "",
        llmGeneration: reviewLlmGen,
      });

      setPublishing(false);
      if (res.error) {
        toast({ title: "Publish failed", description: res.error, variant: "destructive" });
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
      }
      toast({ title: "Clip posted!", description: "Your clip is now live", variant: "success" });
      setTimeout(() => router.push("/feed"), 300);
    });
  }

  function handleImprove() {
    if (!reviewJobId || !reviewVideoPath || !improveFeedback.trim()) {
      toast({ title: "Missing feedback", description: "Describe what should be changed", variant: "destructive" });
      return;
    }
    setImproving(true);
    setErrorMsg(null);
    startTransition(async () => {
      const res = await improveVideo({
        jobId: reviewJobId!,
        videoStoragePath: reviewVideoPath!,
        feedback: improveFeedback.trim(),
      });

      setImproving(false);
      if (res.error) {
        toast({ title: "Improvement failed", description: res.error, variant: "destructive" });
        setErrorMsg(res.error);
        return;
      }
      setReviewVideoPath(res.data!.videoStoragePath);
      setImproveFeedback("");
      toast({ title: "Video improved!", description: "Review the new version" });
    });
  }

  const placeholderExamples: Record<string, string> = {
    lion_grass: "e.g. spots a gazelle, eyes go wide, muscles tense",
    vending_machine: "e.g. kid inserts coin, hand hovers over buttons",
    beetle_red_light: "e.g. light turns green but car won't start, smoke rises",
    woman_two_outfits: "e.g. phone rings, she looks at one dress then the other",
    solo_shopper_aisle: "e.g. reaches for a jar but notices something on the top shelf",
    couple_grocery: "e.g. she reads the label and frowns, he points at another option",
    golf_putt: "e.g. wind picks up, ball starts rolling before the swing",
    roller_skater: "e.g. a crack in the road appears ahead, she notices too late",
  };

  const plotPlaceholder = selectedPattern
    ? placeholderExamples[selectedPattern.slug] || "Describe what happens next..."
    : isCustomMode
      ? "Describe what happens next in this scene..."
      : "Select or upload an image first";

  if (reviewMode && reviewVideoPath) {
    const videoUrl = getMediaUrl(reviewVideoPath);
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
                {videoUrl && (
                  <div className="overflow-hidden rounded-xl border border-border bg-black">
                    <video
                      key={reviewVideoPath}
                      src={videoUrl}
                      controls
                      autoPlay
                      loop
                      playsInline
                      preload="auto"
                      className="w-full aspect-[9/16] object-contain"
                    />
                  </div>
                )}

                {reviewSummary && (
                  <p className="text-sm text-muted-foreground text-center">{reviewSummary}</p>
                )}

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
                    disabled={improving || publishing || !improveFeedback.trim()}
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

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => {
                    setReviewMode(false);
                    setReviewVideoPath(null);
                    setReviewJobId(null);
                    setImproveFeedback("");
                    if (typeof window !== "undefined") {
                      window.localStorage.removeItem(CREATE_REVIEW_CACHE_KEY);
                    }
                  }}
                  disabled={improving || publishing}
                >
                  Start Over
                </Button>
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
            {!previewImageUrl && (
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ImageIcon className="h-5 w-5 text-primary" />
                  Create Clip
                </CardTitle>
              </CardHeader>
            )}
            <CardContent className="space-y-5">
              {!previewImageUrl && (
                <p className="text-sm text-muted-foreground">
                  Choose a starting image or upload your own, then describe what happens next.
                </p>
              )}

              {/* --- Pattern picker / focused selected image --- */}
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

              {/* Description of selected pattern */}
              {selectedPattern && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {selectedPattern.description}
                </div>
              )}

              {/* Plot change input */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="plotChange">
                  What happens next?
                </label>
                <Input
                  id="plotChange"
                  placeholder={plotPlaceholder}
                  value={plotChange}
                  onChange={(e) => setPlotChange(e.target.value)}
                  maxLength={200}
                  disabled={!hasSource}
                />
              </div>

              {/* Progress */}
              {running && progress > 0 && (
                <div className="space-y-2">
                  <Progress value={progress} />
                  <p className="text-center text-xs text-muted-foreground">
                    Generating in background... you can keep using the app.
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
                disabled={running || isPending || !hasSource || !plotChange.trim()}
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

      {running && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <CinemaLoader label="Generating your cinematic clip" />
          </div>
        </div>
      )}

    </AppShell>
  );
}
