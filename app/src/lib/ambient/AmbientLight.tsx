"use client";

import { useEffect } from "react";
import { ADVANCING_ATTRIBUTE } from "./advance";
import { ambientEngine } from "./engine";
import { getAmbientForce, getKitchenPlace } from "./location";

const engine = ambientEngine();

/**
 * Ambient light component (P67).
 *
 * The first value is set before paint by the layout's <head> script (same
 * engine), so there is nothing to animate on a cold load. This component
 * keeps it current: once a minute it sets `--ambient-t`, and the :root
 * transition (tokens.css, 60 s) carries the colours there.
 *
 * While a step advance runs (`<body data-step-advancing>`), the value is
 * frozen at whatever the transition has reached and does not move; when the
 * advance ends the light resumes toward the current value.
 */
export function AmbientLight() {
  useEffect(() => {
    const root = document.documentElement;
    const place = getKitchenPlace();
    const force = getAmbientForce();
    const advancing = () => document.body.hasAttribute(ADVANCING_ATTRIBUTE);

    function update() {
      if (advancing()) return;
      root.style.setProperty("--ambient-t", engine.cssValue(new Date(), window.location.search, force, place));
    }

    function freeze() {
      // The animated value as it stands, pinned with no transition, so a
      // running 60 s ease stops where it is.
      const current = getComputedStyle(root).getPropertyValue("--ambient-t");
      root.style.transition = "none";
      root.style.setProperty("--ambient-t", current);
    }

    function resume() {
      // Commit the pinned value before the transition returns, so the ease
      // starts from where it was held.
      void getComputedStyle(root).getPropertyValue("--ambient-t");
      root.style.removeProperty("transition");
      update();
    }

    const watch = new MutationObserver(() => (advancing() ? freeze() : resume()));
    watch.observe(document.body, { attributes: true, attributeFilter: [ADVANCING_ATTRIBUTE] });

    update();
    const interval = setInterval(update, 60_000);
    return () => {
      clearInterval(interval);
      watch.disconnect();
    };
  }, []);

  return null;
}
