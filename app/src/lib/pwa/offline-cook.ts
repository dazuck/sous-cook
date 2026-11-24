import { CLIP_NAMES, clipUrl } from "@/lib/kitchen/ack-clips";

/**
 * What a cook page asks of the service worker (slice B5b, E4): keep this page
 * and the files it already loaded, so a reload with no connection still draws
 * the cook. A cook opened from the kitchen is a client-side navigation, so
 * its HTML never passed through the worker; and on the first visit the page
 * loaded before the worker was there to see it.
 */

/** The same-origin files a page loaded that the worker keeps (sw.js `isBuildFile`). */
export function filesToKeep(
  pageUrl: string,
  loaded: readonly string[],
  origin: string,
): string[] {
  const keep = new Set<string>();
  const page = new URL(pageUrl);
  page.hash = "";
  keep.add(page.href);
  for (const raw of loaded) {
    let url: URL;
    try {
      url = new URL(raw, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (
      url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/fonts/") ||
      url.pathname.startsWith("/sounds/")
    ) {
      url.hash = "";
      keep.add(url.href);
    }
  }
  return [...keep];
}

/** The files an @font-face `src` names, resolved against its stylesheet. */
export function urlsInFontSrc(src: string, base: string): string[] {
  const urls: string[] = [];
  for (const match of src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    try {
      urls.push(new URL(match[2], base).href);
    } catch {
      // Not a URL: nothing to keep.
    }
  }
  return urls;
}

/**
 * The font files the page's stylesheets declare. A font a stylesheet loads
 * has no element, and the resource timings can miss it, so the faces are
 * read from the rules themselves.
 */
function declaredFonts(): string[] {
  const urls: string[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        urls.push(...urlsInFontSrc(rule.style.getPropertyValue("src"), sheet.href ?? location.href));
      }
    }
  }
  return urls;
}

/** Asks the active worker, once there is one, to keep this cook page offline. */
export function keepCookOffline(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // What the page loaded: its script and style elements (the runtime adds a
  // script element per chunk it loads), its stylesheets' fonts, and the
  // resource timings. Any one alone can miss some.
  const elements = [
    ...document.querySelectorAll<HTMLScriptElement>("script[src]"),
  ].map((s) => s.src);
  const links = [...document.querySelectorAll<HTMLLinkElement>("link[href]")]
    .filter((l) => /\b(stylesheet|preload|modulepreload)\b/.test(l.rel))
    .map((l) => l.href);
  const timed = performance.getEntriesByType("resource").map((entry) => entry.name);
  // Sue's confirmation clips are fetched only when the setting says voice, so
  // no timing may name them; the worker keeps them anyway, so choosing voice
  // with no connection still has them.
  const loaded = [...elements, ...links, ...declaredFonts(), ...timed, ...CLIP_NAMES.map(clipUrl)];
  const urls = filesToKeep(window.location.href, loaded, window.location.origin);
  navigator.serviceWorker.ready.then(
    (registration) => registration.active?.postMessage({ type: "CACHE_URLS", urls }),
    (err: unknown) => console.warn("No service worker to keep the cook offline:", err),
  );
}
