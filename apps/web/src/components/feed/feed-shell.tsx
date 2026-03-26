"use client";

import { useCallback, useRef, useEffect } from "react";
import { useFeedStore } from "@/stores/feed-store";
import { VideoCard } from "./video-card";
import type { FeedClip } from "@/actions/clips";
import { Skeleton } from "@/components/ui/skeleton";
import { getMediaUrl } from "@/lib/utils";

interface FeedShellProps {
  initialClips: FeedClip[];
}

export function FeedShell({ initialClips }: FeedShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentIndex = useFeedStore((s) => s.currentIndex);
  const setCurrentIndex = useFeedStore((s) => s.setCurrentIndex);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const height = container.clientHeight;
    const newIndex = Math.round(scrollTop / height);

    if (newIndex !== currentIndex) {
      setCurrentIndex(newIndex);
    }
  }, [currentIndex, setCurrentIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    // Warm browser cache for nearby clips to reduce route/refresh wait.
    const nearby = [currentIndex - 1, currentIndex, currentIndex + 1]
      .map((i) => initialClips[i])
      .filter(Boolean) as FeedClip[];

    nearby.forEach((clip) => {
      const url = getMediaUrl(clip.video_storage_path);
      if (!url) return;
      fetch(url, { cache: "force-cache", mode: "no-cors" }).catch(() => {});
    });
  }, [currentIndex, initialClips]);

  if (initialClips.length === 0) {
    return <EmptyFeed />;
  }

  return (
    <div
      ref={containerRef}
      className="no-scrollbar h-full snap-y snap-mandatory overflow-y-scroll"
    >
      {initialClips.map((clip, index) => (
        <div key={clip.id} className="h-full w-full snap-start">
          <VideoCard clip={clip} isActive={index === currentIndex} />
        </div>
      ))}
    </div>
  );
}

function EmptyFeed() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 text-6xl">🎬</div>
      <h2 className="text-xl font-bold">No clips yet</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Be the first to upload a clip and start the prediction game!
      </p>
    </div>
  );
}

export function FeedSkeleton() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <Skeleton className="h-full w-full" />
    </div>
  );
}
