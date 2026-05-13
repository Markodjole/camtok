/**
 * Server-side tick worker — the single source of live-room state mutation.
 *
 * Triggered by Vercel Cron every minute.  Internally loops for ~55 seconds
 * at ~1 Hz, ticking every active room on each iteration.  A CAS lock
 * (live_rooms.tick_locked_until) ensures only one tick runs per room at a
 * time across all concurrent function instances.
 *
 * By moving ticks here the client only needs to poll /state (read-only).
 * No viewer will ever race another viewer to mutate room state.
 */
import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  acquireTickLock,
  releaseTickLock,
  runRoomTick,
} from "@/lib/live/tick/runRoomTick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Allow up to 5 minutes — Vercel Pro cron functions support up to 300 s. */
export const maxDuration = 300;

// ─── Timing constants ─────────────────────────────────────────────────────────

/** How long the cron loop runs before returning so it finishes before the
 *  next minute boundary and leaves a buffer for cold-start overhead. */
const LOOP_DURATION_MS = 55_000;

/** Minimum time between iterations per room.  ~1 Hz tick rate. */
const TICK_INTERVAL_MS = 1_000;

/** Refresh the active-room list every N iterations to pick up new/ended rooms. */
const ROOM_REFRESH_EVERY = 10;

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Verify Vercel cron authorization.
  // In production Vercel sets Authorization: Bearer <CRON_SECRET> automatically.
  // In local dev CRON_SECRET is typically unset — skip auth so pnpm dev works.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const service = await createServiceClient();

  let roomIds = await fetchActiveRoomIds(service);
  console.info(`[cron/live-tick] starting — ${roomIds.length} active room(s)`);

  const startMs = Date.now();
  let iterations = 0;

  while (Date.now() - startMs < LOOP_DURATION_MS) {
    const iterStart = Date.now();

    // Refresh room list periodically.
    if (iterations > 0 && iterations % ROOM_REFRESH_EVERY === 0) {
      roomIds = await fetchActiveRoomIds(service);
    }

    // Tick every room in parallel; errors in one room must not abort others.
    await Promise.allSettled(
      roomIds.map((id) => tickOneRoom(id, service)),
    );

    iterations++;

    const elapsed = Date.now() - iterStart;
    const sleepMs = Math.max(0, TICK_INTERVAL_MS - elapsed);
    if (sleepMs > 0) await sleep(sleepMs);
  }

  console.info(
    `[cron/live-tick] done — ${iterations} iterations, ${roomIds.length} room(s)`,
  );
  return NextResponse.json({ action: "done", iterations, rooms: roomIds.length });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchActiveRoomIds(
  service: Awaited<ReturnType<typeof createServiceClient>>,
): Promise<string[]> {
  // Join live_rooms → character_live_sessions so we only tick rooms whose
  // session is still active (started/live/paused, not ended).
  const { data, error } = await service
    .from("live_rooms")
    .select("id, character_live_sessions!inner(status)")
    .in("character_live_sessions.status", ["starting", "live", "paused"]);

  if (error) {
    console.error("[cron/live-tick] fetchActiveRoomIds error", error);
    return [];
  }

  return (data ?? []).map((r) => (r as { id: string }).id);
}

async function tickOneRoom(
  roomId: string,
  service: Awaited<ReturnType<typeof createServiceClient>>,
): Promise<void> {
  const locked = await acquireTickLock(service, roomId);
  if (!locked) return; // another instance is already processing this room

  try {
    await runRoomTick(roomId, service);
  } catch (err) {
    console.error(`[cron/live-tick] unhandled error for room ${roomId}`, err);
  } finally {
    await releaseTickLock(service, roomId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
