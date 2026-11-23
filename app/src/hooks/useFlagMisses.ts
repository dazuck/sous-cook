"use client";

import { useSyncExternalStore } from "react";
import { flagMisses, type FlagMisses, type MissLog } from "@/lib/kitchen/flag-misses";

const NONE: FlagMisses = { failed: 0, full: 0 };

/** The flags this tablet didn't keep since the page loaded, kept current. The server has none. */
export function useFlagMisses(log: MissLog = flagMisses): FlagMisses {
  return useSyncExternalStore(log.subscribe, log.read, () => NONE);
}
