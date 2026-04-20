"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { DirectionalBetPad } from "./DirectionalBetPad";
import { useCountdown } from "./useCountdown";
import { transportEmoji } from "./transportEmoji";
import { BetPlacedPill, LiveEventToasts, useBetPill } from "./LiveEventToasts";
import { TopBar } from "@/components/layout/top-bar";
import { BottomNav } from "@/components/layout/bottom-nav";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), { ssr: false });

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(initialRoom.routePoints ?? []);
  const [betAmount, setBetAmount] = useState(10);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { betPill, flash } = useBetPill();

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const [stateRes] = await Promise.all([
          fetch(`/api/live/rooms/${initialRoom.roomId}/state`, { cache: "no-store" }),
          fetch(`/api/live/rooms/${initialRoom.roomId}/tick`, { cache: "no-store", method: "POST" }),
        ]);
        if (stateRes.ok) {
          const json = (await stateRes.json()) as { room: LiveFeedRow | null };
          if (json.room) setRoom(json.room);
        }
      } catch { /* transient */ }
    }, 2000);
    return () => clearInterval(id);
  }, [initialRoom.roomId]);

  useEffect(() => {
    const fetchPoints = async () => {
      try {
        const res = await fetch(`/api/live/sessions/${room.liveSessionId}/route-points`, { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { points: RoutePoint[] };
          setRoutePoints(json.points);
        }
      } catch { /* transient */ }
    };
    fetchPoints();
    const id = setInterval(fetchPoints, 3000);
    return () => clearInterval(id);
  }, [room.liveSessionId]);

  async function placeBet(optionId: string) {
    if (!room.currentMarket) return;
    setError(null);
    setPlacingOptionId(optionId);
    try {
      const res = await fetch(`/api/live/rooms/${room.roomId}/bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: room.currentMarket.id, optionId, stakeAmount: betAmount }),
      });
      if (res.ok) {
        flash(betAmount);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Bet failed");
      }
    } finally {
      setPlacingOptionId(null);
    }
  }

  const currentMarket = room.currentMarket;
  const isLocked = currentMarket ? new Date(currentMarket.locksAt) <= new Date() : true;

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <TopBar />
      <BottomNav />
      <LiveEventToasts roomId={room.roomId} role="viewer" />
      <BetPlacedPill text={betPill} />
      {/* ── Video — absolute fill ─────────────────────────── */}
      <div className="absolute inset-0 z-0">
        <LiveVideoPlayer liveSessionId={room.liveSessionId} className="h-full w-full" />
      </div>

      {/* ── Top gradient scrim ───────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-36 bg-gradient-to-b from-black/75 to-transparent" />

      {/* ── Top bar — LIVE · name · mode · $amount stepper (sits below app TopBar) ── */}
      <div className="absolute inset-x-0 top-12 z-40 flex items-center gap-2 px-4 py-3 text-sm">
        <span className="rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide">
          LIVE
        </span>
        <span className="font-semibold text-white drop-shadow">{room.characterName}</span>
        <span className="text-white/55 drop-shadow text-xs">
          {transportEmoji(room.transportMode)} {room.transportMode.replace("_", " ")}
        </span>

        {/* Bet amount stepper — right side of top bar */}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setBetAmount((n) => Math.max(1, n - 5))}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-sm font-bold text-white backdrop-blur active:bg-white/30"
          >
            −
          </button>
          <span className="min-w-[2.8rem] text-center text-sm font-semibold text-white drop-shadow">
            ${betAmount}
          </span>
          <button
            type="button"
            onClick={() => setBetAmount((n) => n + 5)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-sm font-bold text-white backdrop-blur active:bg-white/30"
          >
            +
          </button>
        </div>
      </div>

      {/* ── Map overlay — upper-right, below both bars ── */}
      <div
        className="absolute z-30 overflow-hidden rounded-2xl border border-white/25 shadow-2xl backdrop-blur-sm"
        style={{ top: 108, right: 12, width: "56vw", height: "56vw", maxWidth: 260, maxHeight: 260, opacity: 0.85 }}
      >
        <LiveMap
          routePoints={routePoints}
          className="h-full w-full"
          interactive={false}
          audienceRole="viewer"
          transportMode={room.transportMode}
          rotateWithHeading={true}
          tileOpacity={0.65}
          mapCaption={currentMarket?.title}
        />
        {routePoints.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[9px] text-white/40">
            Waiting for GPS…
          </div>
        )}
      </div>

      {/* ── Bottom gradient scrim ────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-black/70 to-transparent" />

      {/* BottomNav is z-50 — pad must be z>50 or touches go to nav and no UI feedback works */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-1 px-4 pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))]">
        <div className="pointer-events-auto flex flex-col items-center gap-1">
        {currentMarket ? (
          <div className="flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/85 backdrop-blur-sm">
            <span className="font-semibold leading-none drop-shadow">{currentMarket.title}</span>
            <MarketTimer locksAt={currentMarket.locksAt} />
          </div>
        ) : null}

        <DirectionalBetPad
          options={currentMarket?.options ?? []}
          betAmount={betAmount}
          onBet={async (optionId) => { await placeBet(optionId); }}
          locked={isLocked || !currentMarket || !!placingOptionId}
          routePoints={routePoints}
        />

        {error && <div className="text-[10px] text-red-400">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function MarketTimer({ locksAt }: { locksAt: string }) {
  const { secondsLeft, label } = useCountdown(locksAt);
  const locked = secondsLeft <= 0;
  return (
    <span className={`shrink-0 text-xs font-semibold ${
      locked ? "text-red-400" : secondsLeft < 10 ? "text-amber-400" : "text-white/45"
    }`}>
      {locked ? "locked" : label}
    </span>
  );
}
