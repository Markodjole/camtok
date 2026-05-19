"use client";

import { useEffect, useRef, useState } from "react";
import type { TrafficCamera } from "@/app/api/live/traffic-cameras/route";

interface Props {
  camera: TrafficCamera;
  /** Width/height in px — matches the PiP square below it. */
  size: number;
}

export function TrafficCameraPanel({ camera, size }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const nonce = useRef(0);

  // Windy signed image URLs expire after 10 min; LiveRoomScreen refetches
  // cameras every 20 s, so camera.imageUrl is always a fresh signed URL.
  // We just load it whenever it changes — no manual interval needed.
  useEffect(() => {
    if (!camera.imageUrl) {
      setSrc(null);
      return;
    }
    nonce.current++;
    setLoaded(false);
    setError(false);
    setSrc(camera.imageUrl);
  }, [camera.id, camera.imageUrl]);

  const label = [camera.name, camera.direction]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="relative overflow-hidden border-y border-l border-white/15 bg-black shadow-2xl"
      style={{ width: size, height: size }}
    >
      {/* Camera feed */}
      {src && !error ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={label}
          className="h-full w-full object-cover"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      ) : null}

      {/* Spinner while loading */}
      {(!loaded || !src) && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      )}

      {/* Error / no feed */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/80">
          <span className="text-lg opacity-60">📷</span>
          <span className="text-[9px] text-white/50">No feed</span>
        </div>
      )}

      {/* Label bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
        <p className="truncate text-[8px] font-medium leading-tight text-white/85">
          {label || "Traffic Cam"}
        </p>
        {camera.distanceM < 1000 ? (
          <p className="text-[7px] text-white/50">
            {Math.round(camera.distanceM)} m ahead
          </p>
        ) : (
          <p className="text-[7px] text-white/50">
            {(camera.distanceM / 1000).toFixed(1)} km ahead
          </p>
        )}
      </div>

      {/* Live indicator */}
      <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
        </span>
        <span className="text-[7px] font-semibold uppercase tracking-wide text-sky-200">
          Cam
        </span>
      </div>
    </div>
  );
}
