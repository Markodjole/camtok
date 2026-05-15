"use client";

import { useEffect, useState } from "react";

export function useCountdown(targetIso: string) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const target = new Date(targetIso).getTime();
  const deltaMs = target - now;
  const secondsLeft = Math.max(0, Math.ceil(deltaMs / 1000));

  return {
    secondsLeft,
    label: `${secondsLeft}s`,
  };
}
