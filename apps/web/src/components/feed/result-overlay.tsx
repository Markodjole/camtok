"use client";

import { useState, useEffect, useRef } from "react";
import { formatCurrency } from "@/lib/utils";
import { ChevronDown, ChevronUp, CheckCircle2, XCircle } from "lucide-react";

interface UserBetRow {
  id: string;
  side_key: string;
  stake_amount: number;
  payout_amount: number | null;
  status: string;
}

interface ResultOverlayProps {
  winningOutcomeText: string;
  resolutionReasonText: string;
  userBets: UserBetRow[];
}

export function ResultOverlay({
  winningOutcomeText,
  resolutionReasonText,
  userBets,
}: ResultOverlayProps) {
  const [showReason, setShowReason] = useState(false);
  const [showPayout, setShowPayout] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const wonBets = userBets.filter((b) => b.status === "settled_win");
  const lostBets = userBets.filter((b) => b.status === "settled_loss");
  const totalPayout = wonBets.reduce((s, b) => s + Number(b.payout_amount ?? 0), 0);
  const totalStake = userBets.reduce((s, b) => s + Number(b.stake_amount), 0);
  const net = totalPayout - totalStake;
  const hasBets = userBets.length > 0;
  const userWon = net > 0;

  useEffect(() => {
    if (!userWon) return;
    const timer = setTimeout(() => {
      setShowPayout(true);
      // Play subtle cha-ching via Web Audio API
      try {
        const ctx = new AudioContext();
        const playTone = (freq: number, startTime: number, dur: number) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.12, startTime);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
          osc.start(startTime);
          osc.stop(startTime + dur);
        };
        const now = ctx.currentTime;
        playTone(1200, now, 0.12);
        playTone(1600, now + 0.08, 0.12);
        playTone(2000, now + 0.16, 0.18);
      } catch {
        // Audio context not available — fine
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [userWon]);

  // Auto-hide payout flash after 2s
  useEffect(() => {
    if (!showPayout) return;
    const t = setTimeout(() => setShowPayout(false), 2000);
    return () => clearTimeout(t);
  }, [showPayout]);

  return (
    <div className="absolute inset-x-0 bottom-0 top-[45%] z-20 flex flex-col justify-end">
      {/* Payout flash — floats above result card */}
      {showPayout && userWon && (
        <div className="absolute top-0 left-0 right-0 flex justify-center animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-2 rounded-full bg-emerald-500/90 backdrop-blur-sm px-5 py-2 shadow-lg shadow-emerald-500/30">
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-200 animate-pulse" />
            <span className="text-xl font-bold text-white tracking-tight">
              +{formatCurrency(net)}
            </span>
          </div>
        </div>
      )}

      {/* Result card */}
      <div className="rounded-t-2xl bg-black/85 backdrop-blur-md px-4 pt-5 pb-8">
        {/* Winning outcome */}
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-white/50">
              Winning Outcome
            </p>
            <p className="mt-0.5 text-[15px] font-semibold text-white leading-snug">
              {winningOutcomeText}
            </p>
          </div>
        </div>

        {/* User bet results */}
        {hasBets && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
            {userWon ? (
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-emerald-400">
                    You won {formatCurrency(net)}!
                  </p>
                  <p className="text-xs text-white/50">
                    Staked {formatCurrency(totalStake)} → Payout{" "}
                    {formatCurrency(totalPayout)}
                  </p>
                </div>
              </div>
            ) : hasBets ? (
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500/20">
                  <XCircle className="h-4 w-4 text-red-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-red-400">
                    {net === 0 ? "Break even" : `You lost ${formatCurrency(Math.abs(net))}`}
                  </p>
                  <p className="text-xs text-white/50">
                    Staked {formatCurrency(totalStake)}
                  </p>
                </div>
              </div>
            ) : null}

            {/* Individual bets breakdown */}
            {(wonBets.length > 0 || lostBets.length > 0) && (
              <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                {wonBets.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-emerald-400/80">
                      {b.side_key === "yes" ? "YES" : "NO"} ✓
                    </span>
                    <span className="text-emerald-400/80">
                      +{formatCurrency(Number(b.payout_amount ?? 0))}
                    </span>
                  </div>
                ))}
                {lostBets.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-red-400/70">
                      {b.side_key === "yes" ? "YES" : "NO"} ✗
                    </span>
                    <span className="text-red-400/70">
                      -{formatCurrency(Number(b.stake_amount))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Explain button */}
        <button
          type="button"
          onClick={() => setShowReason((v) => !v)}
          className="mt-3 flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left touch-manipulation"
        >
          <span className="text-xs font-medium text-white/70">
            Why this outcome?
          </span>
          {showReason ? (
            <ChevronUp className="h-4 w-4 text-white/50" />
          ) : (
            <ChevronDown className="h-4 w-4 text-white/50" />
          )}
        </button>
        {showReason && (
          <div className="mt-2 rounded-lg bg-white/5 px-3 py-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
            <p className="text-xs leading-relaxed text-white/70">
              {resolutionReasonText}
            </p>
          </div>
        )}
      </div>

      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
