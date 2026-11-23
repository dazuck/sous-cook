/**
 * Stale-chunk recovery (slice B5b, B6; ported from the Player's
 * `pwa/staleChunkRecovery.ts`). A page whose shell is from an older build, or
 * that lost its connection while fetching a chunk, can fail to load a chunk
 * it needs; the crash reads as a broken app ("Application error"). The
 * decided behavior: one shot at recovery, saying "Updating…", then a reload.
 * A sessionStorage stamp stops a reload loop when reloading doesn't fix it;
 * it re-arms after half an hour, so a kitchen tab that lives for weeks isn't
 * one bad update away from never recovering again.
 *
 * Unlike the Player, it doesn't unregister the service worker first (B5.md
 * E5): navigations here are network-first, so a reload online already gets
 * fresh HTML, and unregistering offline would throw away the offline shell.
 */

import { safeSessionStorage } from "@/lib/persist/safe-storage";

const RECOVERY_STAMP = "sous-stale-chunk-reloaded-at";
const REARM_AFTER_MS = 30 * 60 * 1000;

/** Placeholder copy, awaiting a rewrite. */
export const UPDATING_COPY = "Updating…";

// How the browsers word a failed dynamic import (Chrome, Firefox, Safari),
// how Next's runtimes word a chunk that failed to load (Turbopack's "Failed
// to load chunk …", webpack's ChunkLoadError "Loading chunk 12 failed" and
// "Loading CSS chunk 12 failed"), and Vite's css preload (from the Player).
const STALE_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /failed to load chunk/i,
  /loading (css )?chunk [\w-]+ failed/i,
  /chunkloaderror/i,
];

export function isStaleChunkError(message: string): boolean {
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

interface RecoveryDeps {
  flags: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

/**
 * React may already be dead when a chunk fails, so the note is raw DOM with
 * inline styles: the stylesheet can be part of what failed. The colours are
 * `--ground` (Parchment) and ink from `tokens.css`; the size is DS §2's 30 cpx
 * list title at the tablet's 1 cpx = 1 px.
 */
function showUpdatingNote(): void {
  const note = document.createElement("div");
  note.setAttribute("role", "status");
  note.setAttribute("data-updating", "");
  note.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;" +
      "background:#F8F1E6;color:#2B2724;font:500 30px/1.3 Figtree,system-ui,sans-serif;",
  );
  note.textContent = UPDATING_COPY;
  document.body.append(note);
}

/** Reads a stamp; storage that throws (blocked site data) reads as none. */
function stampOf(flags: RecoveryDeps["flags"]): number {
  try {
    return flags ? Number(flags.getItem(RECOVERY_STAMP)) : NaN;
  } catch {
    return NaN;
  }
}

export function installStaleChunkRecovery(deps: Partial<RecoveryDeps> = {}): () => void {
  const flags = deps.flags !== undefined ? deps.flags : safeSessionStorage();
  const reload =
    deps.reload ??
    (() => {
      window.location.reload();
    });
  const now = deps.now ?? Date.now;
  let recovering = false;

  const recover = () => {
    if (recovering) return;
    const stampedAt = stampOf(flags);
    if (Number.isFinite(stampedAt) && stampedAt > 0 && now() - stampedAt < REARM_AFTER_MS) {
      // The last reload didn't fix it. Stop here: a reload loop is worse
      // than a visible crash.
      console.error("A chunk failed to load again after a recovery reload; not reloading.");
      return;
    }
    try {
      if (!flags) throw new Error("No session storage available");
      flags.setItem(RECOVERY_STAMP, String(now()));
    } catch (err) {
      // Without a stamp nothing could stop a loop, which is worse than the
      // visible crash: no reload.
      console.error("Could not stamp the stale-chunk recovery; not reloading:", err);
      return;
    }
    recovering = true;
    console.warn("A chunk failed to load; reloading once to recover.");
    showUpdatingNote();
    reload();
  };

  const onError = (event: ErrorEvent) => {
    const message = event.message || (event.error instanceof Error ? event.error.message : "");
    if (isStaleChunkError(message)) recover();
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: unknown; name?: unknown } | undefined | null;
    const message =
      typeof reason?.message === "string"
        ? `${typeof reason.name === "string" ? reason.name : ""} ${reason.message}`
        : String(event.reason);
    if (isStaleChunkError(message)) recover();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
