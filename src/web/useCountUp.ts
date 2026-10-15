"use client";

import { useEffect, useState } from "react";
import { interpolateMinor } from "./money";

export function useCountUp(target: string, durationMs = 700): string {
  const [value, setValue] = useState("0");

  useEffect(() => {
    // Reduced motion: the first frame jumps straight to the target.
    const instant = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = instant ? 1 : Math.min(1, (now - start) / durationMs);
      setValue(interpolateMinor(target, 1 - (1 - p) ** 3)); // ease-out cubic
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}
