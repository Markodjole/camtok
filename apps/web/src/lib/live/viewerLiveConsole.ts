/**
 * Browser-only verbose logging for the live viewer (bets, ticks, room state).
 *
 * Enabled when:
 *   - `NODE_ENV === "development"`, or
 *   - `NEXT_PUBLIC_LIVE_VIEWER_DEBUG=1` in the env (production opt-in).
 */

export function isViewerLiveDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    process.env.NODE_ENV === "development" ||
    process.env.NEXT_PUBLIC_LIVE_VIEWER_DEBUG === "1"
  );
}

export function viewerLiveLog(
  event: string,
  payload?: unknown,
): void {
  if (!isViewerLiveDebugEnabled()) return;
  const ts = new Date().toISOString();
  if (payload === undefined) {
    console.log(`[camtok:live-viewer ${ts}]`, event);
  } else {
    console.log(`[camtok:live-viewer ${ts}]`, event, payload);
  }
}

export function viewerLiveWarn(event: string, payload?: unknown): void {
  if (!isViewerLiveDebugEnabled()) return;
  console.warn(`[camtok:live-viewer]`, event, payload ?? "");
}
