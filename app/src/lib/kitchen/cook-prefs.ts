/**
 * Cook-view preferences, per device, in localStorage: the prep mode the cook
 * last chose, and whether voice is on (it is unless turned off).
 *
 * Storage can be missing (the server) or throw (private browsing, blocked site
 * data). A preference is a convenience, so reads then give the default and a
 * failed write is logged; the cook view never breaks over one.
 */

import { safeLocalStorage } from "@/lib/persist/safe-storage";
import { sueClipsShipped } from "./ack-clips";
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

/**
 * Sue's replies, per device (DESIGN_SYSTEM §4, "Sue acknowledges"): what she
 * answers a spoken command with. `off` is silence, `sounds` a soft sound for
 * a command understood and a lower one for one that wasn't, `voice` those and
 * a rare spoken confirmation on top. A device that never chose has `sounds`.
 * A build without the clips (`sueClipsShipped`) never offers `voice`, and a
 * device that chose it under a build that had them reads `sounds`.
 */
export type SueReplies = "off" | "sounds" | "voice";
export const SUE_REPLIES_KEY = "sous-sue-replies";
export const DEFAULT_SUE_REPLIES: SueReplies = "sounds";
/** Fired on the window when this page changes the setting, so every reader of it follows. */
export const SUE_REPLIES_EVENT = "sous-sue-replies-changed";

export function isSueReplies(value: unknown): value is SueReplies {
  return value === "off" || value === "sounds" || value === "voice";
}

/** The setting a press moves to: sounds, then voice (when the build has the clips), then off, then sounds again. */
export function nextSueReplies(now: SueReplies): SueReplies {
  if (now === "sounds") return sueClipsShipped() ? "voice" : "off";
  return now === "voice" ? "off" : "sounds";
}

/** What a stored choice means in this build: `voice` without the clips is `sounds`, quietly. */
function offered(value: SueReplies): SueReplies {
  return value === "voice" && !sueClipsShipped() ? "sounds" : value;
}

export function getSueReplies(): SueReplies {
  try {
    const store = safeLocalStorage();
    if (!store) return DEFAULT_SUE_REPLIES;
    const value = store.getItem(SUE_REPLIES_KEY);
    return isSueReplies(value) ? offered(value) : DEFAULT_SUE_REPLIES;
  } catch {
    return DEFAULT_SUE_REPLIES;
  }
}

export function setSueReplies(mode: SueReplies): void {
  try {
    const store = safeLocalStorage();
    if (store) store.setItem(SUE_REPLIES_KEY, mode);
    else localStorage.setItem(SUE_REPLIES_KEY, mode);
  } catch (err) {
    console.warn("Could not remember Sue's replies setting:", err);
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SUE_REPLIES_EVENT));
}
