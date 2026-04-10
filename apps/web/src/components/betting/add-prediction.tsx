"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getClipById } from "@/actions/clips";
import { getCharacterById } from "@/actions/characters";
import { submitPrediction } from "@/actions/predictions";
import { getClipContinuationContext, getVideoAnalysisStatus } from "@/actions/video-analysis";
import type { ContinuationContext } from "@/video-intelligence/types";
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
  /** From clip author's LLM plan: prediction_starters + outcomes (shown immediately after post). */
  const [clipAuthorSuggestions, setClipAuthorSuggestions] = useState<
    Array<{
      rawText: string;
      yesProbability: number;
      noProbability: number;
      yesOdds: number;
      noOdds: number;
    }>
  >([]);
  /** Fallback suggestions from character betting_signals (shown even if video-analysis is pending/empty). */
  const [bettingSignalSuggestions, setBettingSignalSuggestions] = useState<
    Array<{
      rawText: string;
      yesProbability: number;
      noProbability: number;
      yesOdds: number;
      noOdds: number;
    }>
  >([]);
  /** True while polling for stored video analysis (server-side pipeline can take 1–2+ minutes). */
  const [awaitingVideoAnalysis, setAwaitingVideoAnalysis] = useState(false);
  /** Gave up polling without ever getting stored analysis (often env/timeout — check Vercel logs + video_analyses row). */
  const [analysisPollExhausted, setAnalysisPollExhausted] = useState(false);
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

  function toSuggestion(rawText: string, probability = 0.56) {
    const yesProbability = calibrateProbability(probability);
    const noProbability = clamp01(1 - yesProbability);
    return {
      rawText,
      yesProbability,
      noProbability,
      yesOdds: probToOdds(yesProbability),
      noOdds: probToOdds(noProbability),
    };
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

  function outcomeToPredictionLabel(characterName: string, outcome: string): string {
    const o = outcome.trim();
    const name = characterName.trim();
    if (!o) return "";
    if (!name) return o;
    if (o.toLowerCase().includes(name.toLowerCase())) return o;
    return `${name} ${o.charAt(0).toLowerCase()}${o.slice(1)}`;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clip = await getClipById(clipNodeId);
        if (!clip || cancelled) {
          if (!cancelled) setClipAuthorSuggestions([]);
          return;
        }
        const llm = (clip as Record<string, unknown>).llm_generation_json as Record<string, unknown> | null;
        if (!llm) {
          if (!cancelled) setClipAuthorSuggestions([]);
          return;
        }
        const charName = typeof llm.character_name === "string" ? llm.character_name.trim() : "";
        const byKey = new Map<
          string,
          {
            rawText: string;
            yesProbability: number;
            noProbability: number;
            yesOdds: number;
            noOdds: number;
          }
        >();

        const starters = Array.isArray(llm.prediction_starters) ? llm.prediction_starters : [];
        for (const s of starters) {
          if (!s || typeof s !== "object") continue;
          const rec = s as Record<string, unknown>;
          const label = String(rec.label ?? "").trim();
          if (!label) continue;
          const k = canonicalSuggestionKey(label);
          if (!k || existingPredictionKeys.has(k)) continue;
          let h = Number(rec.opening_yes_hint);
          if (!Number.isFinite(h)) h = 0.5;
          const sug = toSuggestion(label, h);
          byKey.set(k, sug);
        }

        const outcomes = Array.isArray(llm.outcomes)
          ? (llm.outcomes as unknown[]).map((x) => String(x).trim()).filter(Boolean)
          : [];
        for (const o of outcomes) {
          const label = outcomeToPredictionLabel(charName, o);
          if (!label) continue;
          const k = canonicalSuggestionKey(label);
          if (!k || existingPredictionKeys.has(k) || byKey.has(k)) continue;
          byKey.set(k, toSuggestion(label, 0.52));
        }

        if (!cancelled) setClipAuthorSuggestions(Array.from(byKey.values()).slice(0, 10));
      } catch {
        if (!cancelled) setClipAuthorSuggestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clipNodeId, existingPredictionKeys]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clip = await getClipById(clipNodeId);
        const characterId = (clip as { character_id?: string | null } | null)?.character_id;
        if (!characterId) {
          if (!cancelled) setBettingSignalSuggestions([]);
          return;
        }
        const { character } = await getCharacterById(characterId);
        if (!character || cancelled) return;

        const signals = character.betting_signals ?? ({} as Record<string, unknown>);
        const quickRead = Array.isArray(signals.quick_read) ? (signals.quick_read as string[]) : [];
        const exploitable = Array.isArray(signals.exploitable_tendencies)
          ? (signals.exploitable_tendencies as string[])
          : [];
        const choicePatterns =
          typeof signals.choice_patterns === "object" && signals.choice_patterns
            ? (signals.choice_patterns as Record<string, number>)
            : {};

        const lines: string[] = [];
        for (const q of quickRead.slice(0, 4)) {
          lines.push(`${character.name} follows this tendency now: ${q}`);
        }
        for (const t of exploitable.slice(0, 3)) {
          lines.push(`${character.name} shows this tell next: ${t}`);
        }
        const sortedChoices = Object.entries(choicePatterns)
          .filter(([, v]) => typeof v === "number")
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, 3)
          .map(([k]) => k.replace(/_/g, " "));
        for (const key of sortedChoices) {
          lines.push(`${character.name} chooses ${key} in the next beat`);
        }

        const seen = new Set<string>();
        const built = lines
          .map((raw) => raw.trim())
          .filter(Boolean)
          .filter((raw) => {
            const k = canonicalSuggestionKey(raw);
            if (!k || existingPredictionKeys.has(k) || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, 8)
          .map((raw) => toSuggestion(raw, 0.58));

        if (!cancelled) setBettingSignalSuggestions(built);
      } catch {
        if (!cancelled) setBettingSignalSuggestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clipNodeId, existingPredictionKeys]);

  useEffect(() => {
    let cancelled = false;
    const POLL_MS = 5000;
    const MAX_POLLS = 48;

    function applyContext(context: ContinuationContext) {
      const nextStepByCanonical = new Map<
        string,
        { rawText: string; yesProbability: number; noProbability: number }
      >();

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
          const prev = nextStepByCanonical.get(key)!;
          if (yesProbability > prev.yesProbability) {
            nextStepByCanonical.set(key, { rawText, yesProbability, noProbability });
          }
        }
      }

      const built = Array.from(nextStepByCanonical.values())
        .map((s) => ({
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
    }

    (async () => {
      setSuggestionsError(null);
      setSuggestionsLoading(true);
      setAwaitingVideoAnalysis(false);
      setAnalysisPollExhausted(false);
      setSuggestedPredictions([]);
      setAvailableOptionVariables([]);

      for (let i = 0; i < MAX_POLLS; i++) {
        if (cancelled) return;

        try {
          const { context, error } = await getClipContinuationContext(clipNodeId);
          if (cancelled) return;

          if (error) {
            setSuggestionsError(error);
            setSuggestionsLoading(false);
            return;
          }

          if (context) {
            applyContext(context);
            setAwaitingVideoAnalysis(false);
            setSuggestionsLoading(false);
            return;
          }

          const st = await getVideoAnalysisStatus(clipNodeId);
          if (cancelled) return;

          if (st?.status === "failed" && st.error) {
            setSuggestionsError(st.error);
            setAwaitingVideoAnalysis(false);
            setSuggestionsLoading(false);
            return;
          }

          if (i < MAX_POLLS - 1) {
            setAwaitingVideoAnalysis(true);
            await new Promise((r) => setTimeout(r, POLL_MS));
          }
        } catch (err) {
          if (!cancelled) {
            setSuggestionsError(err instanceof Error ? err.message : "Failed to load suggestions");
            setAwaitingVideoAnalysis(false);
            setSuggestionsLoading(false);
          }
          return;
        }
      }

      if (!cancelled) {
        setAwaitingVideoAnalysis(false);
        setAnalysisPollExhausted(true);
        setSuggestionsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
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

  const suggestions = useMemo(() => {
    const byKey = new Map<
      string,
      { rawText: string; yesProbability: number; noProbability: number; yesOdds: number; noOdds: number }
    >();
    function mergeIn(list: typeof clipAuthorSuggestions, authorTier: boolean) {
      for (const s of list) {
        const key = canonicalSuggestionKey(s.rawText);
        if (!key || existingPredictionKeys.has(key)) continue;
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, s);
          continue;
        }
        if (authorTier) continue;
        if (s.yesProbability > prev.yesProbability) byKey.set(key, s);
      }
    }
    mergeIn(clipAuthorSuggestions, true);
    mergeIn(suggestedPredictions, false);
    mergeIn(bettingSignalSuggestions, false);
    return Array.from(byKey.values());
  }, [suggestedPredictions, bettingSignalSuggestions, clipAuthorSuggestions, existingPredictionKeys]);
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
            {suggestionsLoading && matchingSuggestions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {awaitingVideoAnalysis
                  ? "Analyzing video… clip author + character suggestions below; full video-based options when ready."
                  : "Loading options…"}
              </div>
            ) : suggestionsError && matchingSuggestions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-destructive">
                {suggestionsError}
              </div>
            ) : !text.trim() ? (
              matchingSuggestions.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {analysisPollExhausted
                    ? "No AI suggestions yet after waiting. Refresh the page, or check server logs / video_analyses for failures (LLM keys, timeouts, storage)."
                    : "No next-step candidates from analysis. You can still type a prediction."}
                </div>
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
