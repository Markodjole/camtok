"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useUserStore } from "@/stores/user-store";
import { useFeedStore } from "@/stores/feed-store";
import { formatCurrency } from "@/lib/utils";
import { Wallet, ChevronDown } from "lucide-react";

const STAKE_OPTIONS = [1, 2, 5, 10, 20, 50] as const;
const STAKE_STORAGE_KEY = "bettok_last_stake_amount";

function getStoredStakeAmount(): (typeof STAKE_OPTIONS)[number] {
  try {
    const stored = localStorage.getItem(STAKE_STORAGE_KEY);
    const n = stored ? parseInt(stored, 10) : NaN;
    return (STAKE_OPTIONS.includes(n as (typeof STAKE_OPTIONS)[number]) ? n : 10) as (typeof STAKE_OPTIONS)[number];
  } catch {
    return 10;
  }
}

export function TopBar() {
  const wallet = useUserStore((s) => s.wallet);
  const lastStakeAmount = useFeedStore((s) => s.lastStakeAmount);
  const setLastStakeAmount = useFeedStore((s) => s.setLastStakeAmount);
  const [showAmountPicker, setShowAmountPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = getStoredStakeAmount();
    setLastStakeAmount(stored);
  }, [setLastStakeAmount]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowAmountPicker(false);
      }
    }
    if (showAmountPicker) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [showAmountPicker]);

  return (
    <header className="fixed left-0 right-0 top-0 z-50 flex h-12 items-center justify-between bg-background/80 px-4 backdrop-blur-lg">
      <Link href="/feed" className="text-lg font-bold tracking-tight">
        <span className="text-primary">Bet</span>
        <span className="text-foreground">Tok</span>
      </Link>
      <div className="flex items-center gap-2">
        <div className="relative" ref={pickerRef}>
          <button
            type="button"
            onClick={() => setShowAmountPicker((v) => !v)}
            className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1.5 text-sm font-small transition-colors hover:bg-secondary/80"
          >
            <span>{formatCurrency(lastStakeAmount)}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </button>
          {showAmountPicker && (
            <div className="absolute right-0 top-full mt-1 flex flex-wrap gap-1 rounded-lg border border-border bg-popover p-2 shadow-lg min-w-[120px]">
              {STAKE_OPTIONS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => {
                    setLastStakeAmount(amount);
                    setShowAmountPicker(false);
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    amount === lastStakeAmount
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  }`}
                >
                  ${amount}
                </button>
              ))}
            </div>
          )}
        </div>
        <Link
          href="/wallet"
          className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary/80"
        >
          <Wallet className="h-3.5 w-3.5 text-primary" />
          <span>{wallet ? formatCurrency(wallet.balance) : "..."}</span>
        </Link>
      </div>
    </header>
  );
}
