"use client";

import { useState } from "react";
import { AiChatPanel } from "@/components/character/ai-chat-panel";

interface CharacterAiChatProps {
  characterId: string;
  characterName: string;
}

export function CharacterAiChat({ characterId, characterName }: CharacterAiChatProps) {
  const [open, setOpen] = useState(false);

  return (
    <AiChatPanel
      open={open}
      onOpenChange={setOpen}
      triggerVariant="floating"
      headerTitle={`AI search: ${characterName}`}
      introMessage={`Ask anything about ${characterName}. I answer from this character's real data and recent outcomes.`}
      inputPlaceholder={`Ask about ${characterName}...`}
      suggestionChips={[
        "top betting edge?",
        "how does he act under pressure?",
        "most likely next choice?",
      ]}
      askUrl={`/api/characters/${characterId}/ask`}
    />
  );
}
