"use client";

import { useSyncExternalStore } from "react";

export const SIGNED_OUT_COOK_NOTICE = "Signed out. Sign in again after this cook.";

let signedOut = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Records that the current page lost its session while a cook remained open.
 */
export function markSignedOut(): void {
  if (signedOut) return;
  signedOut = true;
  for (const listener of listeners) {
    listener();
  }
}

export function isSignedOut(): boolean {
  return signedOut;
}

export function useSignedOut(): boolean {
  return useSyncExternalStore(subscribe, isSignedOut, () => false);
}

export function resetSignedOutForTests(): void {
  if (!signedOut) return;
  signedOut = false;
  for (const listener of listeners) {
    listener();
  }
}
