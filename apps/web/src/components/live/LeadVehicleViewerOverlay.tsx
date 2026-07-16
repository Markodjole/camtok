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
/** Wire format of realtime box messages from the broadcaster's data channel. */
type RtWire = {
  v: 1;
  t: number;
  lead: {
    id: string;
    type: string;
    status: string;
    phase?: string;
    x: number;
    y: number;
    w: number;
    h: number;
  } | null;
  pass?: { id: string; t: number };
};

/** Realtime data considered live for this long after the last message. */
const RT_FRESH_MS = 1500;

export function LeadVehicleViewerOverlay({ liveSessionId, className }: Props) {
  const [state, setState] = useState<LeadVehicleOverlayState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<ContentRect | null>(null);
  // Realtime boxes over the P2P data channel (~50ms). HTTP polling below is
  // the fallback when the channel is absent (old app build, channel dropped).
  const [rt, setRt] = useState<{ lead: RtWire["lead"]; at: number } | null>(
    null,
  );
  const rtLastMsgRef = useRef(0);
  // "+1" flash when the broadcaster passes the vehicle they were following.
  // Keyed on pass identity (not wall clock) so device clock skew is moot.
  const [passFlash, setPassFlash] = useState(false);
  const lastPassKeyRef = useRef<string | null>(null);
  const passFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerPassFlash = (key: string, skipIfFirst: boolean) => {
    if (lastPassKeyRef.current === key) return;
    const isFirst = lastPassKeyRef.current === null;
    lastPassKeyRef.current = key;
    // Skip a stale pass already present when we first mount.
    if (isFirst && skipIfFirst) return;
    setPassFlash(true);
    if (passFlashTimerRef.current) clearTimeout(passFlashTimerRef.current);
    passFlashTimerRef.current = setTimeout(() => setPassFlash(false), 2200);
  };

  useEffect(() => {
    const onMsg = (e: Event) => {
      const d = (e as CustomEvent).detail as RtWire | undefined;
      if (!d || d.v !== 1) return;
      rtLastMsgRef.current = Date.now();
      setRt({ lead: d.lead, at: Date.now() });
      if (d.pass) triggerPassFlash(`${d.pass.id}:${d.pass.t}`, false);
    };
    window.addEventListener("camtok:lead-vehicle", onMsg);
    // Sweep: when messages stop (stream ended, channel dropped), clear the
    // frozen realtime box and let HTTP fallback take over.
    const sweep = setInterval(() => {
      if (rtLastMsgRef.current && Date.now() - rtLastMsgRef.current > RT_FRESH_MS) {
        setRt(null);
      }
    }, 500);
    return () => {
      window.removeEventListener("camtok:lead-vehicle", onMsg);
      clearInterval(sweep);
      if (passFlashTimerRef.current) clearTimeout(passFlashTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const lp = state?.lastPass;
    if (!lp) return;
    triggerPassFlash(`${lp.trackId}:${lp.timestampMs}`, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.lastPass]);

  useEffect(() => {
    if (!liveSessionId) {
      setState(null);
      return;
    }
    let stopped = false;
    const tick = async () => {
      // Realtime channel is live — don't waste requests on the fallback.
      if (Date.now() - rtLastMsgRef.current < RT_FRESH_MS) return;
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

  // Single lead vehicle we're following. Realtime channel wins when live;
  // otherwise fall back to the polled server state.
  const lead = rt
    ? rt.lead
      ? {
          trackId: rt.lead.id,
          vehicleType: rt.lead.type,
          status: rt.lead.status,
          phase: rt.lead.phase,
          normalizedBoundingBox: {
            x: rt.lead.x,
            y: rt.lead.y,
            width: rt.lead.w,
            height: rt.lead.h,
          },
        }
      : undefined
    : (state?.detections?.find((d) => d.isLead) ??
      state?.detections?.[0] ??
      (state?.normalizedBoundingBox
        ? {
            trackId: state.trackId ?? undefined,
            vehicleType: state.vehicleType ?? undefined,
            status: state.relativeState ?? undefined,
            phase: undefined as string | undefined,
            normalizedBoundingBox: state.normalizedBoundingBox,
          }
        : undefined));

  const box = lead?.normalizedBoundingBox;
  const hasBox = !!box && box.width > 0 && box.height > 0;
  if (!liveSessionId || (!hasBox && !passFlash)) return null;

  const boxStyle =
    hasBox && box
      ? content
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
          }
      : null;

  return (
    <div
      ref={rootRef}
      className={`pointer-events-none absolute inset-0 z-[12] ${className ?? ""}`}
      aria-hidden
    >
      {/* One thin square around the followed lead vehicle:
          dashed blue while the speed match is being verified (~3s of stable
          distance), solid green once locked. The CSS transition interpolates
          between ~5Hz box updates so the square glides with the vehicle. */}
      {boxStyle ? (
        <div
          className="absolute"
          style={{
            ...boxStyle,
            transition:
              "left 200ms linear, top 200ms linear, width 200ms linear, height 200ms linear",
          }}
        >
          {(() => {
            const evaluating = lead?.phase === "evaluating";
            const color = evaluating ? "#38bdf8" : "#22c55e";
            return (
              <>
                <div
                  className="absolute inset-0"
                  style={{
                    border: evaluating
                      ? `1.5px dashed ${color}`
                      : `1.5px solid ${color}`,
                    borderRadius: 3,
                  }}
                />
                <div
                  className="absolute left-0 top-0 -translate-y-full whitespace-nowrap rounded px-1 py-px text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: color, color: "#04120a" }}
                >
                  {vehicleLabel(lead)}
                </div>
              </>
            );
          })()}
        </div>
      ) : null}
      {/* Brief "+1" when the broadcaster overtakes the followed vehicle. */}
      {passFlash ? (
        <div
          className="absolute left-1/2 top-[22%] -translate-x-1/2 rounded-full px-3 py-1 text-lg font-bold"
          style={{ color: "#22c55e", background: "rgba(0,0,0,0.6)" }}
        >
          +1 passed
        </div>
      ) : null}
    </div>
  );
}

/**
 * Label for the tracked vehicle: class + its two-digit follow number
 * ("Car 🚗 #47"). The number changes only when the follower genuinely
 * switches to another vehicle, making switches visible to the viewer.
 */
function vehicleLabel(
  lead: { vehicleType?: string; trackId?: string } | undefined,
): string {
  let cls: string;
  switch ((lead?.vehicleType ?? "").toLowerCase()) {
    case "motorcycle":
      cls = "Moto 🏍";
      break;
    case "car":
      cls = "Car 🚗";
      break;
    case "bus":
      cls = "Bus 🚌";
      break;
    case "truck":
      cls = "Truck 🚚";
      break;
    case "bicycle":
      cls = "Bike 🚲";
      break;
    default:
      cls = "Tracking";
  }
  const num = /^lead_(\d{2})$/.exec(lead?.trackId ?? "")?.[1];
  return num ? `${cls} #${num}` : cls;
}
