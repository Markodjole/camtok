"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoutePoint } from "@/actions/live-feed";

export type Direction = "forward" | "left" | "right" | "back";

interface MarketOption {
  id: string;
  label: string;
  shortLabel?: string;
  displayOrder: number;
}

interface DirectionalBetPadProps {
  options: MarketOption[];
  betAmount: number;
  onBet: (optionId: string, direction: Direction) => Promise<void>;
  locked: boolean;
  routePoints?: RoutePoint[];
}

const DIRECTION_ORDER: Direction[] = ["forward", "left", "right", "back"];

const DIRECTION_META: Record<
  Direction,
  { icon: string; label: string; danger: boolean; keywords: string[] }
> = {
  forward: { icon: "↑", label: "Straight", danger: false, keywords: ["straight", "forward", "ahead", "continue"] },
  left:    { icon: "←", label: "Left",     danger: false, keywords: ["left"] },
  right:   { icon: "→", label: "Right",    danger: false, keywords: ["right"] },
  back:    { icon: "↓", label: "Back",     danger: true,  keywords: ["back", "reverse", "return"] },
};

function matchOption(options: MarketOption[], dir: Direction): MarketOption | undefined {
  const { keywords } = DIRECTION_META[dir];
  const byLabel = options.find((o) => {
    const text = `${o.label} ${o.shortLabel ?? ""}`.toLowerCase();
    return keywords.some((k) => text.includes(k));
  });
  if (byLabel) return byLabel;
  const sorted = [...options].sort((a, b) => a.displayOrder - b.displayOrder);
  return sorted[DIRECTION_ORDER.indexOf(dir)];
}

function estimateGForce(points: RoutePoint[] | undefined): { x: number; y: number } {
  if (!points || points.length < 2) return { x: 0, y: 0 };
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const dSpeed = (last.speedMps ?? 0) - (prev.speedMps ?? 0);
  const longG = dSpeed / 9.81;
  let dHead = (last.heading ?? 0) - (prev.heading ?? 0);
  while (dHead > 180) dHead -= 360;
  while (dHead < -180) dHead += 360;
  const latG = ((dHead * Math.PI) / 180) * (last.speedMps ?? 0) / 9.81;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return { x: clamp(latG), y: clamp(longG) };
}

export function DirectionalBetPad({
  options,
  betAmount,
  onBet,
  locked,
  routePoints,
}: DirectionalBetPadProps) {
  const [pressing, setPressing] = useState<Direction | null>(null);
  const [flashDir, setFlashDir] = useState<Direction | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gForce = useMemo(() => estimateGForce(routePoints), [routePoints]);
  const gMag = Math.min(1, Math.hypot(gForce.x, gForce.y));
  const activeDir = pressing ?? flashDir;

  useEffect(() => {
    return () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); };
  }, []);

  async function handlePress(dir: Direction) {
    if (locked || pressing) return;
    setPressing(dir);
    setFlashDir(dir);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);

    const opt = matchOption(options, dir);
    if (!opt) {
      setPressing(null);
      flashTimerRef.current = setTimeout(() => {
        setFlashDir((c) => (c === dir ? null : c));
      }, 500);
      return;
    }

    try {
      await onBet(opt.id, dir);
      setFeedback(`✓ $${betAmount} on ${opt.shortLabel ?? opt.label}`);
      setTimeout(() => setFeedback(null), 3500);
    } finally {
      setPressing(null);
      flashTimerRef.current = setTimeout(() => {
        setFlashDir((c) => (c === dir ? null : c));
      }, 500);
    }
  }

  const amountLabel = `$${betAmount}`;

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Always same height — text fades in/out without shifting the joystick */}
      <div className="h-5 flex items-center justify-center transition-opacity duration-200" style={{ opacity: feedback ? 1 : 0 }}>
        <div className="rounded-full bg-black/60 px-3 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
          {feedback ?? " "}
        </div>
      </div>

      <div className="relative h-36 w-36 touch-manipulation select-none">

        {/* Center disc — g-force meter */}
        <div className="absolute inset-[22%] rounded-full border border-white/15 bg-black/35 backdrop-blur-sm">
          <div
            className="absolute left-1/2 top-1/2 h-3 w-3 rounded-full"
            style={{
              transform: `translate(calc(-50% + ${gForce.x * 60}%), calc(-50% + ${-gForce.y * 60}%))`,
              background: gMag > 0.66 ? "#ef4444" : gMag > 0.33 ? "#f59e0b" : "#22c55e",
              boxShadow: `0 0 8px ${gMag > 0.66 ? "#ef4444" : gMag > 0.33 ? "#f59e0b" : "#22c55e"}`,
              transition: "transform 250ms linear, background 250ms linear",
            }}
          />
        </div>

        {/* UP */}
        <DpadButton
          dir="forward"
          activeDir={activeDir}
          locked={locked}
          option={matchOption(options, "forward")}
          onPress={handlePress}
          amountLabel={amountLabel}
          style={{ top: 0, left: "50%", transform: "translateX(-50%)" }}
        />
        {/* LEFT */}
        <DpadButton
          dir="left"
          activeDir={activeDir}
          locked={locked}
          option={matchOption(options, "left")}
          onPress={handlePress}
          amountLabel={amountLabel}
          style={{ left: 0, top: "50%", transform: "translateY(-50%)" }}
        />
        {/* RIGHT */}
        <DpadButton
          dir="right"
          activeDir={activeDir}
          locked={locked}
          option={matchOption(options, "right")}
          onPress={handlePress}
          amountLabel={amountLabel}
          style={{ right: 0, top: "50%", transform: "translateY(-50%)" }}
        />
        {/* DOWN */}
        <DpadButton
          dir="back"
          activeDir={activeDir}
          locked={locked}
          option={matchOption(options, "back")}
          onPress={handlePress}
          amountLabel={amountLabel}
          style={{ bottom: 0, left: "50%", transform: "translateX(-50%)" }}
        />
      </div>
    </div>
  );
}

function DpadButton({
  dir, activeDir, locked, option, onPress, amountLabel, style,
}: {
  dir: Direction;
  activeDir: Direction | null;
  locked: boolean;
  option?: MarketOption;
  onPress: (d: Direction) => void;
  amountLabel: string;
  style: React.CSSProperties;
}) {
  const meta = DIRECTION_META[dir];
  const isActive = activeDir === dir;
  const disabled = locked;

  const baseColor = meta.danger
    ? "bg-red-500/85 border-red-300/50"
    : "bg-emerald-500/85 border-emerald-300/50";
  const activeColor =
    "bg-violet-600 border-violet-200 ring-4 ring-violet-400/80 shadow-[0_0_28px_rgba(139,92,246,0.95)]";

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); onPress(dir); }}
      className={[
        "absolute flex h-12 w-12 flex-col items-center justify-center gap-0.5",
        "rounded-full border-2 text-white",
        "transition-[background-color,box-shadow,transform] duration-100",
        isActive ? activeColor : baseColor,
        isActive ? "scale-95" : "",
        disabled ? "opacity-30" : "cursor-pointer",
      ].join(" ")}
      style={style}
      aria-label={option?.shortLabel ?? meta.label}
    >
      {isActive ? (
        <>
          <span className="text-[10px] font-bold leading-none text-white/80">{meta.icon}</span>
          <span className="text-[13px] font-extrabold leading-none tracking-tight">{amountLabel}</span>
        </>
      ) : (
        <span className="text-2xl leading-none">{meta.icon}</span>
      )}
    </button>
  );
}
