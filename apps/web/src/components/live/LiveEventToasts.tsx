"use client";

import { useEffect, useRef, useState } from "react";

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

export function LiveEventToasts({ roomId, role }: { roomId: string; role: "viewer" | "streamer" }) {
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
        const res = await fetch(`/api/live/rooms/${roomId}/activity`, { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          events: Array<{
            id: string;
            event_type: string;
            payload: { stakeAmount?: number; optionId?: string };
          }>;
          mySettlements: Array<{
            market_id: string;
            won: boolean;
            stake_amount: number;
            payout_amount: number;
            settled_at: string | null;
          }>;
        };
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
          if (e.event_type === "bet_placed" && role === "streamer") {
            const stake = Number(e.payload.stakeAmount ?? 0);
            const oid = (e.payload.optionId ?? "") as string;
            queueToast(setToasts, `New bet  $${stake}  ·  ${oid.slice(0, 4)}…`, "info");
          }
          seenEvent.current.add(e.id);
        }
        if (role === "viewer") {
          for (const s of j.mySettlements ?? []) {
            if (!s.settled_at) continue;
            const k = `${s.market_id}|${s.settled_at}`;
            if (seenSettle.current.has(k)) continue;
            seenSettle.current.add(k);
            if (s.won) {
              const gain = Math.max(0, s.payout_amount - s.stake_amount);
              queueToast(
                setToasts,
                `Won! +$${gain}  (payout $${s.payout_amount})`,
                "ok",
              );
            } else {
              queueToast(setToasts, `Result:  −$${s.stake_amount}`, "bad");
            }
          }
        }
      } catch { /*  */ }
    };
    void run();
    const id = setInterval(run, 3000);
    return () => clearInterval(id);
  }, [roomId, role]);

  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed left-0 right-0 z-[200] flex flex-col items-stretch gap-1.5 px-3" style={{ top: "3.4rem" }}>
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
    <div className="pointer-events-none fixed left-0 right-0 z-[201] flex justify-center" style={{ top: "3.1rem" }}>
      <div className="rounded-full border border-amber-400/40 bg-amber-500/20 px-4 py-1 text-sm font-bold text-amber-100 [text-shadow:0_0_2px_#000]">
        {text}
      </div>
    </div>
  );
}

export function useBetPill() {
  const [text, setText] = useState<string | null>(null);
  const flash = (stake: number) => {
    setText(`$${stake}  bet  placed`);
    setTimeout(() => setText(null), 2000);
  };
  return { betPill: text, flash };
}
