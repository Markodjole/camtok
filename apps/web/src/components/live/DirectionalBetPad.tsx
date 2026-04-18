"use client";

import { useState } from "react";

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
}

const DIRECTION_ORDER: Direction[] = ["forward", "left", "right", "back"];

const DIRECTION_META: Record<
  Direction,
  { icon: string; label: string; color: string; keywords: string[] }
> = {
  forward: {
    icon: "↑",
    label: "Straight",
    color: "from-indigo-500/60 to-indigo-700/60",
    keywords: ["straight", "forward", "ahead", "continue"],
  },
  left: {
    icon: "←",
    label: "Left",
    color: "from-sky-500/60 to-sky-700/60",
    keywords: ["left"],
  },
  right: {
    icon: "→",
    label: "Right",
    color: "from-violet-500/60 to-violet-700/60",
    keywords: ["right"],
  },
  back: {
    icon: "↓",
    label: "Back",
    color: "from-rose-500/60 to-rose-700/60",
    keywords: ["back", "reverse", "return"],
  },
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

export function DirectionalBetPad({ options, betAmount, onBet, locked }: DirectionalBetPadProps) {
  const [pressing, setPressing] = useState<Direction | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handlePress(dir: Direction) {
    if (locked || pressing) return;
    const opt = matchOption(options, dir);
    if (!opt) return;
    setPressing(dir);
    try {
      await onBet(opt.id, dir);
      setFeedback(`✓  $${betAmount} on ${opt.shortLabel ?? opt.label}`);
      setTimeout(() => setFeedback(null), 1400);
    } finally {
      setPressing(null);
    }
  }

  return (
    /* Semi-transparent backdrop — blurs the video behind the pad */
    <div className="w-full max-w-xs rounded-3xl border border-white/10 bg-black/30 p-4 backdrop-blur-md">
      {/* Feedback / hint line */}
      <div className="mb-2 h-4 text-center text-[11px] text-white/60">
        {feedback
          ? feedback
          : locked
            ? "Market locked"
            : options.length === 0
              ? "No active market"
              : "Tap a direction to bet"}
      </div>

      {/* D-pad grid */}
      <div className="mx-auto grid w-40 grid-cols-3 grid-rows-3 gap-2">
        <div />
        <DpadButton dir="forward" pressing={pressing} locked={locked} option={matchOption(options, "forward")} onPress={handlePress} />
        <div />

        <DpadButton dir="left"    pressing={pressing} locked={locked} option={matchOption(options, "left")}    onPress={handlePress} />
        <div className="flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-white/20" />
        </div>
        <DpadButton dir="right"   pressing={pressing} locked={locked} option={matchOption(options, "right")}   onPress={handlePress} />

        <div />
        <DpadButton dir="back"    pressing={pressing} locked={locked} option={matchOption(options, "back")}    onPress={handlePress} />
        <div />
      </div>
    </div>
  );
}

function DpadButton({
  dir, pressing, locked, option, onPress,
}: {
  dir: Direction;
  pressing: Direction | null;
  locked: boolean;
  option?: MarketOption;
  onPress: (d: Direction) => void;
}) {
  const meta = DIRECTION_META[dir];
  const isActive = pressing === dir;
  const disabled = locked || !option;

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={() => onPress(dir)}
      className={[
        "flex aspect-square flex-col items-center justify-center rounded-2xl",
        "border border-white/15 bg-gradient-to-b text-white",
        "transition-transform duration-75",
        meta.color,
        isActive ? "scale-90 brightness-150" : "scale-100",
        disabled ? "opacity-25" : "active:scale-90 cursor-pointer",
      ].join(" ")}
    >
      <span className="text-xl leading-none">{meta.icon}</span>
      <span className="mt-0.5 text-[9px] font-medium leading-none text-white/70">
        {option?.shortLabel ?? meta.label}
      </span>
    </button>
  );
}
