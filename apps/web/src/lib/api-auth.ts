import type { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Small helper for routes that need to authenticate a caller who sent a
 * `Authorization: Bearer <supabase-access-token>` header (typically a
 * mobile / non-web-cookie client, e.g. the Expo app).
 *
 * Returns `null` if there is no token or the token doesn't resolve to a
 * user — callers should return 401 in that case.
 */
export async function getBearerUser(
  req: NextRequest | Request,
): Promise<{ id: string; email: string | null } | null> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1];
  const service = await createServiceClient();
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
