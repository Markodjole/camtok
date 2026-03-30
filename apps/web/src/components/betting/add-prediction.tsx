"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitPrediction } from "@/actions/predictions";
import { getClipContinuationContext } from "@/actions/video-analysis";
import { useToast } from "@/components/ui/toast";
import { Sparkles, Loader2 } from "lucide-react";

interface AddPredictionProps {
  clipNodeId: string;
  onPredictionAdded: () => void;
  existingPredictions?: string[];
}

export function AddPrediction({
  clipNodeId,
  onPredictionAdded,
  existingPredictions = [],
}: AddPredictionProps) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestedPredictions, setSuggestedPredictions] = useState<
    Array<{
      rawText: string;
      yesProbability: number;
      noProbability: number;
      yesOdds: number;
      noOdds: number;
    }>
  >([]);
  const { toast } = useToast();

  function clamp01(n: number) {
    return Math.max(0.05, Math.min(0.95, n));
  }

  function probToOdds(p: number) {
    return Math.round((1 / p) * 100) / 100;
  }

  // Raw model confidences are usually overconfident (e.g. 0.9 on sparse evidence).
  // Calibrate toward 0.5 to get more realistic opening odds.
  function calibrateProbability(p: number) {
    const clamped = clamp01(p);
    const centered = 0.5 + (clamped - 0.5) * 0.28;
    return clamp01(centered);
  }

  function canonicalSuggestionKey(rawText: string) {
    return rawText
      .toLowerCase()
      .replace(/\bboy\b|\bgirl\b|\bman\b|\bwoman\b|\bcharacter\b/g, "")
      .replace(/\bpicks up\b|\bpick up\b|\bgrabs\b|\bgrab\b|\bchooses\b|\bchoose\b/g, "")
      .replace(/\binserts\b|\binsert\b|\binto\b/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const existingPredictionKeys = useMemo(
    () => new Set(existingPredictions.map((p) => canonicalSuggestionKey(p)).filter(Boolean)),
    [existingPredictions],
  );

  useEffect(() => {
    let mounted = true;
    setSuggestionsError(null);
    setSuggestionsLoading(true);
    setSuggestedPredictions([]);

    getClipContinuationContext(clipNodeId)
      .then(({ context, error }) => {
        if (!mounted) return;

        if (error) {
          setSuggestionsError(error);
          setSuggestionsLoading(false);
          return;
        }

        if (!context) {
          setSuggestionsLoading(false);
          return;
        }

        // Build suggestion list from video analysis:
        // - prioritize nextStepCandidates (they already have probabilityScore)
        // - then add availableOptions (use confidence as probability proxy)
        const byCanonical = new Map<
          string,
          { rawText: string; yesProbability: number; noProbability: number }
        >();

        // 1) Add ALL available options first (user requested full list)
        for (const o of context.availableOptions ?? []) {
          const rawText = (o.label ?? "").trim();
          if (!rawText) continue;
          const key = canonicalSuggestionKey(rawText);
          if (!key) continue;

          const yesProbability = calibrateProbability(typeof o.confidence === "number" ? o.confidence : 0.5);
          const noProbability = clamp01(1 - yesProbability);

          if (!byCanonical.has(key)) {
            byCanonical.set(key, { rawText, yesProbability, noProbability });
          }
        }

        // 2) Add ALL next-step candidates (possible outcomes)
        for (const n of context.nextStepCandidates ?? []) {
          const rawText = (n.label ?? "").trim();
          if (!rawText) continue;
          const key = canonicalSuggestionKey(rawText);
          if (!key) continue;

          const yesProbability = calibrateProbability(
            typeof n.probabilityScore === "number" ? n.probabilityScore : 0.5,
          );
          const noProbability = clamp01(1 - yesProbability);

          if (!byCanonical.has(key)) {
            byCanonical.set(key, { rawText, yesProbability, noProbability });
          } else {
            // If duplicate concept exists, keep stronger probability signal.
            const prev = byCanonical.get(key)!;
            if (yesProbability > prev.yesProbability) {
              byCanonical.set(key, { rawText, yesProbability, noProbability });
            }
          }
        }

        const built = Array.from(byCanonical.values()).map((s) => ({
          rawText: s.rawText,
          yesProbability: s.yesProbability,
          noProbability: s.noProbability,
          yesOdds: probToOdds(s.yesProbability),
          noOdds: probToOdds(s.noProbability),
        }))
          .filter((s) => !existingPredictionKeys.has(canonicalSuggestionKey(s.rawText)));

        setSuggestedPredictions(built);
        setSuggestionsLoading(false);
      })
      .catch((err) => {
        if (!mounted) return;
        setSuggestionsError(err instanceof Error ? err.message : "Failed to load suggestions");
        setSuggestionsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [clipNodeId, existingPredictionKeys]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    await submitText(text.trim());
  }

  async function submitText(rawText: string) {
    setLoading(true);

    const payload = { clip_node_id: clipNodeId, raw_text: rawText };
    let result: Awaited<ReturnType<typeof submitPrediction>>;

    try {
      result = await submitPrediction(payload);
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message?.includes("Lock broken"));
      if (isAbort) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          result = await submitPrediction(payload);
        } catch (retryErr) {
          toast({
            title: "Failed to submit",
            description: "Connection conflict. Please try again.",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }
      } else {
        toast({
          title: "Failed to submit",
          description: err instanceof Error ? err.message : "Something went wrong",
          variant: "destructive",
        });
        setLoading(false);
        return;
      }
    }

    if (result!.error) {
      toast({
        title: "Failed to submit",
        description: result!.error,
        variant: "destructive",
      });
    } else {
      toast({
        title: result!.merged ? "Merged with existing" : "Prediction created!",
        description: result!.merged
          ? "Your prediction matched an existing market"
          : "Others can now bet on your prediction",
        variant: "success",
      });
      setText("");
      onPredictionAdded();
    }

    setLoading(false);
  }

  const suggestions = useMemo(() => suggestedPredictions, [suggestedPredictions]);

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <Sparkles className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary pointer-events-none" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setTimeout(() => setInputFocused(false), 120)}
            placeholder="What happens next?"
            className="pl-9 pr-4 py-3"
            maxLength={300}
            disabled={loading}
          />

          {inputFocused && !text.trim() ? (
            <div className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-xl border border-border bg-card/95 backdrop-blur-sm shadow-xl z-20 p-2">
              {suggestionsLoading ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">Loading options...</div>
              ) : suggestionsError ? (
                <div className="px-2 py-2 text-xs text-destructive">Options unavailable</div>
              ) : suggestions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">No predefined options yet</div>
              ) : (
                <div className="space-y-1">
                  {suggestions.map((s) => (
                    <button
                      key={s.rawText}
                      type="button"
                      disabled={loading}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setText(s.rawText);
                        setInputFocused(false);
                      }}
                      className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-secondary/70"
                      title={s.rawText}
                    >
                      <div className="line-clamp-1 text-sm text-foreground">{s.rawText}</div>
                      <div className="text-[11px] text-muted-foreground">
                        Suggested YES odds: {s.yesOdds.toFixed(2)}x
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
        <Button type="submit" size="default" disabled={loading || !text.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
        </Button>
      </form>
    </div>
  );
}
