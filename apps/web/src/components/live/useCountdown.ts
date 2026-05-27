"use client";

import { useEffect, useState } from "react";

export function useCountdown(targetIso: string) {
  // Initialize to 0 (not Date.now()) so server and client render identical
  // output during SSR/hydration. The real clock starts after mount.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // now === 0 means we haven't mounted yet — return a sentinel so callers
  // can render nothing (or a placeholder) without a hydration mismatch.
  if (now === 0) return { secondsLeft: -1, label: "" };

  const target = new Date(targetIso).getTime();
  const deltaMs = target - now;
  const secondsLeft = Math.max(0, Math.ceil(deltaMs / 1000));

  return {
    secondsLeft,
    label: `${secondsLeft}s`,
  };
}
