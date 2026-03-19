"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Film, Loader2, X } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { createClipFromUpload } from "@/actions/clips";
import { generateAiClipFromBlueprint, getClipBlueprints, getCurrentAiGenerationStatus } from "@/actions/ai-clips";
import { createBrowserClient, getUserQueued } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const GENRES = [
  { value: "action", label: "Action" },
  { value: "comedy", label: "Comedy" },
  { value: "drama", label: "Drama" },
  { value: "horror", label: "Horror" },
  { value: "romance", label: "Romance" },
  { value: "sci_fi", label: "Sci-Fi" },
  { value: "thriller", label: "Thriller" },
  { value: "fantasy", label: "Fantasy" },
  { value: "mystery", label: "Mystery" },
  { value: "slice_of_life", label: "Slice of Life" },
  { value: "nature", label: "Nature" },
  { value: "sports", label: "Sports" },
];

const TONES = [
  { value: "serious", label: "Serious" },
  { value: "humorous", label: "Humorous" },
  { value: "dark", label: "Dark" },
  { value: "lighthearted", label: "Lighthearted" },
  { value: "tense", label: "Tense" },
  { value: "wholesome", label: "Wholesome" },
  { value: "chaotic", label: "Chaotic" },
];

const REALISM_LEVELS = [
  { value: "low", label: "Low (stylized)" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (realistic)" },
];

export default function CreatePage() {
  const router = useRouter();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [tone, setTone] = useState("");
  const [isPending, startTransition] = useTransition();
  const [uploadProgress, setUploadProgress] = useState(0);

  const [blueprints, setBlueprints] = useState<Array<{ id: string; label: string; description: string | null }>>(
    []
  );
  const [aiBlueprintId, setAiBlueprintId] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenre, setAiGenre] = useState("");
  const [aiTone, setAiTone] = useState("");
  const [aiRealism, setAiRealism] = useState("medium");
  const [aiProgress, setAiProgress] = useState(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiErrorMessage, setAiErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    getClipBlueprints().then((res) => {
      const list = (res.blueprints || []).map((b) => ({
        id: b.id,
        label: b.label,
        description: b.description ?? null,
      }));
      setBlueprints(list);
      if (!aiBlueprintId && list[0]?.id) setAiBlueprintId(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const statusToProgress: Record<string, number> = {
      queued: 10,
      generating_first_frame: 30,
      generating_end_frame: 55,
      generating_video: 80,
    };

    const syncStatus = async () => {
      const current = await getCurrentAiGenerationStatus();
      if (cancelled) return;
      setAiRunning(current.running);
      setAiStatus(current.status);
      setAiErrorMessage(current.status === "failed" ? current.errorMessage || "Generation failed." : null);
      if (current.running) {
        setAiProgress(statusToProgress[current.status ?? "queued"] ?? 15);
      } else if (current.status === "completed") {
        setAiProgress(100);
      } else {
        setAiProgress(0);
      }
    };

    syncStatus();
    intervalId = setInterval(syncStatus, 2500);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) {
      if (!selected.type.startsWith("video/")) {
        toast({ title: "Invalid file", description: "Please select a video file", variant: "destructive" });
        return;
      }
      setFile(selected);
    }
  }

  function handleRemoveFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleUpload() {
    if (!file || !title.trim()) {
      toast({ title: "Missing fields", description: "Title and video are required", variant: "destructive" });
      return;
    }

    setUploadProgress(10);

    startTransition(async () => {
      const {
        data: { user },
      } = await getUserQueued();
      if (!user) {
        toast({ title: "Not signed in", description: "Please sign in to upload", variant: "destructive" });
        setUploadProgress(0);
        return;
      }

      setUploadProgress(20);

      const ext = file.name.split(".").pop() || "mp4";
      const storagePath = `clips/${user.id}/${Date.now()}.${ext}`;
      const supabase = createBrowserClient();

      const { error: uploadError } = await supabase.storage
        .from("media")
        .upload(storagePath, file, { upsert: false });

      setUploadProgress(70);

      if (uploadError) {
        toast({ title: "Upload failed", description: uploadError.message, variant: "destructive" });
        setUploadProgress(0);
        return;
      }

      const result = await createClipFromUpload({
        storagePath,
        title: title.trim(),
        genre: genre || null,
        tone: tone || null,
      });

      setUploadProgress(90);

      if (result.error) {
        toast({ title: "Upload failed", description: result.error, variant: "destructive" });
        setUploadProgress(0);
        return;
      }

      setUploadProgress(100);
      toast({ title: "Clip uploaded!", description: "Your clip is now live", variant: "success" });

      setTimeout(() => {
        router.push("/feed");
      }, 500);
    });
  }

  function handleGenerateAi() {
    if (!aiBlueprintId || !aiPrompt.trim()) {
      toast({ title: "Missing fields", description: "Blueprint and prompt are required", variant: "destructive" });
      return;
    }

    setAiProgress(10);
    setAiRunning(true);
    setAiStatus("queued");
    setAiErrorMessage(null);
    startTransition(async () => {
      setAiProgress(15);
      const res = await generateAiClipFromBlueprint({
        blueprintId: aiBlueprintId,
        userPrompt: aiPrompt.trim(),
        tone: aiTone || "tense",
        genre: aiGenre || "realistic",
        realismLevel: aiRealism,
        durationSeconds: 6,
      });

      if ((res as { error?: string }).error) {
        const message = (res as { error?: string }).error || "Generation failed";
        toast({ title: "Generation failed", description: message, variant: "destructive" });
        setAiErrorMessage(message);
        setAiProgress(0);
        setAiRunning(false);
        setAiStatus("failed");
        return;
      }

      setAiProgress(100);
      toast({ title: "AI clip generated!", description: "Your clip is now live", variant: "success" });
      setTimeout(() => router.push("/feed"), 300);
      setAiRunning(false);
      setAiStatus(null);
      setAiErrorMessage(null);
    });
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="space-y-4 p-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Film className="h-5 w-5 text-primary" />
                Upload Clip
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* File Input */}
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
                {file ? (
                  <div className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Film className="h-5 w-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(file.size / (1024 * 1024)).toFixed(1)} MB
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={handleRemoveFile}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full flex-col items-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 px-4 py-10 transition-colors hover:border-primary/50 hover:bg-muted/50"
                  >
                    <Upload className="h-8 w-8 text-muted-foreground" />
                    <div className="text-center">
                      <p className="text-sm font-medium">Tap to select video</p>
                      <p className="text-xs text-muted-foreground">MP4, MOV, WebM</p>
                    </div>
                  </button>
                )}
              </div>

              {/* Title */}
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="title">
                  Title
                </label>
                <Input
                  id="title"
                  placeholder="Give your clip a title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                />
              </div>

              {/* Genre */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Genre</label>
                <Select value={genre} onValueChange={setGenre}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select genre" />
                  </SelectTrigger>
                  <SelectContent>
                    {GENRES.map((g) => (
                      <SelectItem key={g.value} value={g.value}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Tone */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Tone</label>
                <Select value={tone} onValueChange={setTone}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select tone" />
                  </SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Progress */}
              {isPending && uploadProgress > 0 && (
                <div className="space-y-2">
                  <Progress value={uploadProgress} />
                  <p className="text-center text-xs text-muted-foreground">
                    Uploading... {uploadProgress}%
                  </p>
                </div>
              )}

              {/* Upload Button */}
              <Button
                className="w-full"
                size="lg"
                onClick={handleUpload}
                disabled={isPending || !file || !title.trim()}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload Clip
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Film className="h-5 w-5 text-primary" />
                Generate AI Clip (fal.ai)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Blueprint</label>
                <Select value={aiBlueprintId} onValueChange={setAiBlueprintId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select blueprint" />
                  </SelectTrigger>
                  <SelectContent>
                    {blueprints.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {blueprints.find((b) => b.id === aiBlueprintId)?.description && (
                  <p className="text-xs text-muted-foreground">
                    {blueprints.find((b) => b.id === aiBlueprintId)?.description}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="aiPrompt">
                  Prompt
                </label>
                <Input
                  id="aiPrompt"
                  placeholder="e.g. cute black dog in a sunny park"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  maxLength={200}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Genre</label>
                  <Select value={aiGenre} onValueChange={setAiGenre}>
                    <SelectTrigger>
                      <SelectValue placeholder="Genre" />
                    </SelectTrigger>
                    <SelectContent>
                      {GENRES.map((g) => (
                        <SelectItem key={g.value} value={g.value}>
                          {g.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tone</label>
                  <Select value={aiTone} onValueChange={setAiTone}>
                    <SelectTrigger>
                      <SelectValue placeholder="Tone" />
                    </SelectTrigger>
                    <SelectContent>
                      {TONES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Realism</label>
                <Select value={aiRealism} onValueChange={setAiRealism}>
                  <SelectTrigger>
                    <SelectValue placeholder="Realism" />
                  </SelectTrigger>
                  <SelectContent>
                    {REALISM_LEVELS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {aiRunning && aiProgress > 0 && (
                <div className="space-y-2">
                  <Progress value={aiProgress} />
                  <p className="text-center text-xs text-muted-foreground">
                    Generating... {aiStatus ? aiStatus.replaceAll("_", " ") : "processing"} (can take 1–2 min)
                  </p>
                </div>
              )}

              {!!aiErrorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  Generation failed: {aiErrorMessage}
                </div>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleGenerateAi}
                disabled={aiRunning || isPending || !aiBlueprintId || !aiPrompt.trim()}
              >
                {aiRunning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Film className="h-4 w-4" />
                    Generate Clip
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
