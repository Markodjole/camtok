"use client";

import { useEffect, useState } from "react";
import type { FeedClip } from "@/actions/clips";
import { AiChatPanel } from "@/components/character/ai-chat-panel";

export function FeedClipAiChat({ clip, isActive }: { clip: FeedClip; isActive: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isActive) setOpen(false);
  }, [isActive]);

  const name = clip.character_name?.trim();
  const headerTitle = name ? `AI search: ${name} · this clip` : "AI search: this clip";
  const introMessage = name
    ? `Ask about this video or ${name}. I use this clip's scene data and the character's profile — not guesses.`
    : `Ask about this video. I use this clip's scene summary and metadata only.`;

  return (
    <AiChatPanel
      open={open}
      onOpenChange={setOpen}
      triggerVariant="feed-column"
      headerTitle={headerTitle}
      introMessage={introMessage}
      inputPlaceholder={name ? `Ask about this clip or ${name}...` : "Ask about this clip..."}
      suggestionChips={
        name
          ? [
              "what happens in this clip?",
              "top betting edge here?",
              "how would they act next?",
            ]
          : ["what happens in this clip?", "what's unresolved?", "what should I bet on?"]
      }
      askUrl={`/api/clips/${clip.id}/ask`}
    />
  );
}
