"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Lock, CircleDot, BarChart3, Bell, BellOff, CheckCheck, Sparkles, Film, Trophy, ShieldAlert, Zap } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getUserBets } from "@/actions/bets";
import { getNotifications, getUnreadCount, markAllAsRead, markAsRead } from "@/actions/notifications";
import { cn, formatCurrency, formatRelativeTime } from "@/lib/utils";
import { useViewerChromeStore } from "@/stores/viewer-chrome-store";

type BetRow = {
  id: string;
  side_key: string;
  stake_amount: number;
  odds_at_bet: number;
  status: string;
  payout_amount: number | null;
  created_at: string;
  prediction_markets: { canonical_text: string; market_key: string } | null;
  clip_nodes: { video_storage_path: string | null; poster_storage_path: string | null } | null;
};

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  created_at: string;
};

const statusConfig: Record<string, { label: string; variant: "default" | "success" | "destructive" | "warning" }> = {
  active: { label: "Active", variant: "default" },
  locked: { label: "Locked", variant: "warning" },
  settled_win: { label: "Won", variant: "success" },
  settled_loss: { label: "Lost", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "destructive" },
  refunded: { label: "Refunded", variant: "warning" },
  pending_hold: { label: "Pending", variant: "warning" },
};

function getStatusMeta(status: string) {
  return statusConfig[status] ?? { label: status, variant: "default" as const };
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <CircleDot className="h-4 w-4 text-primary" />;
    case "locked":
      return <Lock className="h-4 w-4 text-warning" />;
    case "settled_win":
      return <TrendingUp className="h-4 w-4 text-success" />;
    case "settled_loss":
      return <TrendingDown className="h-4 w-4 text-destructive" />;
    default:
      return <CircleDot className="h-4 w-4 text-muted-foreground" />;
  }
}

function BetCard({ bet }: { bet: BetRow }) {
  const meta = getStatusMeta(bet.status);
  const potentialPayout = bet.stake_amount * bet.odds_at_bet;
  const isSettled = bet.status === "settled_win" || bet.status === "settled_loss";
  const pnl = isSettled
    ? bet.status === "settled_win"
      ? (bet.payout_amount ?? potentialPayout) - bet.stake_amount
      : -bet.stake_amount
    : null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-snug line-clamp-2">
            {bet.prediction_markets?.canonical_text ?? "Unknown prediction"}
          </p>
          <Badge variant={meta.variant} className="shrink-0">
            {meta.label}
          </Badge>
        </div>


        <div className="flex items-center gap-2">
          <Badge variant={bet.side_key === "yes" ? "success" : "destructive"} className="text-[10px]">
            {bet.side_key.toUpperCase()}
          </Badge>
          <span className="text-xs text-muted-foreground">
            @ {bet.odds_at_bet.toFixed(2)}x
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
          <div className="text-center">
            <p className="text-[10px] uppercase text-muted-foreground">Stake</p>
            <p className="text-sm font-semibold">{formatCurrency(bet.stake_amount)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] uppercase text-muted-foreground">
              {isSettled ? "Payout" : "Potential"}
            </p>
            <p className="text-sm font-semibold">
              {isSettled && bet.status === "settled_win"
                ? formatCurrency(bet.payout_amount ?? potentialPayout)
                : isSettled
                  ? formatCurrency(0)
                  : formatCurrency(potentialPayout)}
            </p>
          </div>
          {pnl !== null && (
            <div className="text-center">
              <p className="text-[10px] uppercase text-muted-foreground">P&L</p>
              <p
                className={cn(
                  "text-sm font-bold",
                  pnl >= 0 ? "text-success" : "text-destructive"
                )}
              >
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <StatusIcon status={bet.status} />
            <span className="text-xs">{meta.label}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(bet.created_at)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function BetSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex justify-between">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-5 w-12 rounded-full" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="flex justify-between">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
      <BarChart3 className="h-8 w-8" />
      <p className="text-sm">No {label} bets</p>
    </div>
  );
}

const typeIcons: Record<string, React.ElementType> = {
  bet_locked: Lock,
  prediction_accepted: Sparkles,
  continuation_live: Film,
  video_review_ready: Film,
  bet_settled: CircleDot,
  bet_won: Trophy,
  bet_lost: TrendingDown,
  partially_correct: Zap,
  clip_first_bets: Bell,
  moderation_action: ShieldAlert,
};

function NotificationIcon({ type }: { type: string }) {
  const Icon = typeIcons[type] ?? Bell;
  return <Icon className="h-4 w-4" />;
}

export default function BetsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const myBetsRevision = useViewerChromeStore((s) => s.myBetsRevision);
  const [bets, setBets] = useState<BetRow[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingNotifs, setLoadingNotifs] = useState(true);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (pathname !== "/bets") return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadingNotifs(true);
      const [data, notifData, count] = await Promise.all([
        getUserBets(),
        getNotifications(),
        getUnreadCount(),
      ]);
      if (cancelled) return;
      setBets(data as BetRow[]);
      setNotifications(notifData as NotificationRow[]);
      setUnreadCount(count);
      setLoading(false);
      setLoadingNotifs(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [pathname, myBetsRevision]);

  const activeBets = bets.filter((b) =>
    ["active", "locked", "pending_hold"].includes(b.status)
  );
  // Keep Active tab useful: if there are no strictly-active rows yet,
  // still show the user's bets instead of an empty state.
  const activeTabBets = activeBets.length > 0 ? activeBets : bets;
  const settledBets = bets.filter((b) =>
    ["settled_win", "settled_loss", "cancelled", "refunded"].includes(b.status)
  );

  function handleMarkAsRead(id: string) {
    startTransition(async () => {
      await markAsRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
    });
  }

  function handleMarkAllAsRead() {
    startTransition(async () => {
      await markAllAsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    });
  }

  function renderBetList(list: BetRow[], emptyLabel: string) {
    if (loading) {
      return (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <BetSkeleton key={i} />
          ))}
        </div>
      );
    }
    if (list.length === 0) return <EmptyState label={emptyLabel} />;
    return (
      <div className="space-y-3">
        {list.map((bet) => (
          <BetCard key={bet.id} bet={bet} />
        ))}
      </div>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="p-4">
          <Tabs defaultValue="active">
            <TabsList className="w-full">
              <TabsTrigger value="active" className="flex-1">
                Active
                {!loading && activeTabBets.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
                    {activeTabBets.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="settled" className="flex-1">
                Settled
              </TabsTrigger>
              <TabsTrigger value="all" className="flex-1">
                All
              </TabsTrigger>
              <TabsTrigger value="alerts" className="flex-1">
                Alerts
                {!loadingNotifs && unreadCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
                    {unreadCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="active">
              {renderBetList(activeTabBets, "active")}
            </TabsContent>

            <TabsContent value="settled">
              {renderBetList(settledBets, "settled")}
            </TabsContent>

            <TabsContent value="all">
              {renderBetList(bets, "")}
            </TabsContent>

            <TabsContent value="alerts">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Alerts moved here from bottom nav</p>
                  {unreadCount > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={handleMarkAllAsRead}
                      disabled={isPending}
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                      Mark all read
                    </Button>
                  )}
                </div>
                {loadingNotifs ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Card key={i}>
                        <CardContent className="p-4">
                          <Skeleton className="h-12 w-full" />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : notifications.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                    <BellOff className="h-8 w-8" />
                    <p className="text-sm">No alerts yet</p>
                  </div>
                ) : (
                  notifications.map((notif) => (
                    <Card
                      key={notif.id}
                      className={cn("cursor-pointer transition-colors", !notif.read && "border-primary/30 bg-primary/5")}
                      onClick={() => {
                        if (!notif.read) handleMarkAsRead(notif.id);
                        if (notif.link) router.push(notif.link);
                      }}
                    >
                      <CardContent className="flex gap-3 p-4">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                            notif.read ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                          )}
                        >
                          <NotificationIcon type={notif.type} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm leading-snug", !notif.read && "font-semibold")}>{notif.title}</p>
                            {!notif.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{notif.body}</p>
                          <p className="mt-1 text-[10px] text-muted-foreground">{formatRelativeTime(notif.created_at)}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </AppShell>
  );
}
