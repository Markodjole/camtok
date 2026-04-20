"use server";

import { revalidatePath } from "next/cache";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";

export async function getClipById(id: string) {
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from("clip_nodes")
    .select(
      `
      *,
      stories!inner(title, genre, tone, realism_level),
      profiles!clip_nodes_creator_user_id_fkey(username, display_name, avatar_path)
    `
    )
    .eq("id", id)
    .single();

  if (error) return null;
  return data;
}

export async function getClipMarkets(clipNodeId: string) {
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from("prediction_markets")
    .select(
      `
      *,
      market_sides(*)
    `
    )
    .eq("clip_node_id", clipNodeId)
    .in("status", ["open", "normalized", "locked", "settled"])
    .order("created_at", { ascending: false });

  if (error) return [];
  return data || [];
}

export async function incrementViewCount(clipId: string) {
  const supabase = await createServiceClient();
  try {
    await supabase.rpc("increment_view_count", { clip_id: clipId });
  } catch {
    // view count is non-critical
  }
}

export async function uploadClip(formData: FormData) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const file = formData.get("video") as File;
  const title = formData.get("title") as string;
  const genre = (formData.get("genre") as string) || null;
  const tone = (formData.get("tone") as string) || null;

  if (!file || !title) return { error: "Missing required fields" };

  const ext = file.name.split(".").pop();
  const path = `clips/${user.id}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("media")
    .upload(path, file);

  if (uploadError) return { error: "Upload failed: " + uploadError.message };

  const { data: story, error: storyError } = await serviceClient
    .from("stories")
    .insert({
      title,
      genre,
      tone,
      creator_user_id: user.id,
    })
    .select()
    .single();

  if (storyError) {
    // Surface the underlying DB error to help diagnose hosted Supabase issues (e.g. missing migrations/RLS).
    console.error("createClipFromUpload storyError", storyError);
    return {
      error:
        "Failed to create story: " +
        (storyError.message || "database error (check Supabase migrations and policies)"),
    };
  }

  const { data: clipNode, error: clipError } = await serviceClient
    .from("clip_nodes")
    .insert({
      story_id: story.id,
      creator_user_id: user.id,
      source_type: "upload",
      status: "betting_open",
      video_storage_path: path,
      genre,
      tone,
      published_at: new Date().toISOString(),
      betting_deadline: new Date(
        Date.now() + 72 * 60 * 60 * 1000
      ).toISOString(),
    })
    .select()
    .single();

  if (clipError) {
    console.error("createClipFromUpload clipError", clipError);
    return {
      error:
        "Failed to create clip: " +
        (clipError.message || "database error (check Supabase migrations and policies)"),
    };
  }

  await serviceClient
    .from("stories")
    .update({ root_clip_node_id: clipNode.id })
    .eq("id", story.id);

  import("@/video-intelligence/pipeline")
    .then((m) => m.analyzeClipVideo(clipNode.id))
    .catch(() => {});

  return { data: clipNode };
}

/** Create story + clip after client has uploaded the video to Supabase Storage (avoids server action body size limits). */
export async function createClipFromUpload(input: {
  storagePath: string;
  title: string;
  genre?: string | null;
  tone?: string | null;
}) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { storagePath, title, genre = null, tone = null } = input;
  if (!storagePath || !title?.trim()) return { error: "Missing required fields" };

  const { ensureProfileAndWallet } = await import("@/actions/wallet");
  await ensureProfileAndWallet();

  const { data: story, error: storyError } = await serviceClient
    .from("stories")
    .insert({
      title: title.trim(),
      genre,
      tone,
      creator_user_id: user.id,
    })
    .select()
    .single();

  if (storyError) return { error: "Failed to create story" };

  const { data: clipNode, error: clipError } = await serviceClient
    .from("clip_nodes")
    .insert({
      story_id: story.id,
      creator_user_id: user.id,
      source_type: "upload",
      status: "betting_open",
      video_storage_path: storagePath,
      genre,
      tone,
      published_at: new Date().toISOString(),
      betting_deadline: new Date(
        Date.now() + 72 * 60 * 60 * 1000
      ).toISOString(),
    })
    .select()
    .single();

  if (clipError) return { error: "Failed to create clip" };

  await serviceClient
    .from("stories")
    .update({ root_clip_node_id: clipNode.id })
    .eq("id", story.id);

  import("@/video-intelligence/pipeline")
    .then((m) => m.analyzeClipVideo(clipNode.id))
    .catch(() => {});

  return { data: clipNode };
}

export async function archiveClip(clipId: string) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: clip, error } = await serviceClient
    .from("clip_nodes")
    .select("id, creator_user_id")
    .eq("id", clipId)
    .single();

  if (error || !clip) return { error: "Clip not found" };
  if (clip.creator_user_id !== user.id) return { error: "Not allowed" };

  const { error: updateError } = await serviceClient
    .from("clip_nodes")
    .update({
      status: "archived",
      published_at: null,
    })
    .eq("id", clipId);

  if (updateError) return { error: "Failed to delete clip" };

  return { success: true };
}

/** After client has uploaded Part 2 to Storage, set path and mark clip settled (avoids server action body size limit). */
export async function setResolveVideoPath(clipId: string, storagePath: string) {
  const supabase = await createServerClient();
  const serviceClient = await createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  const { data: clip, error } = await serviceClient
    .from("clip_nodes")
    .select("id, creator_user_id")
    .eq("id", clipId)
    .single();

  if (error || !clip) return { error: "Clip not found" };
  if (clip.creator_user_id !== user.id) return { error: "Not allowed" };

  if (!storagePath?.startsWith("clips/")) return { error: "Invalid storage path" };

  const now = new Date().toISOString();
  const { error: updateError } = await serviceClient
    .from("clip_nodes")
    .update({
      part2_video_storage_path: storagePath,
      status: "settled",
      winning_outcome_text: "Manual resolution",
      resolution_reason_text: "Uploaded for testing",
      resolved_at: now,
    })
    .eq("id", clipId);

  if (updateError) {
    const msg = updateError.message || "database error";
    const hint =
      msg.includes("part2_video_storage_path") || msg.includes("winning_outcome_text")
        ? " (Did you run migrations 00006 and 00007 on this DB?)"
        : "";
    console.error("setResolveVideoPath updateError", updateError);
    return { error: `Failed to update clip: ${msg}${hint}` };
  }

  revalidatePath("/live");
  return { success: true };
}
