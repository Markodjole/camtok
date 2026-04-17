"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  locationBatchInputSchema,
  type LocationBatchInput,
  RouteState,
  type TransportMode,
} from "@bettok/live";

export async function ingestLocationBatch(input: LocationBatchInput) {
  unstable_noStore();

  const parsed = locationBatchInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const service = await createServiceClient();
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, owner_user_id, transport_mode, current_room_id, status")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();

  if (!session) return { error: "Session not found" };
  if ((session as { owner_user_id: string }).owner_user_id !== user.id) {
    return { error: "Not your session" };
  }
  if ((session as { status: string }).status !== "live") {
    return { error: "Session not live" };
  }

  const transportMode = parsed.data.transportMode as TransportMode;

  const { data: priorRow } = await service
    .from("live_route_snapshots")
    .select("recorded_at, normalized_lat, normalized_lng, speed_mps, heading_deg")
    .eq("live_session_id", parsed.data.sessionId)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const prior = priorRow
    ? {
        recordedAt: priorRow.recorded_at as string,
        lat: priorRow.normalized_lat as number,
        lng: priorRow.normalized_lng as number,
        speedMps: priorRow.speed_mps as number | undefined,
        headingDeg: priorRow.heading_deg as number | undefined,
        normalizedLat: priorRow.normalized_lat as number,
        normalizedLng: priorRow.normalized_lng as number,
        confidence: 1,
        discarded: false,
      }
    : null;

  const normalized = RouteState.normalizeGpsBatch(
    prior,
    transportMode,
    parsed.data.points,
  );

  const rows = normalized.map((p) => ({
    live_session_id: parsed.data.sessionId,
    recorded_at: p.recordedAt,
    raw_lat: p.lat,
    raw_lng: p.lng,
    normalized_lat: p.normalizedLat,
    normalized_lng: p.normalizedLng,
    speed_mps: p.speedMps ?? null,
    heading_deg: p.headingDeg ?? null,
    accuracy_meters: p.accuracyMeters ?? null,
    altitude_meters: p.altitudeMeters ?? null,
    transport_mode: transportMode,
    confidence_score: p.confidence,
  }));

  const { error: insertError } = await service
    .from("live_route_snapshots")
    .insert(rows);
  if (insertError) return { error: insertError.message };

  await service
    .from("character_live_sessions")
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq("id", parsed.data.sessionId);

  return { accepted: normalized.filter((p) => !p.discarded).length, total: normalized.length };
}
