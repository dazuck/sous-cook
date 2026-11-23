/**
 * Cook-view preferences, per device, in localStorage: the prep mode the cook
 * last chose, and whether voice is on (it is unless turned off).
 *
 * Storage can be missing (the server) or throw (private browsing, blocked site
 * data). A preference is a convenience, so reads then give the default and a
 * failed write is logged; the cook view never breaks over one.
 */

import { safeLocalStorage } from "@/lib/persist/safe-storage";
import type { PrepMode } from "./cook-plan";

export const PREP_MODE_KEY = "sous-cook-prep-mode";
export const DEFAULT_PREP_MODE: PrepMode = "first";

function isPrepMode(value: string | null): value is PrepMode {
  return value === "first" || value === "go";
}

export function getPrepMode(): PrepMode {
  try {
    const store = safeLocalStorage();
    if (!store) return DEFAULT_PREP_MODE;
    const value = store.getItem(PREP_MODE_KEY);
    return isPrepMode(value) ? value : DEFAULT_PREP_MODE;
  } catch {
    return DEFAULT_PREP_MODE;
  }
}

export function setPrepMode(mode: PrepMode): void {
  try {
    const store = safeLocalStorage();
    if (store) {
      store.setItem(PREP_MODE_KEY, mode);
      return;
    }
    localStorage.setItem(PREP_MODE_KEY, mode);
  } catch (err) {
    console.warn("Could not remember the prep mode:", err);
  }
}

export const VOICE_KEY = "sous-cook-voice";

export function getVoiceEnabled(): boolean {
  try {
    const store = safeLocalStorage();
    if (!store) return true;
    return store.getItem(VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setVoiceEnabled(on: boolean): void {
  try {
    const store = safeLocalStorage();
    if (store) {
      store.setItem(VOICE_KEY, on ? "on" : "off");
      return;
    }
    localStorage.setItem(VOICE_KEY, on ? "on" : "off");
  } catch (err) {
    console.warn("Could not remember the voice setting:", err);
  }
}
