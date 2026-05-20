"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { TrafficCamera } from "@/app/api/live/traffic-cameras/route";

interface Props {
  camera: TrafficCamera;
  /** Width/height in px — matches the PiP square below it. */
  size: number;
}

/** TfL MP4 clips are ~10 s long and updated continuously.
 *  We reload the video src every REFRESH_MS to pick up the latest clip. */
const REFRESH_MS = 12_000;

function bustUrl(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_t=${Date.now()}`;
}

function TrafficCameraPanelInner({ camera, size }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [useVideo, setUseVideo] = useState(true);

  useEffect(() => {
    setUseVideo(true);
    if (camera.videoUrl) {
      setVideoSrc(bustUrl(camera.videoUrl));
    } else if (camera.imageUrl) {
      setVideoSrc(null);
      setImgSrc(bustUrl(camera.imageUrl));
    } else {
      setVideoSrc(null);
      setImgSrc(null);
    }

    // Periodically reload to get the latest clip from TfL's S3 bucket.
    const id = setInterval(() => {
      if (camera.videoUrl) {
        setVideoSrc(bustUrl(camera.videoUrl));
      } else if (camera.imageUrl) {
        setImgSrc(bustUrl(camera.imageUrl));
      }
    }, REFRESH_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.videoUrl, camera.imageUrl]);

  return (
    <div
      className="relative overflow-hidden bg-black shadow-2xl"
      style={{ width: size, height: size }}
    >
      {/* MP4 video — preferred */}
      {useVideo && videoSrc ? (
        <video
          ref={videoRef}
          key={videoSrc}
          src={videoSrc}
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          onError={() => {
            // Fall back to still image if video fails.
            setUseVideo(false);
            if (camera.imageUrl) setImgSrc(bustUrl(camera.imageUrl));
          }}
        />
      ) : imgSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={imgSrc}
          src={imgSrc}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        </div>
      )}

      {/* Live dot */}
      <div className="absolute left-1.5 top-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
        </span>
      </div>
    </div>
  );
}

export const TrafficCameraPanel = memo(TrafficCameraPanelInner);
