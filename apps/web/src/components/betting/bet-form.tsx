"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { placeBet } from "@/actions/bets";
import { useUserStore } from "@/stores/user-store";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";
import { useToast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Loader2, TrendingUp } from "lucide-react";

interface BetFormProps {
  marketId: string;
  side: "yes" | "no";
  odds: number;
  canonicalText: string;
  onBetPlaced: () => void;
}

const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50];

export function BetForm({
  marketId,
  side,
  odds,
  canonicalText,
  onBetPlaced,
}: BetFormProps) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const wallet = useUserStore((s) => s.wallet);
  const setWallet = useUserStore((s) => s.setWallet);
  const setLastStakeAmount = useViewerChromeStore((s) => s.setLastStakeAmount);
  const { toast } = useToast();

  const numAmount = parseFloat(amount) || 0;
  const potentialWin = numAmount * odds;
  const balance = wallet?.balance || 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (numAmount <= 0) return;
    setLoading(true);

    const payload = {
      prediction_market_id: marketId,
      side_key: side,
      stake_amount: numAmount,
    };
    let result: Awaited<ReturnType<typeof placeBet>>;
    try {
      result = await placeBet(payload);
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message?.includes("Lock broken"));
      if (isAbort) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          result = await placeBet(payload);
        } catch {
          toast({
            title: "Bet failed",
            description: "Connection conflict. Try again.",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }
      } else {
        toast({
          title: "Bet failed",
          description: err instanceof Error ? err.message : "Something went wrong",
          variant: "destructive",
        });
        setLoading(false);
        return;
      }
    }

    if (result!.error) {
      toast({
        title: "Bet failed",
        description: result!.error,
        variant: "destructive",
      });
    } else {
      setLastStakeAmount(numAmount);
      toast({
        title: "Bet placed!",
        description: `${formatCurrency(numAmount)} on ${side.toUpperCase()} at ${odds.toFixed(2)}x`,
        variant: "success",
      });
      if (wallet) {
        setWallet({ ...wallet, balance: balance - numAmount });
      }
      useViewerChromeStore.getState().bumpMyBetsRevision();
      setAmount("");
      onBetPlaced();
    }

    setLoading(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Betting on</p>
          <p className="text-sm font-medium">
            {canonicalText} —{" "}
            <span
              className={cn(
                "font-bold uppercase",
                side === "yes" ? "text-success" : "text-destructive"
              )}
            >
              {side}
            </span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Odds</p>
          <p className="text-lg font-bold text-primary">{odds.toFixed(2)}x</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Quick amount buttons */}
        <div className="flex gap-2">
          {QUICK_AMOUNTS.map((qa) => (
            <button
              key={qa}
              type="button"
              onClick={() => setAmount(qa.toString())}
              className={cn(
                "flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
                amount === qa.toString()
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:border-primary/50"
              )}
            >
              ${qa}
            </button>
          ))}
        </div>

        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="pl-7"
            min={1}
            max={50}
            step="0.01"
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Balance: {formatCurrency(balance)}</span>
          {numAmount > 0 && (
            <span className="text-success">
              Potential win: {formatCurrency(potentialWin)}
            </span>
          )}
        </div>

        <Button
          type="submit"
          className="w-full gap-2"
          disabled={loading || numAmount <= 0 || numAmount > 50 || numAmount > balance}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <TrendingUp className="h-4 w-4" />
              Place Bet — {formatCurrency(numAmount)}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
