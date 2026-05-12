"use client";

import { useEffect, useRef, useState } from "react";
import type { SkillFeedbackData } from "./SkillFeedbackCard";
import { viewerLiveLog, viewerLiveWarn } from "@/lib/live/viewerLiveConsole";

type TKind = "info" | "ok" | "bad";
type TItem = { id: string; text: string; kind: TKind };

function queueToast(
  set: React.Dispatch<React.SetStateAction<TItem[]>>,
  text: string,
  kind: TKind,
) {
  const id = `t-${Date.now()}-${Math.random()}`;
  set((p) => [...p, { id, text, kind }]);
  setTimeout(() => set((p) => p.filter((x) => x.id !== id)), 4000);
}

type EnrichedSettlement = {
  market_id: string;
  title: string;
  won: boolean;
  stake_amount: number;
  payout_amount: number;
  status: string;
  settled_at: string | null;
  my_option_id: string;
  winning_option_id: string | null;
  options: Array<{ id: string; label: string; shortLabel: string | null; crowd_pct: number | null }>;
};

export function LiveEventToasts({
  roomId,
  role,
  onSettlement,
  onRoomActivity,
}: {
  roomId: string;
  role: "viewer" | "streamer";
  onSettlement?: (data: SkillFeedbackData) => void;
  /** Called with every successful activity poll (markets where this user already has an open live bet). */
  onRoomActivity?: (summary: { myOpenBetMarketIds: string[] }) => void;
}) {
  const [toasts, setToasts] = useState<TItem[]>([]);
  const seenEvent = useRef<Set<string>>(new Set());
  const seenSettle = useRef<Set<string>>(new Set());
  const firstBoot = useRef(true);

  useEffect(() => {
    firstBoot.current = true;
    seenEvent.current.clear();
    seenSettle.current.clear();
  }, [roomId]);

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch(`/api/live/rooms/${roomId}/activity`, {
          cache: "no-store",
        });
        if (!res.ok) {
          viewerLiveWarn("activity_http", { status: res.status, roomId });
          return;
        }
        const j = (await res.json()) as {
          events: Array<{
            id: string;
            event_type: string;
            payload: { stakeAmount?: number; optionId?: string };
          }>;
          mySettlements: EnrichedSettlement[];
          myOpenBetMarketIds?: string[];
        };

        onRoomActivity?.({
          myOpenBetMarketIds: j.myOpenBetMarketIds ?? [],
        });

        viewerLiveLog("activity_poll", {
          roomId,
          role,
          eventCount: j.events?.length ?? 0,
          settlementRows: j.mySettlements?.length ?? 0,
          myOpenBetMarketIds: j.myOpenBetMarketIds ?? [],
        });

        if (firstBoot.current) {
          for (const e of j.events ?? []) seenEvent.current.add(e.id);
          for (const s of j.mySettlements ?? []) {
            if (s.settled_at) seenSettle.current.add(`${s.market_id}|${s.settled_at}`);
          }
          firstBoot.current = false;
          return;
        }

        for (const e of j.events ?? []) {
          if (seenEvent.current.has(e.id)) continue;
          viewerLiveLog("room_event_new", {
            id: e.id,
            event_type: e.event_type,
            payload: e.payload,
            role,
          });
          if (e.event_type === "bet_placed" && role === "streamer") {
            const stake = Number(e.payload.stakeAmount ?? 0);
            const oid = (e.payload.optionId ?? "") as string;
            queueToast(setToasts, `New bet  $${stake}  ·  ${oid.slice(0, 4)}…`, "info");
          }
          seenEvent.current.add(e.id);
        }

        if (role === "viewer" && onSettlement) {
          for (const s of j.mySettlements ?? []) {
            if (!s.settled_at) continue;
            const k = `${s.market_id}|${s.settled_at}`;
            if (seenSettle.current.has(k)) continue;
            seenSettle.current.add(k);
            viewerLiveLog("settlement_detected", {
              marketId: s.market_id,
              title: s.title,
              won: s.won,
              myOptionId: s.my_option_id,
              winningOptionId: s.winning_option_id,
              stakeAmount: s.stake_amount,
              payoutAmount: s.payout_amount,
            });
            onSettlement({
              marketId: s.market_id,
              title: s.title,
              options: s.options,
              myOptionId: s.my_option_id,
              winningOptionId: s.winning_option_id,
              won: s.won,
              stakeAmount: s.stake_amount,
              payoutAmount: s.payout_amount,
            });
          }
        }
      } catch (err) {
        viewerLiveWarn("activity_poll_error", String(err));
      }
    };
    void run();
    const id = setInterval(run, 3000);
    return () => clearInterval(id);
  }, [roomId, role, onSettlement, onRoomActivity]);

  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed left-0 right-0 z-[200] flex flex-col items-stretch gap-1.5 px-3"
      style={{ top: "3.4rem" }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`mx-auto max-w-sm rounded-2xl border px-3 py-1.5 text-center text-xs font-bold backdrop-blur-md ${
            t.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-500/25 text-emerald-100"
              : t.kind === "bad"
                ? "border-rose-500/35 bg-rose-500/20 text-rose-100"
                : "border-sky-500/30 bg-sky-500/20 text-sky-100"
          } [text-shadow:0_0_2px_#000]`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function BetPlacedPill({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      className="pointer-events-none fixed left-0 right-0 z-[201] flex justify-center"
      style={{ top: "3.1rem" }}
    >
      <div className="rounded-full border border-violet-400/45 bg-violet-600/30 px-4 py-1 text-sm font-bold text-violet-100 [text-shadow:0_0_2px_#000]">
        {text}
      </div>
    </div>
  );
}

export function useBetPill() {
  const [text, setText] = useState<string | null>(null);
  const flash = (stake: number, pickLabel?: string | null) => {
    const pick = pickLabel?.trim();
    setText(pick ? `${pick} · $${stake} placed` : `$${stake} placed`);
    setTimeout(() => setText(null), 2000);
  };
  return { betPill: text, flash };
}
