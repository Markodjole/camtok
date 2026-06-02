"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoutePoint } from "@/actions/live-feed";
import type { CityGridSpecCompact } from "@/lib/live/grid/cityGrid500";
import {
  computePinOverlay,
  computeZoneGateOverlay,
  metersBetween,
  type OverlayElementLayout,
} from "@/lib/live/videoOverlayGeometry";

export type VideoOverlayPinTarget = {
  lat: number;
  lng: number;
  distanceM: number;
  label?: string;
};

type SmoothFields = Pick<
  OverlayElementLayout,
  "xPct" | "yPct" | "scale" | "opacity"
>;

type SmoothedOverlay = SmoothFields & {
  visible: boolean;
  distanceM?: number;
  label?: string;
  enterLabel?: string;
};

const SMOOTH_MS = 250;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function useSmoothedOverlay(
  target: SmoothedOverlay | null,
  durationMs = SMOOTH_MS,
): SmoothedOverlay | null {
  const targetRef = useRef(target);
  targetRef.current = target;

  const smoothRef = useRef<SmoothFields>({
    xPct: 50,
    yPct: 25,
    scale: 0.5,
    opacity: 0,
  });
  const metaRef = useRef<{ label?: string; enterLabel?: string; distanceM?: number }>(
    {},
  );
  const [render, setRender] = useState<SmoothedOverlay | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const alpha = Math.min(1, dt / durationMs);
      const t = targetRef.current;
      const s = smoothRef.current;

      if (t?.visible) {
        metaRef.current = {
          label: t.label,
          enterLabel: t.enterLabel,
          distanceM: t.distanceM,
        };
        smoothRef.current = {
          xPct: lerp(s.xPct, t.xPct, alpha),
          yPct: lerp(s.yPct, t.yPct, alpha),
          scale: lerp(s.scale, t.scale, alpha),
          opacity: lerp(s.opacity, t.opacity, alpha),
        };
        setRender({
          ...smoothRef.current,
          visible: true,
          ...metaRef.current,
        });
      } else if (s.opacity > 0.03) {
        smoothRef.current = {
          ...s,
          opacity: lerp(s.opacity, 0, alpha),
        };
        setRender({
          ...smoothRef.current,
          visible: true,
          ...metaRef.current,
        });
      } else {
        setRender(null);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  return render;
}

export function VideoStreamOverlay({
  routePoints,
  pinTarget,
  zoneGridSpec,
  zoneLabel,
}: {
  routePoints: RoutePoint[];
  pinTarget: VideoOverlayPinTarget | null;
  zoneGridSpec: CityGridSpecCompact | null;
  zoneLabel?: string | null;
}) {
  const driver = routePoints.length > 0 ? routePoints[routePoints.length - 1]! : null;

  const pinLayoutTarget = useMemo((): SmoothedOverlay | null => {
    if (!driver || !pinTarget || pinTarget.distanceM < 10) return null;
    const layout = computePinOverlay(driver, pinTarget, pinTarget.distanceM);
    if (!layout.visible) return null;
    return {
      ...layout,
      label: pinTarget.label ?? "NEXT PIN",
    };
  }, [driver, pinTarget]);

  const zoneLayoutTarget = useMemo((): SmoothedOverlay | null => {
    if (!driver || !zoneGridSpec) return null;
    const layout = computeZoneGateOverlay(driver, zoneGridSpec, zoneLabel);
    if (!layout) return null;
    const { enterLabel, ...rest } = layout;
    return { ...rest, enterLabel };
  }, [driver, zoneGridSpec, zoneLabel]);

  const pin = useSmoothedOverlay(pinLayoutTarget);
  const zone = useSmoothedOverlay(zoneLayoutTarget);

  if (!pin && !zone) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {zone ? (
        <div
          className="absolute whitespace-nowrap text-center"
          style={{
            left: `${zone.xPct}%`,
            top: `${zone.yPct}%`,
            transform: `translate(-50%, -50%) scale(${zone.scale})`,
            opacity: zone.opacity,
          }}
        >
          <div
            className="mx-auto h-[2px] w-[min(72vw,240px)] rounded-full bg-gradient-to-r from-transparent via-cyan-300/90 to-transparent shadow-[0_0_12px_rgba(34,211,238,0.75)]"
            aria-hidden
          />
          <div className="mt-1 rounded-md bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-100 [text-shadow:0_0_6px_#000] backdrop-blur-[2px] sm:text-xs">
            Entering {zone.enterLabel ?? "Zone"}
          </div>
          <div
            className="mx-auto mt-1 h-[2px] w-[min(72vw,240px)] rounded-full bg-gradient-to-r from-transparent via-cyan-300/90 to-transparent shadow-[0_0_12px_rgba(34,211,238,0.75)]"
            aria-hidden
          />
        </div>
      ) : null}

      {pin ? (
        <div
          className="absolute text-center"
          style={{
            left: `${pin.xPct}%`,
            top: `${pin.yPct}%`,
            transform: `translate(-50%, -50%) scale(${pin.scale})`,
            opacity: pin.opacity,
          }}
        >
          <div className="flex flex-col items-center gap-0.5">
            <span
              className="inline-block h-3 w-3 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.95)] ring-2 ring-emerald-200/70"
              aria-hidden
            />
            <div className="rounded-full bg-black/55 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100 [text-shadow:0_0_6px_#000] backdrop-blur-[2px] sm:text-xs">
              {pin.label ?? "Next pin"}
            </div>
            {pin.distanceM != null ? (
              <div className="text-[11px] font-semibold tabular-nums text-white/90 [text-shadow:0_0_6px_#000] sm:text-sm">
                {Math.round(pin.distanceM)}m
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Resolve the best pin target for the video overlay from live room state. */
export function resolveVideoOverlayPin(args: {
  driver: RoutePoint | null;
  stepPin: { lat: number; lng: number } | null;
  driverPin: { lat: number; lng: number; distanceMeters?: number } | null | undefined;
  turnTarget: { lat: number; lng: number } | null;
}): VideoOverlayPinTarget | null {
  const { driver, stepPin, driverPin, turnTarget } = args;
  if (!driver) return null;

  if (stepPin) {
    const distanceM = metersBetween(driver, stepPin);
    if (distanceM >= 10) {
      return { ...stepPin, distanceM, label: "NEXT PIN" };
    }
  }

  if (driverPin?.distanceMeters != null && driverPin.distanceMeters >= 10) {
    return {
      lat: driverPin.lat,
      lng: driverPin.lng,
      distanceM: driverPin.distanceMeters,
      label: "NEXT PIN",
    };
  }

  if (turnTarget) {
    const distanceM = metersBetween(driver, turnTarget);
    if (distanceM >= 10) {
      return { ...turnTarget, distanceM, label: "NEXT PIN" };
    }
  }

  return null;
}
