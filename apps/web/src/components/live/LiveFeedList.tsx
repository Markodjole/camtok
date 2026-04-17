"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LiveFeedRow } from "@/actions/live-feed";
import { transportEmoji } from "./transportEmoji";
import { useCountdown } from "./useCountdown";

export function LiveFeedList({ initialItems }: { initialItems: LiveFeedRow[] }) {
  const [items, setItems] = useState<LiveFeedRow[]>(initialItems);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/live/feed", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { items: LiveFeedRow[] };
        setItems(json.items);
      } catch {
        // ignore transient poll errors
      }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  if (items.length === 0) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center text-center text-muted-foreground">
        <p className="text-lg font-medium">No one is live yet.</p>
        <p className="mt-1 text-sm">Check back in a minute, or go live yourself.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {items.map((row) => (
        <li key={row.roomId}>
          <LiveFeedCard row={row} />
        </li>
      ))}
    </ul>
  );
}

function LiveFeedCard({ row }: { row: LiveFeedRow }) {
  return (
    <Link
      href={`/live/rooms/${row.roomId}`}
      className="flex gap-4 px-4 py-4 transition hover:bg-accent/40"
    >
      <div className="h-16 w-16 shrink-0 rounded-full bg-gradient-to-br from-primary/30 to-primary/10" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-400">
            LIVE
          </span>
          <span className="font-semibold">{row.characterName}</span>
          <span className="text-muted-foreground">
            {transportEmoji(row.transportMode)} {row.transportMode.replace("_", " ")}
          </span>
        </div>
        {row.statusText ? (
          <div className="mt-1 text-sm text-muted-foreground">{row.statusText}</div>
        ) : null}
        <div className="mt-1 text-xs text-muted-foreground">
          {row.regionLabel ?? "Unknown area"}
          {row.placeType ? ` · ${row.placeType}` : null}
        </div>
        <MarketStrip row={row} />
      </div>
    </Link>
  );
}

function MarketStrip({ row }: { row: LiveFeedRow }) {
  if (!row.currentMarket) {
    return (
      <div className="mt-2 text-xs text-muted-foreground">
        Waiting for next market…
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <span className="rounded bg-primary/20 px-2 py-0.5 font-medium text-primary">
        {row.currentMarket.title}
      </span>
      <LockCountdown locksAt={row.currentMarket.locksAt} />
    </div>
  );
}

function LockCountdown({ locksAt }: { locksAt: string }) {
  const { secondsLeft, label } = useCountdown(locksAt);
  if (secondsLeft <= 0) {
    return <span className="text-muted-foreground">locked</span>;
  }
  return <span className="text-muted-foreground">closes in {label}</span>;
}
