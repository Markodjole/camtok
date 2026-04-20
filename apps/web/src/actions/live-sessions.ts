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

/** No heartbeat for this long ⇒ treat as crashed tab / abandoned; allow new session. */
const STALE_SESSION_MS = 2 * 60 * 1000;

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;

async function ensureCamtokCharacterRows(
  service: ServiceClient,
  args: {
    characterId: string;
    sessionId: string;
    operatorUserId: string;
    transportMode: StartSessionInput["transportMode"];
  },
) {
  const inferredType =
    args.transportMode === "car"
      ? "car"
      : args.transportMode === "bike"
        ? "bike"
        : "pedestrian";

  await service
    .from("characters")
    .update({
      operator_user_id: args.operatorUserId,
      camtok_active: true,
      camtok_entity_type: inferredType,
    })
    .eq("id", args.characterId);

  await service.from("character_behavior_profiles").upsert(
    {
      character_id: args.characterId,
      history_window_size: 50,
      learned_model_version: "v1",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "character_id" },
  );

  await service.from("character_public_game_stats").upsert(
    { character_id: args.characterId, updated_at: new Date().toISOString() },
    { onConflict: "character_id" },
  );
  await service.from("character_safety_profiles").upsert(
    { character_id: args.characterId, updated_at: new Date().toISOString() },
    { onConflict: "character_id" },
  );
  await service.from("character_live_telemetry_state").upsert(
    {
      character_id: args.characterId,
      live_session_id: args.sessionId,
      stream_status: "live",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "character_id" },
  );
  await service.from("character_route_game_state").upsert(
    {
      character_id: args.characterId,
      live_session_id: args.sessionId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "character_id" },
  );
}

async function upsertSessionEndStats(
  service: ServiceClient,
  characterId: string,
  sessionStartedAt: string | null | undefined,
  endedAtIso: string,
) {
  const durationSec = sessionStartedAt
    ? Math.max(0, (new Date(endedAtIso).getTime() - new Date(sessionStartedAt).getTime()) / 1000)
    : null;
  const { data: stats } = await service
    .from("character_public_game_stats")
    .select("total_runs, completed_runs, avg_run_duration_seconds")
    .eq("character_id", characterId)
    .maybeSingle();
  const prevRuns = Number((stats as { total_runs?: number } | null)?.total_runs ?? 0);
  const prevCompleted = Number((stats as { completed_runs?: number } | null)?.completed_runs ?? 0);
  const prevAvg = Number((stats as { avg_run_duration_seconds?: number } | null)?.avg_run_duration_seconds ?? 0);
  const nextRuns = prevRuns + 1;
  const nextAvg =
    durationSec == null ? prevAvg || null : prevRuns <= 0 ? durationSec : (prevAvg * prevRuns + durationSec) / nextRuns;
  await service.from("character_public_game_stats").upsert(
    {
      character_id: characterId,
      total_runs: nextRuns,
      completed_runs: prevCompleted + 1,
      avg_run_duration_seconds: nextAvg,
      avg_completion_seconds: nextAvg,
      updated_at: endedAtIso,
    },
    { onConflict: "character_id" },
  );
}

async function forceEndLiveSession(
  service: ServiceClient,
  sessionId: string,
) {
  const { data: row } = await service
    .from("character_live_sessions")
    .select("current_room_id, character_id, session_started_at")
    .eq("id", sessionId)
    .maybeSingle();
  const endedAt = new Date().toISOString();
  await service
    .from("character_live_sessions")
    .update({ status: "ended", session_ended_at: endedAt })
    .eq("id", sessionId);
  const characterId = (row as { character_id?: string } | null)?.character_id ?? null;
  if (characterId) {
    await upsertSessionEndStats(
      service,
      characterId,
      (row as { session_started_at?: string | null } | null)?.session_started_at,
      endedAt,
    );
    await service
      .from("character_live_telemetry_state")
      .update({ live_session_id: null, stream_status: "ended", updated_at: endedAt })
      .eq("character_id", characterId);
  }
  const roomId = (row as { current_room_id: string | null } | null)?.current_room_id;
  if (roomId) {
    await service.from("live_rooms").update({ phase: "idle" }).eq("id", roomId);
    await service.from("live_room_events").insert({
      room_id: roomId,
      event_type: "session_ended",
      payload: { sessionId, reason: "replaced_or_stale" },
    });
  }
}

export async function startLiveSession(input: StartSessionInput) {
  unstable_noStore();

  const parsed = startSessionInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: character } = await supabase
    .from("characters")
    .select("id, creator_user_id, name")
    .eq("id", parsed.data.characterId)
    .maybeSingle();

  if (!character) return { error: "Character not found" };
  if ((character as { creator_user_id: string | null }).creator_user_id !== user.id) {
    return { error: "Not your character" };
  }

  const policy = Safety.policyFor(parsed.data.transportMode);
  if (policy.safetyLevel === "blocked") {
    return { error: "Transport mode not allowed" };
  }

  const service = await createServiceClient();

  const { data: existing } = await service
    .from("character_live_sessions")
    .select("id, status, owner_user_id, current_room_id, last_heartbeat_at")
    .eq("character_id", parsed.data.characterId)
    .in("status", ["starting", "live", "paused"])
    .maybeSingle();

  if (existing) {
    const ex = existing as {
      id: string;
      owner_user_id: string;
      current_room_id: string | null;
      last_heartbeat_at: string | null;
    };
    if (ex.owner_user_id !== user.id) {
      return { error: "Character is already live" };
    }

    const lastBeat = ex.last_heartbeat_at ? new Date(ex.last_heartbeat_at).getTime() : 0;
    const isStale = Date.now() - lastBeat > STALE_SESSION_MS;

    if (isStale || !ex.current_room_id) {
      await forceEndLiveSession(service, ex.id);
    } else {
      await service
        .from("character_live_sessions")
        .update({
          transport_mode: parsed.data.transportMode,
          current_status_text: parsed.data.statusText ?? null,
          current_intent_label: parsed.data.intentLabel ?? null,
          last_heartbeat_at: new Date().toISOString(),
          status: "live",
        })
        .eq("id", ex.id);
      await ensureCamtokCharacterRows(service, {
        characterId: parsed.data.characterId,
        sessionId: ex.id,
        operatorUserId: user.id,
        transportMode: parsed.data.transportMode,
      });

      return { sessionId: ex.id, roomId: ex.current_room_id };
    }
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
  await ensureCamtokCharacterRows(service, {
    characterId: parsed.data.characterId,
    sessionId: session.id as string,
    operatorUserId: user.id,
    transportMode: parsed.data.transportMode,
  });

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
    .select("id, owner_user_id, status, character_id")
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
  await service.from("character_live_telemetry_state").upsert(
    {
      character_id: (session as { character_id: string }).character_id,
      live_session_id: parsed.data.sessionId,
      stream_status: "live",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "character_id" },
  );
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
    .select("id, owner_user_id, current_room_id, character_id, session_started_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session || (session as { owner_user_id: string }).owner_user_id !== user.id) {
    return { error: "Session not found" };
  }

  const endedAt = new Date().toISOString();
  await service
    .from("character_live_sessions")
    .update({ status: "ended", session_ended_at: endedAt })
    .eq("id", sessionId);
  const characterId = (session as { character_id: string }).character_id;
  await upsertSessionEndStats(
    service,
    characterId,
    (session as { session_started_at?: string | null }).session_started_at,
    endedAt,
  );
  await service
    .from("character_live_telemetry_state")
    .update({ live_session_id: null, stream_status: "ended", updated_at: endedAt })
    .eq("character_id", characterId);

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
