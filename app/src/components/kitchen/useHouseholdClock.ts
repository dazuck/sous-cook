"use client";

import { useSyncExternalStore } from "react";
import { getKitchenPlace } from "@/lib/ambient/location";
import { clockText, eyebrowAt } from "@/lib/kitchen/household-time";

const MINUTE = 60_000;

/** The current minute's start, in epoch ms: it changes once a minute, so React re-reads once a minute. */
const minute = () => Math.floor(Date.now() / MINUTE) * MINUTE;

function subscribe(onChange: () => void): () => void {
  // Checked a few times a minute so the change lands within seconds of the
  // minute turning, without a timer aligned to it (the e2e clock is installed
  // and driven by the test).
  const id = setInterval(onChange, 5_000);
  return () => clearInterval(id);
}

/**
 * The household's clock for the kitchen home (D7): the time as a wall clock
 * and the eyebrow over the queue's top dish, in the household's zone. Both
 * are null until mounted, so the server's first paint and the client's agree.
 */
export function useHouseholdClock(): { time: string; eyebrow: "Tonight" | "Up next" } | null {
  const now = useSyncExternalStore(subscribe, minute, () => 0);
  if (now === 0) return null;
  const date = new Date(now);
  const { tz } = getKitchenPlace();
  return { time: clockText(date, tz), eyebrow: eyebrowAt(date, tz) };
}
