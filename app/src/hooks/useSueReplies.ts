"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_SUE_REPLIES,
  SUE_REPLIES_EVENT,
  getSueReplies,
  setSueReplies,
  type SueReplies,
} from "@/lib/kitchen/cook-prefs";

function subscribe(onChange: () => void): () => void {
  // This page's own change, and another tab's.
  window.addEventListener(SUE_REPLIES_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SUE_REPLIES_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Sue's replies on this device, and the way to change them; `sounds` until the cook chooses. */
export function useSueReplies(): SueReplies {
  return useSyncExternalStore(subscribe, getSueReplies, () => DEFAULT_SUE_REPLIES);
}

export { setSueReplies };
