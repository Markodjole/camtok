"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { LiveFeedRow, RoutePoint } from "@/actions/live-feed";
import { LiveVideoPlayer } from "./LiveVideoPlayer";
import { DirectionalBetPad } from "./DirectionalBetPad";
import { useCountdown } from "./useCountdown";
import { transportEmoji } from "./transportEmoji";
import { BetPlacedPill, LiveEventToasts, useBetPill } from "./LiveEventToasts";
import { SkillFeedbackCard, type SkillFeedbackData } from "./SkillFeedbackCard";
import { ReplaySheet } from "./ReplaySheet";
import { TopBar } from "@/components/layout/top-bar";
import { BottomNav } from "@/components/layout/bottom-nav";

const LiveMap = dynamic(() => import("./LiveMap").then((m) => m.LiveMap), {
  ssr: false,
});

type MapZone = {
  id: string;
  slug: string;
  name: string;
  kind: "district" | "corridor" | "mission-zone" | "restricted-zone";
  color: string;
  isActive: boolean;
  polygon: Array<{ lat: number; lng: number }>;
};

type MapCheckpoint = {
  id: string;
  name: string;
  kind: "bridge" | "square" | "landmark" | "crossing" | "poi";
  lat: number;
  lng: number;
  isActive: boolean;
};

function buildMapObjects(anchor: RoutePoint | null): {
  zones: MapZone[];
  checkpoints: MapCheckpoint[];
} {
  const lat = anchor?.lat ?? 44.8125;
  const lng = anchor?.lng ?? 20.4612;
  const dLat = 0.0032;
  const dLng = 0.0045;
  return {
    zones: [
      {
        id: "zone-downtown",
        slug: "downtown",
        name: "Downtown",
        kind: "district",
        color: "#60a5fa",
        isActive: true,
        polygon: [
          { lat: lat + dLat * 0.7, lng: lng - dLng * 1.05 },
          { lat: lat + dLat * 1.25, lng: lng - dLng * 0.3 },
          { lat: lat + dLat * 0.45, lng: lng + dLng * 0.55 },
          { lat: lat - dLat * 0.35, lng: lng - dLng * 0.5 },
        ],
      },
      {
        id: "zone-riverside",
        slug: "riverside",
        name: "Riverside",
        kind: "corridor",
        color: "#22c55e",
        isActive: true,
        polygon: [
          { lat: lat - dLat * 1.4, lng: lng - dLng * 0.1 },
          { lat: lat - dLat * 1.05, lng: lng + dLng * 0.9 },
          { lat: lat - dLat * 0.15, lng: lng + dLng * 1.2 },
          { lat: lat - dLat * 0.5, lng: lng + dLng * 0.1 },
        ],
      },
      {
        id: "zone-old-town",
        slug: "old-town",
        name: "Old Town",
        kind: "district",
        color: "#a78bfa",
        isActive: true,
        polygon: [
          { lat: lat + dLat * 0.2, lng: lng - dLng * 1.55 },
          { lat: lat + dLat * 0.95, lng: lng - dLng * 1.15 },
          { lat: lat + dLat * 0.25, lng: lng - dLng * 0.65 },
          { lat: lat - dLat * 0.45, lng: lng - dLng * 1.15 },
        ],
      },
    ],
    checkpoints: [
      { id: "cp-bridge", name: "Bridge", kind: "bridge", lat: lat + dLat * 0.15, lng: lng + dLng * 0.8, isActive: true },
      { id: "cp-square", name: "Square", kind: "square", lat: lat - dLat * 0.8, lng: lng - dLng * 0.6, isActive: true },
      { id: "cp-crossing", name: "Major Crossing", kind: "crossing", lat: lat + dLat * 0.55, lng: lng - dLng * 0.15, isActive: true },
    ],
  };
}

export function LiveRoomScreen({ initialRoom }: { initialRoom: LiveFeedRow }) {
  const [room, setRoom] = useState<LiveFeedRow>(initialRoom);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>(
    initialRoom.routePoints ?? [],
  );
  const [betAmount, setBetAmount] = useState(10);
  const [placingOptionId, setPlacingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [skillFeedback, setSkillFeedback] = useState<SkillFeedbackData | null>(null);
  /** When true: map is full-screen, camera feed is in the corner pip */
  const [mapExpanded, setMapExpanded] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedMapOptionId, setSelectedMapOptionId] = useState<string | null>(null);
  const [showZones, setShowZones] = useState(true);
  const [showCheckpoints, setShowCheckpoints] = useState(true);
  const showLiveBets = true;
  const skillFeedbackTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const { betPill, flash } = useBetPill();

  const handleSettlement = useCallback((data: SkillFeedbackData) => {
    setSkillFeedback(data);
    if (skillFeedbackTimerRef.current) clearTimeout(skillFeedbackTimerRef.current);
    skillFeedbackTimerRef.current = setTimeout(() => setSkillFeedback(null), 7000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        // Room state only — tick is driven by the streamer panel so we do not
        // POST /tick from every viewer (dev terminal spam + redundant load).
        const stateRes = await fetch(`/api/live/rooms/${initialRoom.roomId}/state`, {
          cache: "no-store",
        });
        if (stateRes.ok) {
          const json = (await stateRes.json()) as { room: LiveFeedRow | null };
          if (json.room) setRoom(json.room);
        }
      } catch {
        /* transient */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [initialRoom.roomId]);

  useEffect(() => {
    const fetchPoints = async () => {
      try {
        const res = await fetch(
          `/api/live/sessions/${room.liveSessionId}/route-points`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const json = (await res.json()) as { points: RoutePoint[] };
          setRoutePoints(json.points);
        }
      } catch {
        /* transient */
      }
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
        body: JSON.stringify({
          marketId: room.currentMarket.id,
          optionId,
          stakeAmount: betAmount,
        }),
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
  const isLocked = currentMarket
    ? new Date(currentMarket.locksAt) <= new Date()
    : true;
  const { zones, checkpoints } = useMemo(
    () => buildMapObjects(routePoints[routePoints.length - 1] ?? initialRoom.routePoints?.[0] ?? null),
    [routePoints],
  );
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;
  const selectedCheckpoint = checkpoints.find((c) => c.id === selectedCheckpointId) ?? null;
  const selectedTargetLabel = selectedZone?.name ?? selectedCheckpoint?.name ?? null;

  useEffect(() => {
    // Keep map-sheet bet option in sync with the currently active market
    const first = currentMarket?.options?.[0]?.id ?? null;
    setSelectedMapOptionId(first);
  }, [currentMarket?.id, selectedZoneId, selectedCheckpointId]);

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <TopBar />
      <BottomNav />
      <LiveEventToasts
        roomId={room.roomId}
        role="viewer"
        onSettlement={handleSettlement}
      />
      <BetPlacedPill text={betPill} />

      {/* Skill feedback card — shown after each settled bet */}
      {skillFeedback && (
        <SkillFeedbackCard
          data={skillFeedback}
          onDismiss={() => setSkillFeedback(null)}
        />
      )}

      {/* Replay sheet — shown when user taps history button */}
      {showReplay && (
        <ReplaySheet
          roomId={room.roomId}
          onClose={() => setShowReplay(false)}
        />
      )}

      {/* ── Full-screen layer: video (default) or map (when mapExpanded) ── */}
      <div className="absolute inset-0 z-0">
        {mapExpanded ? (
          <LiveMap
            routePoints={routePoints}
            className="h-full w-full"
            interactive={true}
            audienceRole="viewer"
            transportMode={room.transportMode}
            rotateWithHeading={false}
            tileOpacity={1}
            mapCaption={currentMarket?.title}
            zones={zones}
            checkpoints={checkpoints}
            selectedZoneId={selectedZoneId}
            selectedCheckpointId={selectedCheckpointId}
            showZones={showZones}
            showCheckpoints={showCheckpoints}
            onZoneSelect={(id) => {
              setSelectedZoneId(id);
              if (id) setSelectedCheckpointId(null);
            }}
            onCheckpointSelect={(id) => {
              setSelectedCheckpointId(id);
              if (id) setSelectedZoneId(null);
            }}
          />
        ) : (
          <LiveVideoPlayer
            liveSessionId={room.liveSessionId}
            className="h-full w-full"
          />
        )}
      </div>

      {/* ── Top gradient scrim ───────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-36 bg-gradient-to-b from-black/75 to-transparent" />

      {/* ── Top bar — LIVE · name · mode · $amount stepper ── */}
      <div className="absolute inset-x-0 top-12 z-40 flex items-center gap-2 px-4 py-3 text-sm">
        <span className="rounded bg-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400 tracking-wide">
          LIVE
        </span>
        <span className="font-semibold text-white drop-shadow">
          {room.characterName}
        </span>
        <span className="text-white/55 drop-shadow text-xs">
          {transportEmoji(room.transportMode)} {room.transportMode.replace("_", " ")}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {/* History / replay button */}
          <button
            type="button"
            onClick={() => setShowReplay(true)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-white/12 text-xs text-white/60 backdrop-blur active:bg-white/25"
            title="Decision history"
          >
            📋
          </button>

          {/* Bet amount stepper */}
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

      {mapExpanded ? (
        <div className="absolute left-4 right-[40vw] top-28 z-40 flex items-center gap-2 overflow-x-auto pr-2">
          <button
            type="button"
            onClick={() => setShowZones((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] ${
              showZones ? "bg-cyan-500/30 text-cyan-100" : "bg-white/10 text-white/60"
            }`}
          >
            Zones
          </button>
          <button
            type="button"
            onClick={() => setShowCheckpoints((v) => !v)}
            className={`rounded-full px-2.5 py-1 text-[11px] ${
              showCheckpoints ? "bg-fuchsia-500/30 text-fuchsia-100" : "bg-white/10 text-white/60"
            }`}
          >
            Checkpoints
          </button>
          <button
            type="button"
            className="rounded-full bg-emerald-500/30 px-2.5 py-1 text-[11px] text-emerald-100"
          >
            Live bets
          </button>
        </div>
      ) : null}

      {/* ── PiP corner: swapped view + expand toggle ── */}
      <div
        className="absolute z-30 overflow-hidden rounded-2xl border border-white/25 shadow-2xl"
        style={{
          top: 108,
          right: 12,
          width: "56vw",
          height: "56vw",
          maxWidth: 260,
          maxHeight: 260,
          opacity: 0.9,
        }}
      >
        {mapExpanded ? (
          /* PiP shows the camera stream when map is fullscreen */
          <LiveVideoPlayer
            liveSessionId={room.liveSessionId}
            className="h-full w-full"
          />
        ) : (
          /* PiP shows the map when video is fullscreen */
          <>
            <LiveMap
              routePoints={routePoints}
              className="h-full w-full"
              interactive={false}
              audienceRole="viewer"
              transportMode={room.transportMode}
              rotateWithHeading={true}
              tileOpacity={0.65}
              mapCaption={currentMarket?.title}
              zones={zones}
              checkpoints={checkpoints}
              selectedZoneId={selectedZoneId}
              selectedCheckpointId={selectedCheckpointId}
              showZones={showZones}
              showCheckpoints={showCheckpoints}
            />
            {routePoints.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-[9px] text-white/70">
                Waiting for GPS…
              </div>
            )}
          </>
        )}

        {/* Swap / expand button */}
        <button
          type="button"
          onClick={() => setMapExpanded((v) => !v)}
          className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur active:bg-black/75"
          title={mapExpanded ? "Show camera fullscreen" : "Show map fullscreen"}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M3 7V3h4a1 1 0 110 2H5v2a1 1 0 11-2 0zm10-4h4v4a1 1 0 11-2 0V5h-2a1 1 0 110-2zM3 13a1 1 0 011 1v2h2a1 1 0 110 2H2v-4a1 1 0 011-1zm14 0a1 1 0 011 1v4h-4a1 1 0 110-2h2v-2a1 1 0 011-1z" />
          </svg>
        </button>
      </div>

      {/* ── Bottom gradient scrim ────────────────────────── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-black/70 to-transparent" />

      {mapExpanded && showLiveBets && selectedTargetLabel ? (
        <MapSelectionBottomSheet
          selectedLabel={selectedTargetLabel}
          marketTitle={currentMarket?.title ?? "Live market"}
          marketOptions={currentMarket?.options ?? []}
          selectedOptionId={selectedMapOptionId}
          onSelectOption={setSelectedMapOptionId}
          bettingClosed={false}
          countdown={currentMarket ? <MarketTimer locksAt={currentMarket.locksAt} /> : null}
          onClose={() => {
            setSelectedZoneId(null);
            setSelectedCheckpointId(null);
          }}
          onPlaceBet={async () => {
            if (!selectedMapOptionId) return;
            await placeBet(selectedMapOptionId);
          }}
        />
      ) : null}

      {/* ── Market title — floats above joystick, separate layer so it never moves the pad ── */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[61] flex flex-col items-center px-4 pb-[calc(4.25rem+env(safe-area-inset-bottom,0px)+158px)]">
        <div
          className="pointer-events-auto transition-all duration-300"
          style={{ opacity: currentMarket ? 1 : 0 }}
        >
          {currentMarket && (
            <div className="flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] text-white/90 backdrop-blur-sm shadow-lg">
              <span className="font-semibold leading-none drop-shadow">
                {currentMarket.title}
              </span>
              <MarketTimer locksAt={currentMarket.locksAt} />
            </div>
          )}
        </div>
      </div>

      {/* ── Joystick — always at exact same position ── */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center px-4 pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))]">
        <div className="pointer-events-auto flex flex-col items-center">
          <DirectionalBetPad
            options={currentMarket?.options ?? []}
            betAmount={betAmount}
            onBet={async (optionId) => {
              await placeBet(optionId);
            }}
            locked={isLocked || !currentMarket || !!placingOptionId}
            routePoints={routePoints}
          />
          {error && <div className="mt-1 text-[10px] text-red-400">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function MarketTimer({ locksAt }: { locksAt: string }) {
  const { secondsLeft, label } = useCountdown(locksAt);
  const locked = secondsLeft <= 0;
  return (
    <span
      className={`shrink-0 text-xs font-semibold ${
        locked
          ? "text-red-400"
          : secondsLeft < 10
            ? "text-amber-400"
            : "text-white/45"
      }`}
    >
      {locked ? "locked" : label}
    </span>
  );
}

function MapSelectionBottomSheet({
  selectedLabel,
  marketTitle,
  marketOptions,
  selectedOptionId,
  onSelectOption,
  bettingClosed,
  countdown,
  onClose,
  onPlaceBet,
}: {
  selectedLabel: string;
  marketTitle: string;
  marketOptions: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  bettingClosed: boolean;
  countdown: ReactNode;
  onClose: () => void;
  onPlaceBet: () => Promise<void>;
}) {
  const sorted = [...marketOptions].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <div className="absolute inset-x-0 bottom-0 z-[65] px-3 pb-[calc(5.2rem+env(safe-area-inset-bottom,0px))]">
      <div className="rounded-2xl border border-white/15 bg-black/75 p-3 text-white shadow-2xl backdrop-blur">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-xs font-semibold">{selectedLabel}</div>
          <div className="ml-auto text-[10px] text-white/60">{countdown}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70"
          >
            Close
          </button>
        </div>
        <div className="mb-2 text-[10px] text-white/65">{marketTitle}</div>
        <div className="space-y-1">
          {sorted.map((opt) => {
            const active = selectedOptionId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onSelectOption(opt.id)}
                className={`block w-full rounded-lg px-2 py-1.5 text-left text-[11px] ${
                  active
                    ? "border border-red-400/60 bg-red-500/20 text-white"
                    : "border border-transparent bg-white/5 text-white/85"
                }`}
              >
                {opt.shortLabel ?? opt.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={bettingClosed || !selectedOptionId}
          onClick={() => void onPlaceBet()}
          className="mt-3 w-full rounded-xl bg-red-500 px-3 py-2 text-xs font-semibold text-white disabled:bg-white/20 disabled:text-white/50"
        >
          {bettingClosed ? "Betting closed" : !selectedOptionId ? "Select option" : "Place bet"}
        </button>
      </div>
    </div>
  );
}
