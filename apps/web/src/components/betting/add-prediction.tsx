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
  const [availableOptionVariables, setAvailableOptionVariables] = useState<string[]>([]);
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
      .replace(/\bboy\b|\bgirl\b|\bman\b|\bwoman\b|\bcharacter\b|\bthey\b|\bboth\b|\bcouple\b/g, "")
      .replace(/\bpicks?\s*up\b|\bpickup\b|\bpickups\b|\bpicksup\b/g, "")
      .replace(/\bgrabs?\b|\bchooses?\b|\bselects?\b|\btakes?\b/g, "")
      .replace(/\bpress(?:es|ed)?\b|\bclick(?:s|ed)?\b|\bhit(?:s)?\b/g, "")
      .replace(/\binserts?\b|\binto\b/g, "")
      .replace(/\bputs?\s*(?:in|back|down|on)\b|\bplaces?\b|\breturns?\b|\btoss(?:es)?\b|\bdrops?\b/g, "")
      .replace(/\bwalks?\s*(?:toward|towards|to|over)?\b|\bgoes?\s*to\b|\bheads?\s*(?:to|toward|towards)?\b/g, "")
      .replace(/\bhands?\s*(?:over|to)?\b|\bshows?\b|\bexamines?\b|\binspects?\b|\bcompares?\b/g, "")
      .replace(/\badds?\s*to\b|\bdecides?\s*on\b/g, "")
      .replace(/\bthe\b|\ba\b|\ban\b/g, "")
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
    setAvailableOptionVariables([]);

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

        // Build suggestion list ONLY from nextStepCandidates.
        const nextStepByCanonical = new Map<
          string,
          { rawText: string; yesProbability: number; noProbability: number }
        >();

        // Add ALL next-step candidates (possible outcomes)
        for (const n of context.nextStepCandidates ?? []) {
          const rawText = (n.label ?? "").trim();
          if (!rawText) continue;
          const key = canonicalSuggestionKey(rawText);
          if (!key) continue;

          const yesProbability = calibrateProbability(
            typeof n.probabilityScore === "number" ? n.probabilityScore : 0.5,
          );
          const noProbability = clamp01(1 - yesProbability);

          if (!nextStepByCanonical.has(key)) {
            nextStepByCanonical.set(key, { rawText, yesProbability, noProbability });
          } else {
            // If duplicate concept exists, keep stronger probability signal.
            const prev = nextStepByCanonical.get(key)!;
            if (yesProbability > prev.yesProbability) {
              nextStepByCanonical.set(key, { rawText, yesProbability, noProbability });
            }
          }
        }

        const built = Array.from(nextStepByCanonical.values()).map((s) => ({
          rawText: s.rawText,
          yesProbability: s.yesProbability,
          noProbability: s.noProbability,
          yesOdds: probToOdds(s.yesProbability),
          noOdds: probToOdds(s.noProbability),
        }))
          .filter((s) => !existingPredictionKeys.has(canonicalSuggestionKey(s.rawText)));

        setSuggestedPredictions(built);
        const variableKeys = new Set<string>();
        const variables: string[] = [];
        for (const o of context.availableOptions ?? []) {
          const rawText = (o.label ?? "").trim();
          if (!rawText) continue;
          const key = canonicalSuggestionKey(rawText);
          if (!key || existingPredictionKeys.has(key) || variableKeys.has(key)) continue;
          variableKeys.add(key);
          variables.push(rawText);
        }
        setAvailableOptionVariables(variables);
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
  const typedCanonical = useMemo(() => canonicalSuggestionKey(text), [text]);
  const matchingSuggestions = useMemo(() => {
    if (!typedCanonical) return suggestions;
    return suggestions.filter((s) => {
      const key = canonicalSuggestionKey(s.rawText);
      return key.includes(typedCanonical) || typedCanonical.includes(key);
    });
  }, [typedCanonical, suggestions]);
  const hasCandidateMatch = matchingSuggestions.length > 0;

  function appendVariable(label: string) {
    setText((prev) => {
      const trimmed = prev.trimEnd();
      const sep = trimmed ? " " : "";
      return `${trimmed}${sep}${label}`;
    });
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="relative flex gap-2">
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

        </div>
        <Button type="submit" size="default" disabled={loading || !text.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
        </Button>

        {inputFocused ? (
          <div className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-card/95 backdrop-blur-sm shadow-xl z-20 p-2">
            {suggestionsLoading ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">Loading options...</div>
            ) : suggestionsError ? (
              <div className="px-2 py-2 text-xs text-destructive">Options unavailable</div>
            ) : !text.trim() ? (
              matchingSuggestions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">No next-step candidates yet</div>
              ) : (
                <div className="space-y-1">
                  {matchingSuggestions.map((s) => (
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
              )
            ) : hasCandidateMatch ? (
              <div className="space-y-1">
                <div className="px-2 py-1 text-[11px] text-muted-foreground">Matching next-step candidates</div>
                {matchingSuggestions.map((s) => (
                  <button
                    key={s.rawText}
                    type="button"
                    disabled={loading}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setText(s.rawText);
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
            ) : (
              <div className="space-y-2">
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  No candidate match. Insert available option variable:
                </div>
                <div className="flex flex-wrap gap-1.5 px-1">
                  {availableOptionVariables.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No available option variables</div>
                  ) : (
                    availableOptionVariables.map((v) => (
                      <button
                        key={v}
                        type="button"
                        disabled={loading}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          appendVariable(v);
                        }}
                        className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground hover:bg-secondary/70"
                        title={`Insert variable: ${v}`}
                      >
                        {v}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </form>
    </div>
  );
}
