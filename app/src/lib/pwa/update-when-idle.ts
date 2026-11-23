/**
 * An update never applies mid-cook (slice B5b, B6; ported from the Player's
 * `pwa/swUpdates.ts`). A new service worker waits while this tab shows a cook
 * page, and applies the moment it leaves one, or at once when none is open.
 *
 * "Mid-cook" is a cook page on screen, not a kept session (B5.md E2): an
 * abandoned cook keeps its session for days, which would hold every update,
 * and a reload resumes from the session anyway. What an update must not do is
 * reload the page the cook is reading.
 */

/**
 * A cook page's route. The hold is taken from the URL as well as from the
 * mounted cook (fix round 1, item 5): a reload spends a while loading before
 * the cook view mounts, and an update that applied then would reload it.
 */
export function isCookRoute(pathname: string): boolean {
  return pathname.startsWith("/kitchen/queue/");
}

let held = 0;
const waiting = new Set<() => void>();
const idleListeners = new Set<() => void>();

/**
 * Hear every moment the last cook page goes, not once, so the registration
 * can be looked at again then: whatever is waiting at that moment is what
 * applies, whether or not its install was seen. Returns the unsubscribe.
 */
export function onIdle(listener: () => void): () => void {
  idleListeners.add(listener);
  return () => {
    idleListeners.delete(listener);
  };
}

/** A cook page is on screen: hold updates until the returned release. */
export function holdUpdates(): () => void {
  held += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held -= 1;
    if (held === 0) {
      const ready = [...waiting];
      waiting.clear();
      for (const apply of ready) apply();
      for (const listener of [...idleListeners]) listener();
    }
  };
}

/** Whether a cook page is on screen. */
export function updatesHeld(): boolean {
  return held > 0;
}

/**
 * Runs `apply` now when no cook page is on screen, else once the last one
 * goes. Applies once, never again on a later idle moment.
 */
export function updateWhenIdle(apply: () => void): void {
  if (held === 0) {
    apply();
    return;
  }
  waiting.add(apply);
}
