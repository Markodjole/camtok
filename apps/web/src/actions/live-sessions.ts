"use server";

import { unstable_noStore } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import {
  startSessionInputSchema,
  heartbeatInputSchema,
  Safety,
  type StartSessionInput,
  type HeartbeatInput,
} from "@bettok/live";

export async function startLiveSession(input: StartSessionInput) {
  unstable_noStore();

  const parsed = startSessionInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: character } = await supabase
    .from("characters")
    .select("id, owner_user_id, name")
    .eq("id", parsed.data.characterId)
    .maybeSingle();

  if (!character) return { error: "Character not found" };
  if ((character as { owner_user_id: string | null }).owner_user_id !== user.id) {
    return { error: "Not your character" };
  }

  const policy = Safety.policyFor(parsed.data.transportMode);
  if (policy.safetyLevel === "blocked") {
    return { error: "Transport mode not allowed" };
  }

  const service = await createServiceClient();

  const { data: existing } = await service
    .from("character_live_sessions")
    .select("id, status")
    .eq("character_id", parsed.data.characterId)
    .in("status", ["starting", "live", "paused"])
    .maybeSingle();

  if (existing) {
    return { error: "Character is already live" };
  }

  const { data: session, error: insertError } = await service
    .from("character_live_sessions")
    .insert({
      character_id: parsed.data.characterId,
      owner_user_id: user.id,
      status: "starting",
      transport_mode: parsed.data.transportMode,
      current_status_text: parsed.data.statusText ?? null,
      current_intent_label: parsed.data.intentLabel ?? null,
      safety_level: policy.safetyLevel,
      last_heartbeat_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (insertError || !session) {
    return { error: insertError?.message ?? "Failed to start session" };
  }

  const { data: room, error: roomError } = await service
    .from("live_rooms")
    .insert({
      live_session_id: session.id,
      character_id: parsed.data.characterId,
      phase: "waiting_for_next_market",
    })
    .select("*")
    .single();

  if (roomError || !room) {
    return { error: roomError?.message ?? "Failed to create room" };
  }

  await service
    .from("character_live_sessions")
    .update({
      status: "live",
      current_room_id: room.id,
    })
    .eq("id", session.id);

  await service.from("live_room_events").insert({
    room_id: room.id,
    event_type: "session_started",
    payload: { sessionId: session.id, characterId: parsed.data.characterId },
  });

  return { sessionId: session.id, roomId: room.id };
}

export async function heartbeatLiveSession(input: HeartbeatInput) {
  unstable_noStore();

  const parsed = heartbeatInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const service = await createServiceClient();
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, owner_user_id, status")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();

  if (!session || (session as { owner_user_id: string }).owner_user_id !== user.id) {
    return { error: "Session not found" };
  }

  const updatePayload: Record<string, unknown> = {
    last_heartbeat_at: new Date().toISOString(),
  };
  if (parsed.data.statusText !== undefined) {
    updatePayload.current_status_text = parsed.data.statusText;
  }
  if (parsed.data.intentLabel !== undefined) {
    updatePayload.current_intent_label = parsed.data.intentLabel;
  }

  const { error } = await service
    .from("character_live_sessions")
    .update(updatePayload)
    .eq("id", parsed.data.sessionId);

  if (error) return { error: error.message };
  return { ok: true };
}

export async function endLiveSession(sessionId: string) {
  unstable_noStore();

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const service = await createServiceClient();
  const { data: session } = await service
    .from("character_live_sessions")
    .select("id, owner_user_id, current_room_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session || (session as { owner_user_id: string }).owner_user_id !== user.id) {
    return { error: "Session not found" };
  }

  await service
    .from("character_live_sessions")
    .update({ status: "ended", session_ended_at: new Date().toISOString() })
    .eq("id", sessionId);

  const roomId = (session as { current_room_id: string | null }).current_room_id;
  if (roomId) {
    await service.from("live_rooms").update({ phase: "idle" }).eq("id", roomId);
    await service.from("live_room_events").insert({
      room_id: roomId,
      event_type: "session_ended",
      payload: { sessionId },
    });
  }
  return { ok: true };
}
