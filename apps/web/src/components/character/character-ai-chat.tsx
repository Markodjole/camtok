"use client";

import { useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CharacterAiChatProps {
  characterId: string;
  characterName: string;
}

export function CharacterAiChat({
  characterId,
  characterName,
}: CharacterAiChatProps) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([
    {
      role: "assistant",
      content: `Ask anything about ${characterName}. I answer from this character's real data and recent outcomes.`,
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    setQuestion("");
    const nextMessages = [...messages, { role: "user" as const, content: q }];
    setMessages(nextMessages);
    try {
      const res = await fetch(`/api/characters/${characterId}/ask`, {
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

  return (
    <>
      {open ? (
        <div className="fixed inset-x-2 top-14 bottom-20 z-[60] rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="text-xs font-semibold text-foreground">
              AI search: {characterName}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close character ai chat"
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
                placeholder={`Ask about ${characterName}...`}
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
              {[
                "top betting edge?",
                "how does he act under pressure?",
                "most likely next choice?",
              ].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setQuestion(q)}
                  className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>

            {error ? (
              <p className="text-xs text-red-500">{error}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-20 right-4 z-[70] ml-auto flex items-center gap-2 rounded-full border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg"
      >
        <MessageCircle className="h-4 w-4 text-primary" />
        {open ? "Close AI" : "Ask AI"}
      </button>
    </>
  );
}

