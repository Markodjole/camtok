"use client";

import { useEffect, useRef, useState } from "react";
import type { LeadVehicleOverlayState } from "@/actions/live-lead-vehicle";

type Props = {
  liveSessionId: string | null | undefined;
  className?: string;
};

/** Rendered rectangle of the video *content* inside its element, in px. */
type ContentRect = {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

function parsePositionFraction(token: string | undefined): number {
  if (!token) return 0.5;
  const t = token.trim();
  if (t.endsWith("%")) {
    const n = parseFloat(t);
    return Number.isFinite(n) ? n / 100 : 0.5;
  }
  if (t === "left" || t === "top") return 0;
  if (t === "right" || t === "bottom") return 1;
  if (t === "center") return 0.5;
  return 0.5;
}

/**
 * Compute where the video content is actually painted inside its element,
 * accounting for object-fit (cover/contain/fill) and object-position. Overlay
 * boxes are in the video's 0-1 frame space, so they must be placed relative to
 * this rect — otherwise boxes for vehicles near the frame edges land in the
 * cropped-off region (object-fit: cover) and only centered vehicles show.
 */
function measureContent(video: HTMLVideoElement | null): ContentRect | null {
  if (!video) return null;
  const elW = video.clientWidth;
  const elH = video.clientHeight;
  const vidW = video.videoWidth;
  const vidH = video.videoHeight;
  if (elW <= 0 || elH <= 0) return null;
  if (vidW <= 0 || vidH <= 0) {
    return { offsetX: 0, offsetY: 0, width: elW, height: elH };
  }
  const style = getComputedStyle(video);
  const fit = style.objectFit || "contain";
  let renderedW: number;
  let renderedH: number;
  if (fit === "fill") {
    renderedW = elW;
    renderedH = elH;
  } else if (fit === "none") {
    renderedW = vidW;
    renderedH = vidH;
  } else {
    const scale =
      fit === "cover"
        ? Math.max(elW / vidW, elH / vidH)
        : Math.min(elW / vidW, elH / vidH); // contain / scale-down default
    renderedW = vidW * scale;
    renderedH = vidH * scale;
  }
  const pos = (style.objectPosition || "50% 50%").split(/\s+/);
  const fx = parsePositionFraction(pos[0]);
  const fy = parsePositionFraction(pos[1] ?? pos[0]);
  return {
    offsetX: (elW - renderedW) * fx,
    offsetY: (elH - renderedH) * fy,
    width: renderedW,
    height: renderedH,
  };
}

/**
 * Viewer-only overlay: one thin green square around the single lead vehicle
 * the broadcaster is following. No labels, no counting, no status colors.
 */
export function LeadVehicleViewerOverlay({ liveSessionId, className }: Props) {
  const [state, setState] = useState<LeadVehicleOverlayState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<ContentRect | null>(null);

  useEffect(() => {
    if (!liveSessionId) {
      setState(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/live/sessions/${liveSessionId}/lead-vehicle`,
          { cache: "no-store" },
        );
        if (!res.ok || stopped) return;
        const json = (await res.json()) as {
          state: LeadVehicleOverlayState | null;
        };
        if (!stopped) setState(json.state);
      } catch {
        // soft-fail
      }
    };
    void tick();
    const id = setInterval(tick, 400);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [liveSessionId]);

  // Keep the mapped video-content rect in sync with layout / stream size.
  useEffect(() => {
    const findVideo = (): HTMLVideoElement | null =>
      rootRef.current?.parentElement?.querySelector("video") ?? null;

    let raf = 0;
    const measure = () => {
      const next = measureContent(findVideo());
      if (next) {
        setContent((prev) =>
          !prev ||
          prev.offsetX !== next.offsetX ||
          prev.offsetY !== next.offsetY ||
          prev.width !== next.width ||
          prev.height !== next.height
            ? next
            : prev,
        );
      }
    };

    measure();
    const interval = setInterval(measure, 300);
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    if (rootRef.current) ro.observe(rootRef.current);
    const video = findVideo();
    video?.addEventListener("loadedmetadata", measure);
    window.addEventListener("resize", measure);

    return () => {
      clearInterval(interval);
      cancelAnimationFrame(raf);
      ro.disconnect();
      video?.removeEventListener("loadedmetadata", measure);
      window.removeEventListener("resize", measure);
    };
  }, [liveSessionId]);

  // Single lead vehicle we're following (first isLead detection, else the first).
  const lead =
    state?.detections?.find((d) => d.isLead) ??
    state?.detections?.[0] ??
    (state?.normalizedBoundingBox
      ? {
          trackId: state.trackId ?? undefined,
          status: state.relativeState ?? undefined,
          normalizedBoundingBox: state.normalizedBoundingBox,
        }
      : undefined);

  const box = lead?.normalizedBoundingBox;
  if (!liveSessionId || !box || box.width <= 0 || box.height <= 0) return null;

  const boxStyle = content
    ? {
        left: `${content.offsetX + box.x * content.width}px`,
        top: `${content.offsetY + box.y * content.height}px`,
        width: `${box.width * content.width}px`,
        height: `${box.height * content.height}px`,
      }
    : {
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
      };

  return (
    <div
      ref={rootRef}
      className={`pointer-events-none absolute inset-0 z-[12] ${className ?? ""}`}
      aria-hidden
    >
      {/* One thin square around the followed lead vehicle — nothing else. */}
      <div
        className="absolute"
        style={{
          ...boxStyle,
          border: "1.5px solid #22c55e",
          borderRadius: 3,
        }}
      />
    </div>
  );
}
