import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * How long finishing holds off after the last screen appears, so a tap, key
 * or "done" meant for the step before doesn't end the cook.
 */
export const FINISH_ARM_MS = 500;

/**
 * Whether the last screen has been up long enough to finish from. The
 * returned check is stable; it says nothing about whether this is the last
 * screen, which the caller still asks.
 */
export function useFinishArm(isLast: boolean): () => boolean {
  const armedAt = useRef(0);
  useLayoutEffect(() => {
    if (isLast) armedAt.current = performance.now() + FINISH_ARM_MS;
  }, [isLast]);
  return useCallback(() => performance.now() >= armedAt.current, []);
}
