"use server";

import { leadVehicleInferInputSchema, type LeadVehicleInferInput } from "@bettok/live";
import { createServiceClient } from "@/lib/supabase/server";
import { detectVehiclesFromJpeg } from "@/lib/live/vehicle-infer/detectVehicles";
import { getServerRoundCounter } from "@/lib/live/vehicle-infer/serverRoundCounter";

export type LeadVehicleInferResult = {
  detections: Array<{
    vehicleType: "vehicle";
    confidence: number;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
  inferenceDurationMs: number;
  roundCount?: number;
};

export async function inferLeadVehicleForUser(
  userId: string,
  input: LeadVehicleInferInput,
): Promise<LeadVehicleInferResult | { error: string }> {
  const parsed = leadVehicleInferInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid_input" };
  }
  const data = parsed.data;

  const service = await createServiceClient();
  const { data: session, error: sessionError } = await service
    .from("character_live_sessions")
    .select("id, character_id, status")
    .eq("id", data.sessionId)
    .maybeSingle();

  if (sessionError || !session) {
    return { error: "session_not_found" };
  }
  if (session.status !== "live") {
    return { error: "session_not_live" };
  }

  const { data: character, error: charError } = await service
    .from("characters")
    .select("user_id")
    .eq("id", session.character_id)
    .maybeSingle();

  if (charError || !character || character.user_id !== userId) {
    return { error: "forbidden" };
  }

  if (!data.imageBase64) {
    return { error: "image_required" };
  }

  const t0 = Date.now();
  const detections = await detectVehiclesFromJpeg(data.imageBase64);
  const inferenceDurationMs = Date.now() - t0;

  let roundCount: number | undefined;
  if (data.roundId) {
    const counter = getServerRoundCounter(data.sessionId, data.roundId);
    roundCount = counter.observe(detections);
  }

  return {
    detections,
    inferenceDurationMs,
    roundCount,
  };
}
