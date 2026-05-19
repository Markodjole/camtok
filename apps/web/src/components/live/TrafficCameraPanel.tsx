"use client";

import { useEffect, useRef, useState } from "react";
import type { TrafficCamera } from "@/app/api/live/traffic-cameras/route";

interface Props {
  camera: TrafficCamera;
  /** Width/height in px — matches the PiP square below it. */
  size: number;
}

function bustUrl(url: string, t: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_t=${t}`;
}

const REFRESH_MS = 5_000;

export function TrafficCameraPanel({ camera, size }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const tickRef = useRef(0);

  useEffect(() => {
    if (!camera.imageUrl) {
      setSrc(null);
      return;
    }
    const load = () => {
      setLoaded(false);
      setError(false);
      setSrc(bustUrl(camera.imageUrl!, Date.now()));
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.imageUrl]);

  void tickRef;

  return (
    <div
      className="relative overflow-hidden bg-black shadow-2xl"
      style={{ width: size, height: size }}
    >
      {src && !error ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      ) : null}

      {(!loaded || !src) && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <span className="text-lg opacity-40">📷</span>
        </div>
      )}

      {/* Minimal live dot — top-left */}
      <div className="absolute left-1.5 top-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
        </span>
      </div>
    </div>
  );
}
