import { useCallback, useLayoutEffect, useRef } from "react";

export interface SwipeConfig {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number; // Minimum distance for swipe (default: 50px)
  preventScrollOnSwipe?: boolean;
  /** Axis lock: returns true if another gesture (e.g. cook look-ahead sheet) claimed this touch */
  claimed?: () => boolean;
}

interface TouchState {
  startX: number;
  startY: number;
  startTime: number;
}

/**
 * Custom hook for swipe gesture detection
 * Useful for tablet/touch navigation in kitchen mode
 *
 * Returns a callback ref, so the listeners attach whenever the element mounts
 * (including after a loading state) and detach when it goes. The handlers are
 * read from the latest render, so passing fresh closures each render never
 * re-attaches anything. A touch that starts inside `[data-no-swipe]` (a row
 * that scrolls sideways) is left alone.
 */
export function useSwipeGesture<T extends HTMLElement = HTMLDivElement>(
  config: SwipeConfig,
) {
  const latest = useRef(config);
  useLayoutEffect(() => {
    latest.current = config;
  });

  return useCallback((element: T | null) => {
    if (!element) return;
    let touch: TouchState | null = null;

    const handleTouchStart = (e: TouchEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("[data-no-swipe]")) {
        touch = null;
        return;
      }
      const t = e.touches[0];
      touch = { startX: t.clientX, startY: t.clientY, startTime: Date.now() };
    };

    const handleTouchMove = (e: TouchEvent) => {
      const { preventScrollOnSwipe = true } = latest.current;
      if (!touch || !preventScrollOnSwipe) return;

      const t = e.touches[0];
      const deltaX = Math.abs(t.clientX - touch.startX);
      const deltaY = Math.abs(t.clientY - touch.startY);

      // If horizontal movement is dominant, prevent vertical scroll
      if (deltaX > deltaY && deltaX > 10) {
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touch) return;
      const { onSwipeLeft, onSwipeRight, threshold = 50, claimed } = latest.current;

      const t = e.changedTouches[0];
      const deltaX = t.clientX - touch.startX;
      const deltaY = t.clientY - touch.startY;
      const deltaTime = Date.now() - touch.startTime;
      touch = null;

      // Axis lock (N3a): if claimed by another gesture (e.g. sheet pull/drift), abort swipe
      if (claimed?.()) return;

      const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
      const isSignificantSwipe = Math.abs(deltaX) >= threshold;
      const isQuickSwipe = deltaTime < 500;

      if (isHorizontalSwipe && isSignificantSwipe && isQuickSwipe) {
        if (deltaX > 0) onSwipeRight?.();
        else onSwipeLeft?.();
      }
    };

    // A touch the browser takes over (a system gesture, an alert) is no
    // swipe; forget it so the next touchend can't finish it.
    const handleTouchCancel = () => {
      touch = null;
    };

    // Use passive: false for touchmove to allow preventDefault
    element.addEventListener("touchstart", handleTouchStart, { passive: true });
    element.addEventListener("touchmove", handleTouchMove, { passive: false });
    element.addEventListener("touchend", handleTouchEnd, { passive: true });
    element.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    return () => {
      element.removeEventListener("touchstart", handleTouchStart);
      element.removeEventListener("touchmove", handleTouchMove);
      element.removeEventListener("touchend", handleTouchEnd);
      element.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, []);
}
