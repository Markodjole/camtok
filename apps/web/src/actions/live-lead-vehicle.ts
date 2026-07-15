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
  const isLost = latest.eventType === "lead_vehicle_lost";
  const payloadDetections = latest.payload.detections;
  const overlayDetections = isLost
    ? Array.isArray(payloadDetections)
      ? payloadDetections
      : []
    : (payloadDetections ??
      (latest.payload.normalizedBoundingBox
        ? [
            {
              trackId: latest.payload.trackId,
              vehicleType: latest.payload.vehicleType,
              confidence: latest.payload.confidence,
              isLead: true,
              normalizedBoundingBox: latest.payload.normalizedBoundingBox,
            },
          ]
        : []));

  const statePatch: Record<string, unknown> = {
    live_session_id: parsed.data.sessionId,
    character_id: characterId,
    room_id: roomId,
    overlay_detections: overlayDetections,
    last_event_type: latest.eventType,
    last_event_at: new Date(latest.timestampMs).toISOString(),
    updated_at: new Date().toISOString(),
    prediction_reasons: latest.payload.predictionReasons ?? [],
    prediction_blockers: latest.payload.predictionBlockers ?? [],
  };

  if (typeof latest.payload.vehiclesOnScreen === "number") {
    statePatch.vehicles_on_screen = latest.payload.vehiclesOnScreen;
  }
  if (typeof latest.payload.vehiclesPassed === "number") {
    statePatch.vehicles_passed = latest.payload.vehiclesPassed;
  }
  if (latest.payload.lastPass) {
    statePatch.last_pass = latest.payload.lastPass;
  }

  if (isLost) {
    Object.assign(statePatch, {
      track_id: null,
      vehicle_type: null,
      confidence: null,
      same_direction_confidence: null,
      relative_state: null,
      visible_duration_ms: null,
      lateral_position: null,
      prediction_ready: false,
      prediction_confidence: null,
      normalized_bbox: null,
    });
  } else if (latest.payload.trackId) {
    Object.assign(statePatch, {
      track_id: latest.payload.trackId,
      vehicle_type: latest.payload.vehicleType ?? null,
      confidence: latest.payload.confidence ?? null,
      same_direction_confidence: latest.payload.sameDirectionConfidence ?? null,
      relative_state: latest.payload.relativeState ?? null,
      visible_duration_ms: latest.payload.visibleDurationMs ?? null,
      lateral_position: latest.payload.lateralPosition ?? null,
      prediction_ready: latest.payload.predictionReady === true,
      prediction_confidence: latest.payload.predictionConfidence ?? null,
      normalized_bbox: latest.payload.normalizedBoundingBox ?? null,
    });
  } else {
    // Overlay-only frame (searching): update boxes, do not clear lead fields.
    statePatch.prediction_ready = latest.payload.predictionReady === true;
    if (latest.payload.predictionConfidence != null) {
      statePatch.prediction_confidence = latest.payload.predictionConfidence;
    }
    if (overlayDetections.length === 0) {
      statePatch.normalized_bbox = null;
    }
  }

  await service.from("character_lead_vehicle_state").upsert(statePatch, {
    onConflict: "live_session_id",
  });

  // Open overtake market whenever a lead track is present and no other
  // market is active (room phase waiting_for_next_market).
  let market: { marketId: string; betType: "overtake_30s" } | { error: string } | null =
    null;
  if (
    roomId &&
    !isLost &&
    latest.payload.trackId &&
    (latest.eventType === "lead_vehicle_acquired" ||
      latest.eventType === "lead_vehicle_updated" ||
      latest.eventType === "lead_vehicle_state_changed" ||
      latest.eventType === "lead_vehicle_changed")
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

export type LeadVehicleOverlayState = {
  trackId: string | null;
  vehicleType: string | null;
  confidence: number | null;
  relativeState: string | null;
  predictionReady: boolean;
  normalizedBoundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  detections: Array<{
    trackId?: string;
    vehicleType?: string;
    confidence?: number;
    isLead?: boolean;
    normalizedBoundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  vehiclesOnScreen: number;
  vehiclesPassed: number;
  lastPass: {
    trackId: string;
    vehicleType?: string;
    timestampMs: number;
    delta?: 1 | -1;
  } | null;
  updatedAt: string | null;
};

export async function getLeadVehicleOverlayState(
  sessionId: string,
): Promise<LeadVehicleOverlayState | null> {
  unstable_noStore();
  const service = await createServiceClient();
  const { data } = await service
    .from("character_lead_vehicle_state")
    .select(
      "track_id, vehicle_type, confidence, relative_state, prediction_ready, normalized_bbox, overlay_detections, vehicles_on_screen, vehicles_passed, last_pass, updated_at",
    )
    .eq("live_session_id", sessionId)
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    track_id: string | null;
    vehicle_type: string | null;
    confidence: number | null;
    relative_state: string | null;
    prediction_ready: boolean;
    normalized_bbox: LeadVehicleOverlayState["normalizedBoundingBox"];
    overlay_detections: LeadVehicleOverlayState["detections"] | null;
    vehicles_on_screen: number | null;
    vehicles_passed: number | null;
    last_pass: LeadVehicleOverlayState["lastPass"];
    updated_at: string | null;
  };
  return {
    trackId: row.track_id,
    vehicleType: row.vehicle_type,
    confidence: row.confidence,
    relativeState: row.relative_state,
    predictionReady: row.prediction_ready === true,
    normalizedBoundingBox: row.normalized_bbox,
    detections: Array.isArray(row.overlay_detections)
      ? row.overlay_detections
      : [],
    vehiclesOnScreen: row.vehicles_on_screen ?? 0,
    vehiclesPassed: row.vehicles_passed ?? 0,
    lastPass:
      row.last_pass &&
      typeof row.last_pass === "object" &&
      typeof (row.last_pass as { trackId?: unknown }).trackId === "string"
        ? (row.last_pass as LeadVehicleOverlayState["lastPass"])
        : null,
    updatedAt: row.updated_at,
  };
}
