"use server";

import { unstable_noStore } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";

export type RoutePoint = { lat: number; lng: number; heading?: number };

export type LiveFeedRow = {
  roomId: string;
  liveSessionId: string;
  characterId: string;
  characterName: string;
  characterSlug: string | null;
  characterTagline: string | null;
  transportMode: string;
  statusText: string | null;
  intentLabel: string | null;
  regionLabel: string | null;
  placeType: string | null;
  phase: string;
  viewerCount: number;
  participantCount: number;
  currentMarket: {
    id: string;
    title: string;
    marketType: string;
    locksAt: string;
    revealAt: string;
    options: Array<{ id: string; label: string; shortLabel?: string; displayOrder: number }>;
    participantCount: number;
  } | null;
  sessionStartedAt: string;
  lastHeartbeatAt: string | null;
  routePoints: RoutePoint[];
};

export async function getLiveFeed(): Promise<{ items: LiveFeedRow[] }> {
  unstable_noStore();
  const service = await createServiceClient();

  const { data } = await service
    .from("active_live_rooms")
    .select("*")
    .limit(50);

  const items: LiveFeedRow[] = (data ?? []).map((r) => ({
    roomId: r.room_id as string,
    liveSessionId: r.live_session_id as string,
    characterId: r.character_id as string,
    characterName: r.character_name as string,
    characterSlug: (r.character_slug as string | null) ?? null,
    characterTagline: (r.character_tagline as string | null) ?? null,
    transportMode: r.transport_mode as string,
    statusText: (r.current_status_text as string | null) ?? null,
    intentLabel: (r.current_intent_label as string | null) ?? null,
    regionLabel: (r.region_label as string | null) ?? null,
    placeType: (r.place_type as string | null) ?? null,
    phase: r.phase as string,
    viewerCount: (r.viewer_count as number) ?? 0,
    participantCount: (r.participant_count as number) ?? 0,
    currentMarket: r.current_market_id
      ? {
          id: r.current_market_id as string,
          title: (r.current_market_title as string) ?? "",
          marketType: (r.current_market_type as string) ?? "",
          locksAt: (r.current_market_locks_at as string) ?? "",
          revealAt: (r.current_market_reveal_at as string) ?? "",
          options: (r.current_market_options as LiveFeedRow["currentMarket"] extends null
            ? never
            : NonNullable<LiveFeedRow["currentMarket"]>["options"]) ?? [],
          participantCount: (r.current_market_participants as number) ?? 0,
        }
      : null,
    sessionStartedAt: r.session_started_at as string,
    lastHeartbeatAt: (r.last_heartbeat_at as string | null) ?? null,
    routePoints: [],
  }));

  return { items };
}

export async function getLiveRoomDetail(roomId: string): Promise<{
  room: LiveFeedRow | null;
}> {
  unstable_noStore();
  const service = await createServiceClient();

  const { data } = await service
    .from("active_live_rooms")
    .select("*")
    .eq("room_id", roomId)
    .maybeSingle();

  if (!data) return { room: null };

  const items = await getLiveFeed();
  const match = items.items.find((r) => r.roomId === roomId);
  if (!match) return { room: null };

  // Fetch the last 100 GPS points for the map.
  const sessionId = data.live_session_id as string;
  const { data: snapshots } = await service
    .from("live_route_snapshots")
    .select("normalized_lat,normalized_lng,raw_lat,raw_lng,heading_deg")
    .eq("live_session_id", sessionId)
    .order("recorded_at", { ascending: false })
    .limit(100);

  const routePoints: RoutePoint[] = ((snapshots ?? []) as Array<{
    normalized_lat: number | null;
    normalized_lng: number | null;
    raw_lat: number;
    raw_lng: number;
    heading_deg: number | null;
  }>)
    .map((s) => ({
      lat: s.normalized_lat ?? s.raw_lat,
      lng: s.normalized_lng ?? s.raw_lng,
      heading: s.heading_deg ?? undefined,
    }))
    .reverse(); // oldest→newest for path drawing

  return { room: { ...match, routePoints } };
}
