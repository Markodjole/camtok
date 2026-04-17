"use client";

import { useEffect, useState } from "react";
import type { LiveFeedRow } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { useCountdown } from "./useCountdown";
import { transportEmoji } from "./transportEmoji";

type MarketOption = {
  id: string;
  label: string;
  shortLabel?: string;
  displayOrder: number;
};

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const [stateRes] = await Promise.all([
          fetch(`/api/live/rooms/${initialRoom.roomId}/state`, { cache: "no-store" }),
          fetch(`/api/live/rooms/${initialRoom.roomId}/tick`, {
            cache: "no-store",
            method: "POST",
          }),
        ]);
        if (stateRes.ok) {
          const json = (await stateRes.json()) as { room: LiveFeedRow | null };
          if (json.room) setRoom(json.room);
        }
      } catch {
        // transient
      }
    }, 2000);
    return () => clearInterval(id);
  }, [initialRoom.roomId]);

  async function placeBet(optionId: string) {
    if (!room.currentMarket) return;
    setError(null);
    setPlacingOptionId(optionId);
    try {
      const res = await fetch(`/api/live/rooms/${room.roomId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: room.currentMarket.id,
          optionId,
          stakeAmount: 10,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Bet failed");
      }
    } finally {
      setPlacingOptionId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-400">
            LIVE
          </span>
          <span className="font-semibold">{room.characterName}</span>
          <span className="text-muted-foreground">
            {transportEmoji(room.transportMode)} {room.transportMode.replace("_", " ")}
          </span>
        </div>
        {room.statusText ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{room.statusText}</div>
        ) : null}
      </div>

      <LiveVideoPlayer liveSessionId={room.liveSessionId} />

      <div className="p-4">
        {room.currentMarket ? (
          <MarketCard
            marketTitle={room.currentMarket.title}
            options={room.currentMarket.options}
            locksAt={room.currentMarket.locksAt}
            placingOptionId={placingOptionId}
            onPickOption={placeBet}
          />
        ) : (
          <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            Waiting for next market…
          </div>
        )}
        {error ? (
          <div className="mt-2 text-xs text-red-400">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

function MarketCard({
  marketTitle,
  options,
  locksAt,
  placingOptionId,
  onPickOption,
}: {
  marketTitle: string;
  options: MarketOption[];
  locksAt: string;
  placingOptionId: string | null;
  onPickOption: (optionId: string) => void;
}) {
  const { secondsLeft, label } = useCountdown(locksAt);
  const isLocked = secondsLeft <= 0;
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{marketTitle}</div>
        <div className={`text-xs ${isLocked ? "text-red-400" : "text-muted-foreground"}`}>
          {isLocked ? "locked" : `closes in ${label}`}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={isLocked || placingOptionId === o.id}
            onClick={() => onPickOption(o.id)}
            className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition hover:border-primary disabled:opacity-50"
          >
            <span>{o.label}</span>
            <span className="text-xs text-muted-foreground">
              {placingOptionId === o.id ? "placing…" : "10 pts"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
