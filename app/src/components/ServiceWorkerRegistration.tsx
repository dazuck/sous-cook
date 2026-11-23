"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { installStaleChunkRecovery } from "@/lib/pwa/stale-chunk";
import { holdUpdates, isCookRoute, onIdle, updateWhenIdle } from "@/lib/pwa/update-when-idle";

/**
 * The service worker's lifecycle, for every page (slice B5b, B5.md B5–B6):
 *
 * - registers `/sw.js` under this build's id, so a deploy is a new worker
 *   (production builds only: `next dev` serves no build to keep);
 * - a new worker that has installed waits until no cook page is on screen,
 *   then is told to take over (`updateWhenIdle`), and the page reloads onto
 *   the new build. A cook route holds it from the URL, from the first
 *   render, so a reload still loading the cook isn't taken over either. A
 *   tab on a cook page when the worker changes under it (another tab applied
 *   it) keeps its page, and moves onto the new build once it leaves;
 * - recovers from a chunk that fails to load, once (`stale-chunk.ts`).
 */
export function ServiceWorkerRegistration() {
  const pathname = usePathname();

  // Declared before the registration's effect, so on a cook route the hold
  // is up before any waiting worker is offered.
  const onCookRoute = pathname !== null && isCookRoute(pathname);
  useEffect(() => {
    if (!onCookRoute) return;
    return holdUpdates();
  }, [onCookRoute]);

  useEffect(() => {
    const uninstall = installStaleChunkRecovery();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return uninstall;
    const container = navigator.serviceWorker;

    // The first worker's claim isn't an update: nothing to reload onto.
    let updating = container.controller !== null;
    const onControllerChange = () => {
      if (!updating) {
        updating = true;
        return;
      }
      // Mid-cook, the page stays on its build (the kept older cache still
      // serves its chunks) and moves onto the new one once the cook page goes.
      updateWhenIdle(() => window.location.reload());
    };
    container.addEventListener("controllerchange", onControllerChange);

    // Whatever is waiting when the moment comes is what's applied: the
    // registration is read then, not when the worker was first seen.
    let stopIdle = () => {};
    const applyWaiting = (registration: ServiceWorkerRegistration) => {
      // Only an update waits; a first worker activates by itself.
      if (registration.waiting && container.controller) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    };
    const offer = (registration: ServiceWorkerRegistration) =>
      updateWhenIdle(() => applyWaiting(registration));

    const build = process.env.SOUS_BUILD_ID ?? "dev";
    container
      .register(`/sw.js?build=${encodeURIComponent(build)}`)
      .then((registration) => {
        if (registration.waiting) offer(registration);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          const settled = () => {
            if (worker.state === "installed") offer(registration);
          };
          worker.addEventListener("statechange", settled);
          // It may have finished installing before this ran.
          settled();
        });
        // And look again each time the last cook page goes, so an install
        // whose events were missed still applies.
        stopIdle = onIdle(() => applyWaiting(registration));
      })
      .catch((error: unknown) => {
        console.error("Service Worker registration failed:", error);
      });

    return () => {
      uninstall();
      stopIdle();
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
