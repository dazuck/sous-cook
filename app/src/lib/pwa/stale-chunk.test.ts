// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStaleChunkRecovery, isStaleChunkError, UPDATING_COPY } from "./stale-chunk";

// Ported from the Player's `staleChunk.test.ts` (failure mode 9): a
// stale-chunk crash gets exactly one "Updating…" reload; the sessionStorage
// stamp stops a reload loop and re-arms after half an hour. Unlike the
// Player's, it never unregisters the service worker (B5.md E5).

function makeDeps(nowMs = 1_000_000) {
  const backing = new Map<string, string>();
  return {
    flags: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    },
    reload: vi.fn(),
    now: () => nowMs,
  };
}

const uninstalls: (() => void)[] = [];

function installed<D extends ReturnType<typeof makeDeps>>(deps: D): D {
  uninstalls.push(installStaleChunkRecovery(deps));
  return deps;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const TURBOPACK =
  "Failed to load chunk /_next/static/chunks/0a1b2c3d.js from module 12345: TypeError: Failed to fetch";

function fireError(message = TURBOPACK) {
  window.dispatchEvent(new ErrorEvent("error", { message }));
}

describe("isStaleChunkError", () => {
  it("matches the browsers' failed-import wordings, Next's chunk loaders and Vite's css preload", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://kitchen.example.com/x.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/index.css",
      TURBOPACK,
      "ChunkLoadError: Loading chunk 482 failed.",
      "Loading CSS chunk 17 failed.",
    ]) {
      expect(isStaleChunkError(message), message).toBe(true);
    }
  });

  it("leaves ordinary errors alone", () => {
    expect(isStaleChunkError("Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isStaleChunkError("Failed to fetch")).toBe(false);
  });
});

describe("installStaleChunkRecovery", () => {
  it("a stale-chunk error says Updating and reloads once", () => {
    const deps = installed(makeDeps());
    fireError();
    fireError();
    expect(document.body.textContent).toContain(UPDATING_COPY);
    expect(document.querySelector("[data-updating]")?.getAttribute("role")).toBe("status");
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("a failed dynamic import surfacing as a rejection recovers too, by its error's name", () => {
    const deps = installed(makeDeps());
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    const err = new Error("Loading chunk 9 failed.");
    err.name = "ChunkLoadError";
    event.reason = err;
    window.dispatchEvent(event);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("a second crash after a fresh reload stops: no loop", () => {
    const first = installed(makeDeps(1_000_000));
    fireError();
    expect(first.reload).toHaveBeenCalledTimes(1);
    for (const uninstall of uninstalls.splice(0)) uninstall();
    document.body.innerHTML = "";

    // The reload lands on the same broken page a minute later.
    const second = installed({ ...makeDeps(1_060_000), flags: first.flags });
    fireError();
    expect(document.body.textContent).not.toContain(UPDATING_COPY);
    expect(second.reload).not.toHaveBeenCalled();
  });

  it("the stamp re-arms after half an hour: a later bad deploy gets its own shot", () => {
    const first = installed(makeDeps(1_000_000));
    fireError();
    for (const uninstall of uninstalls.splice(0)) uninstall();

    const later = installed({ ...makeDeps(1_000_000 + 31 * 60 * 1000), flags: first.flags });
    fireError();
    expect(later.reload).toHaveBeenCalledTimes(1);
  });

  it("storage that refuses the stamp: no reload, since nothing could stop a loop", () => {
    const deps = installed({
      ...makeDeps(),
      flags: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    });
    fireError();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("ordinary errors never trigger it", () => {
    const deps = installed(makeDeps());
    fireError("boom");
    expect(deps.reload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(UPDATING_COPY);
  });
});
