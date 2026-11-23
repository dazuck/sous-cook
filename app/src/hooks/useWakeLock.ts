import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Custom hook to prevent screen from sleeping while cooking
 * Uses the Screen Wake Lock API (supported in Chrome, Edge, and Safari 16.4+)
 */
export function useWakeLock() {
  // Check Wake Lock API support using initializer (not in effect)
  const [isSupported] = useState(
    () => typeof navigator !== "undefined" && "wakeLock" in navigator,
  );
  const [isActive, setIsActive] = useState(false);
  // Use ref to avoid recreating callbacks when wakeLock changes
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Request wake lock - stable callback (no deps that change)
  const requestWakeLock = useCallback(async () => {
    if (!isSupported) return false;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      setIsActive(true);

      // Handle wake lock release (e.g., tab switch)
      sentinel.addEventListener("release", () => {
        setIsActive(false);
        wakeLockRef.current = null;
      });

      return true;
    } catch (err) {
      // Wake lock request failed (e.g., low battery, page not visible)
      console.warn("Wake lock request failed:", err);
      return false;
    }
  }, [isSupported]);

  // Release wake lock - stable callback
  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
      setIsActive(false);
    }
  }, []);

  // Re-acquire wake lock when page becomes visible again
  useEffect(() => {
    if (!isSupported || !isActive) return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === "visible" && !wakeLockRef.current) {
        await requestWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isSupported, isActive, requestWakeLock]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
      }
    };
  }, []);

  return {
    isSupported,
    isActive,
    requestWakeLock,
    releaseWakeLock,
  };
}
