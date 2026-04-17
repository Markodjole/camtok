"use client";

import { useEffect, useRef } from "react";

/**
 * V1 placeholder: displays the local camera stream when a user is broadcasting,
 * or a dark placeholder otherwise. A production implementation will replace
 * this with an SFU-backed viewer (e.g. LiveKit / mediasoup) using our own
 * webrtcSessionManager tokens.
 */
export function LiveVideoPlayer({
  localStream,
  className,
}: {
  localStream?: MediaStream | null;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (localStream) {
      el.srcObject = localStream;
      void el.play().catch(() => undefined);
    } else {
      el.srcObject = null;
    }
  }, [localStream]);

  return (
    <div className={`relative aspect-[9/16] w-full overflow-hidden bg-black ${className ?? ""}`}>
      <video
        ref={ref}
        muted
        playsInline
        autoPlay
        className="h-full w-full object-cover"
      />
      {!localStream ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          Live stream connecting…
        </div>
      ) : null}
    </div>
  );
}
