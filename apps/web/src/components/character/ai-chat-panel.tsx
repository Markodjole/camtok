"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type AiChatPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. fixed bottom-right (character page) vs inline trigger (feed column) */
  triggerVariant: "floating" | "feed-column";
  headerTitle: string;
  introMessage: string;
  inputPlaceholder: string;
  suggestionChips: string[];
  askUrl: string;
};

export function AiChatPanel({
  open,
  onOpenChange,
  triggerVariant,
  headerTitle,
  introMessage,
  inputPlaceholder,
  suggestionChips,
  askUrl,
}: AiChatPanelProps) {
  const [mounted, setMounted] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([{ role: "assistant", content: introMessage }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  async function ask() {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    setQuestion("");
    const nextMessages = [...messages, { role: "user" as const, content: q }];
    setMessages(nextMessages);
    try {
      const res = await fetch(askUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Failed to get answer");
        return;
      }
      const answer = String(data?.answer ?? "").trim();
      if (answer) {
        setMessages((prev) => [...prev, { role: "assistant", content: answer }]);
      }
    } catch (e) {
      setError((e as Error)?.message || "Failed to get answer");
    } finally {
      setLoading(false);
    }
  }

  const floatingPillClass =
    "fixed bottom-20 right-4 z-[130] flex items-center gap-2 rounded-full border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg touch-manipulation";

  const triggerClass =
    triggerVariant === "floating"
      ? floatingPillClass
      : "touch-manipulation";

  const panelInner = (
    <>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-xs font-semibold text-foreground">{headerTitle}</p>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close AI chat"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex h-[calc(100%-41px)] flex-col gap-2 p-3">
        <div className="flex-1 space-y-2 overflow-auto rounded-md border border-border/60 bg-muted/20 p-2">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[92%] rounded-md px-2 py-1 text-xs leading-relaxed ${
                m.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "bg-secondary text-foreground"
              }`}
            >
              {m.content}
            </div>
          ))}
          {loading && (
            <div className="max-w-[92%] rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">
              thinking...
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ask();
            }}
            placeholder={inputPlaceholder}
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void ask()}
            disabled={loading || !question.trim()}
            className="h-9 px-3"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-1">
          {suggestionChips.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setQuestion(chip)}
              className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {chip}
            </button>
          ))}
        </div>

        {error ? <p className="text-xs text-red-500">{error}</p> : null}
      </div>
    </>
  );

  const panelShell = (
    <div className="fixed inset-x-2 top-14 bottom-20 z-[110] rounded-2xl border border-border bg-card shadow-2xl">
      {panelInner}
    </div>
  );

  const closeAiPill = open ? (
    <button
      type="button"
      onClick={() => onOpenChange(false)}
      className={floatingPillClass}
      aria-label="Close AI"
    >
      <MessageCircle className="h-4 w-4 text-primary" />
      <span>Close AI</span>
    </button>
  ) : null;

  const feedOpenLayer =
    open && triggerVariant === "feed-column" && mounted
      ? createPortal(
          <>
            {panelShell}
            {closeAiPill}
          </>,
          document.body,
        )
      : null;

  return (
    <>
      {open && triggerVariant === "floating" ? panelShell : null}
      {feedOpenLayer}

      {open && triggerVariant === "floating" ? closeAiPill : null}

      {!open ? (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className={triggerClass}
          aria-label="Ask AI"
        >
          {triggerVariant === "feed-column" ? (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/70 to-cyan-400/70 backdrop-blur-sm ring-1 ring-white/30">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
          ) : (
            <>
              <MessageCircle className="h-4 w-4 text-primary" />
              <span>Ask AI</span>
            </>
          )}
        </button>
      ) : null}
    </>
  );
}
