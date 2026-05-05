"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";

const STAKE_OPTIONS = [1, 2, 5, 10, 20, 50] as const;

/** Compact stake control when the main app top bar is hidden (immersive live room). */
export function LiveViewerStakePicker() {
  const lastStakeAmount = useViewerChromeStore((s) => s.lastStakeAmount);
  const setLastStakeAmount = useViewerChromeStore((s) => s.setLastStakeAmount);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="pointer-events-auto fixed right-14 top-3 z-[62]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 rounded-full border border-white/15 bg-black/45 px-2 py-1 text-[10px] font-semibold text-white shadow-md backdrop-blur-md active:bg-black/60"
        title="Stake amount"
      >
        <span>{formatCurrency(lastStakeAmount)}</span>
        <ChevronDown className="h-3 w-3 opacity-75" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-1 flex max-w-[160px] flex-wrap gap-1 rounded-lg border border-white/20 bg-zinc-950/95 p-2 shadow-xl backdrop-blur-md">
          {STAKE_OPTIONS.map((amount) => (
            <button
              key={amount}
              type="button"
              onClick={() => {
                setLastStakeAmount(amount);
                setOpen(false);
              }}
              className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                amount === lastStakeAmount
                  ? "bg-violet-600 text-white"
                  : "bg-white/10 text-white/90 hover:bg-white/18"
              }`}
            >
              ${amount}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
