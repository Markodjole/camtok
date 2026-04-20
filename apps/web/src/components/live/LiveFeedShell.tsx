"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveFeedRow } from "@/actions/live-feed";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";
import { transportEmoji } from "./transportEmoji";
import { useCountdown } from "./useCountdown";

export function LiveFeedShell({ initialItems }: { initialItems: LiveFeedRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const liveSnapIndex = useViewerChromeStore((s) => s.liveSnapIndex);
  const setLiveSnapIndex = useViewerChromeStore((s) => s.setLiveSnapIndex);
  const hydratePreferences = useViewerChromeStore((s) => s.hydratePreferences);
  const [items, setItems] = useState<LiveFeedRow[]>(initialItems);

  useEffect(() => {
    hydratePreferences();
  }, [hydratePreferences]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/live/rooms", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { items: LiveFeedRow[] };
        setItems(json.items);
      } catch {
        /* ignore */
      }
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = container.scrollTop;
    const height = container.clientHeight;
    const newIndex = Math.round(scrollTop / height);
    if (newIndex !== liveSnapIndex) setLiveSnapIndex(newIndex);
  }, [liveSnapIndex, setLiveSnapIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.code === "Space" || e.key === " ") && !isTypingTarget(e.target)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center text-muted-foreground">
        <p className="text-lg font-medium">No one is live yet.</p>
        <p className="mt-1 text-sm">Check back in a minute, or go live yourself.</p>
        <Link
          href="/live/go"
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          Start your live stream
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="no-scrollbar h-full min-h-0 w-full"
      style={{
        overflowY: "scroll",
        scrollSnapType: "y mandatory",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {items.map((row, index) => (
        <div
          key={row.roomId}
          className="w-full"
          style={{ height: "100%", scrollSnapAlign: "start" }}
        >
          <LiveSnapSlide row={row} isActive={index === liveSnapIndex} />
        </div>
      ))}
    </div>
  );
}

function LiveSnapSlide({ row, isActive }: { row: LiveFeedRow; isActive: boolean }) {
  return (
    <Link
      href={`/live/rooms/${row.roomId}`}
      prefetch={isActive}
      className="relative flex h-full w-full flex-col bg-black"
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/80"
        aria-hidden
      />
      <div className="relative z-10 flex flex-1 flex-col justify-end px-5 pb-8 pt-20">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide">
            LIVE
          </span>
          <span className="text-lg font-semibold text-white drop-shadow">{row.characterName}</span>
        </div>
        <div className="mt-1 text-sm text-white/70 drop-shadow">
          {transportEmoji(row.transportMode)} {row.transportMode.replace("_", " ")}
        </div>
        {row.statusText ? (
          <p className="mt-2 line-clamp-2 text-sm text-white/85 drop-shadow">{row.statusText}</p>
        ) : null}
        <p className="mt-1 text-xs text-white/50 drop-shadow">
          {row.regionLabel ?? "Unknown area"}
          {row.placeType ? ` · ${row.placeType}` : null}
        </p>
        <MarketStrip row={row} />
        <p className="mt-6 text-center text-sm font-medium text-primary drop-shadow">
          Tap to watch & bet →
        </p>
      </div>
    </Link>
  );
}

function MarketStrip({ row }: { row: LiveFeedRow }) {
  if (!row.currentMarket) {
    return (
      <div className="mt-3 text-xs text-white/45 drop-shadow">Waiting for next market…</div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded bg-primary/25 px-2 py-1 font-medium text-primary-foreground drop-shadow">
        {row.currentMarket.title}
      </span>
      <LockCountdown locksAt={row.currentMarket.locksAt} />
    </div>
  );
}

function LockCountdown({ locksAt }: { locksAt: string }) {
  const { secondsLeft, label } = useCountdown(locksAt);
  if (secondsLeft <= 0) {
    return <span className="text-white/50 drop-shadow">locked</span>;
  }
  return <span className="text-white/50 drop-shadow">closes in {label}</span>;
}
