"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { safeLocalStorage } from "@/lib/persist/safe-storage";
import { ACTION, ACTION_AT_REST, FOCUS } from "./control-style";
import { LABEL } from "./KitchenHome";

export const ABOUT_PROMPT_DISMISSED_KEY = "sous-cook-about-prompt-dismissed";

const listeners = new Set<() => void>();
let fallbackDismissed = false;

function subscribeAboutPrompt(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(onStoreChange);
    };
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ABOUT_PROMPT_DISMISSED_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getAboutPromptDismissedSnapshot(): boolean {
  try {
    const store = safeLocalStorage();
    if (!store) return fallbackDismissed;
    return fallbackDismissed || store.getItem(ABOUT_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return fallbackDismissed;
  }
}

function getAboutPromptServerSnapshot(): boolean {
  return true;
}

export function useAboutPromptDismissed(): [boolean, () => void] {
  const dismissed = useSyncExternalStore(
    subscribeAboutPrompt,
    getAboutPromptDismissedSnapshot,
    getAboutPromptServerSnapshot,
  );
  const dismiss = () => {
    try {
      const store = safeLocalStorage();
      if (store) {
        store.setItem(ABOUT_PROMPT_DISMISSED_KEY, "1");
      } else {
        fallbackDismissed = true;
      }
    } catch {
      fallbackDismissed = true;
    }
    for (const listener of listeners) {
      listener();
    }
  };
  return [dismissed, dismiss];
}

export const FIRST_RUN_ABOUT_COPY = {
  heading: "Tell Sous about your kitchen",
  body: "Add who eats here, allergies, or what you avoid so Ask Sous keeps it in mind.",
  cta: "Add kitchen notes",
  dismiss: "Not now",
} as const;

interface FirstRunAboutCardProps {
  onDismiss: () => void;
}

/**
 * Calm inline first-run card shown at rest on `/kitchen` in sign-in mode when
 * the kitchen has no saved "About my kitchen" note yet and hasn't dismissed it.
 */
export function FirstRunAboutCard({ onDismiss }: FirstRunAboutCardProps) {
  return (
    <section
      data-first-run-about
      aria-label={FIRST_RUN_ABOUT_COPY.heading}
      className="mt-[var(--space-4)] w-full max-w-[calc(760*var(--cpx))] rounded-[var(--radius-2)] border border-ink/[.14] bg-paper px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
        <div className="min-w-0 flex-1">
          <h2 className="text-[length:var(--type-meta)] font-semibold text-ink">
            {FIRST_RUN_ABOUT_COPY.heading}
          </h2>
          <p className={`mt-[calc(2*var(--cpx))] ${LABEL} leading-[1.35]`}>
            {FIRST_RUN_ABOUT_COPY.body}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-[var(--space-2)]">
          <Link
            href="/kitchen/settings#about"
            className={`inline-flex min-h-[var(--target)] items-center rounded-[var(--radius-1)] px-[calc(10*var(--cpx))] text-[length:var(--type-meta)] font-semibold text-ember-700 underline decoration-ember-700/[.4] underline-offset-[calc(6*var(--cpx))] active:bg-sand ${FOCUS}`}
          >
            {FIRST_RUN_ABOUT_COPY.cta}
          </Link>
          <button
            type="button"
            data-first-run-about-dismiss
            onClick={onDismiss}
            className={`${ACTION} ${ACTION_AT_REST}`}
          >
            {FIRST_RUN_ABOUT_COPY.dismiss}
          </button>
        </div>
      </div>
    </section>
  );
}
