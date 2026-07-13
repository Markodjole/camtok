"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  leadVehicleEventsInputSchema,
  type LeadVehicleEventsInput,
  type LeadVehicleTelemetryEventInput,
} from "@bettok/live";
import { openOvertake30sMarketForRoom } from "@/actions/live-overtake-market";

export async function ingestLeadVehicleEvents(input: LeadVehicleEventsInput) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  return ingestLeadVehicleEventsForUser(user.id, input);
}

export async function ingestLeadVehicleEventsForUser(
  userId: string,
  input: LeadVehicleEventsInput,
) {
  unstable_noStore();

  const parsed = leadVehicleEventsInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const service = await createServiceClient();
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, owner_user_id, status, character_id, current_room_id")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();

  if (!session) return { error: "Session not found" };
  if ((session as { owner_user_id: string }).owner_user_id !== userId) {
    return { error: "Not your session" };
  }
  if ((session as { status: string }).status !== "live") {
    return { error: "Session not live" };
  }

  const events: LeadVehicleTelemetryEventInput[] = parsed.data.events?.length
    ? parsed.data.events
    : parsed.data.event
      ? [parsed.data.event]
      : [];

  const roomId = (session as { current_room_id: string | null }).current_room_id;
  const characterId = (session as { character_id: string }).character_id;
  const rows = events.map((ev) => ({
    live_session_id: parsed.data.sessionId,
    room_id: roomId,
    owner_user_id: userId,
    event_type: ev.eventType,
    recorded_at: new Date(ev.timestampMs).toISOString(),
    client_timestamp_ms: ev.timestampMs,
    track_id: ev.payload.trackId ?? null,
    vehicle_type: ev.payload.vehicleType ?? null,
    confidence: ev.payload.confidence ?? null,
    same_direction_confidence: ev.payload.sameDirectionConfidence ?? null,
    relative_state: ev.payload.relativeState ?? null,
    visible_duration_ms: ev.payload.visibleDurationMs ?? null,
    lateral_position: ev.payload.lateralPosition ?? null,
    prediction_ready: ev.payload.predictionReady ?? null,
    prediction_confidence: ev.payload.predictionConfidence ?? null,
    normalized_bbox: ev.payload.normalizedBoundingBox ?? null,
    payload: ev.payload as unknown as Record<string, unknown>,
    model_name: ev.modelMetadata.modelName,
    model_version: ev.modelMetadata.modelVersion,
    inference_mode: ev.modelMetadata.inferenceMode,
  }));

  const { error: insertError } = await service.from("lead_vehicle_events").insert(rows);
  if (insertError) return { error: insertError.message };

  const latest = events[events.length - 1]!;
  await service.from("character_lead_vehicle_state").upsert(
    {
      live_session_id: parsed.data.sessionId,
      character_id: characterId,
      room_id: roomId,
      track_id: latest.payload.trackId ?? null,
      vehicle_type: latest.payload.vehicleType ?? null,
      confidence: latest.payload.confidence ?? null,
      same_direction_confidence: latest.payload.sameDirectionConfidence ?? null,
      relative_state: latest.payload.relativeState ?? null,
      visible_duration_ms: latest.payload.visibleDurationMs ?? null,
      lateral_position: latest.payload.lateralPosition ?? null,
      prediction_ready: latest.payload.predictionReady === true,
      prediction_confidence: latest.payload.predictionConfidence ?? null,
      prediction_reasons: latest.payload.predictionReasons ?? [],
      prediction_blockers: latest.payload.predictionBlockers ?? [],
      last_event_type: latest.eventType,
      last_event_at: new Date(latest.timestampMs).toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "live_session_id" },
  );

  let market: { marketId: string; betType: "overtake_30s" } | { error: string } | null =
    null;
  if (
    roomId &&
    latest.payload.predictionReady === true &&
    latest.payload.trackId &&
    (latest.eventType === "lead_vehicle_acquired" ||
      latest.eventType === "lead_vehicle_updated" ||
      latest.eventType === "lead_vehicle_state_changed")
  ) {
    market = await openOvertake30sMarketForRoom(roomId, {
      trackId: latest.payload.trackId,
      vehicleType: latest.payload.vehicleType ?? "unknown_vehicle",
      confidence: latest.payload.confidence ?? 0,
      sameDirectionConfidence: latest.payload.sameDirectionConfidence ?? 0,
      relativeState: latest.payload.relativeState ?? "uncertain",
    });
  }

  return {
    ok: true as const,
    inserted: rows.length,
    market:
      market && !("error" in market)
        ? { marketId: market.marketId, betType: market.betType }
        : null,
    marketError: market && "error" in market ? market.error : null,
  };
}
