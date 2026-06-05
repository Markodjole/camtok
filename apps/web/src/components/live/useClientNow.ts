"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe clock. Returns 0 until after mount so server and client text match
 * during hydration (avoids React #418 text mismatches on countdown labels).
 */
export function useClientNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
