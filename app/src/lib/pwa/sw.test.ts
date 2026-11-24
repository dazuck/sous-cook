import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// public/sw.js, run for real in a sandbox with a fake worker scope: what a
// hung fetch does to the message that asked for the file to be kept.

const SOURCE = readFileSync(join(__dirname, "../../../public/sw.js"), "utf8");
const KEEP_URL = "/_next/static/chunks/never-arrives.js";

interface Scope {
  message: (data: unknown) => Promise<void>;
  fetchSignals: AbortSignal[];
  /** The paths the worker fetched to keep, in order. */
  fetched: string[];
  /** The paths it kept. */
  kept: () => string[];
}

/**
 * Loads the worker; `timeoutApi` false leaves AbortSignal without `timeout`. With `answers`, the
 * server answers each fetch, with a 404 for the paths in `missing`.
 */
function loadWorker({
  timeoutApi,
  answers = false,
  missing = [],
}: {
  timeoutApi: boolean;
  answers?: boolean;
  missing?: string[];
}): Scope {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetchSignals: AbortSignal[] = [];
  const fetched: string[] = [];
  const stored = new Map<string, Response>();
  const cache = {
    match: async (r: Request) => stored.get(r.url),
    put: async (r: Request, res: Response) => void stored.set(r.url, res),
  };
  const abortSignal: { timeout?: (ms: number) => AbortSignal } = {};
  if (timeoutApi) {
    // The same shape as the platform's, on the (fake) timers under test.
    abortSignal.timeout = (ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
      return c.signal;
    };
  }
  const self = {
    location: new URL("https://kitchen.test/sw.js?build=t"),
    addEventListener: (type: string, fn: (event: unknown) => void) => void (listeners[type] = fn),
  };
  const sandbox = {
    self,
    URL,
    Request,
    Response,
    AbortController,
    DOMException,
    AbortSignal: abortSignal,
    setTimeout,
    console,
    caches: { open: async () => cache, keys: async () => [] },
    fetch: (request: Request, init: { signal: AbortSignal }) => {
      fetchSignals.push(init.signal);
      const path = new URL(request.url).pathname;
      fetched.push(path);
      // A server that answers: a plain, same-origin file, or its 404.
      if (answers) {
        const ok = !missing.includes(path);
        return Promise.resolve({ ok, status: ok ? 200 : 404, type: "basic", redirected: false } as unknown as Response);
      }
      // A server that never answers: only the signal ends it.
      return new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      );
    },
  };
  vm.runInNewContext(SOURCE, sandbox);
  return {
    fetchSignals,
    fetched,
    kept: () => [...stored.keys()].map((u) => new URL(u).pathname),
    message: async (data) => {
      const waits: Promise<unknown>[] = [];
      listeners.message({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ["AbortSignal.timeout", true],
  ["the AbortController fallback", false],
])("keeping a file that never arrives, with %s", (_name, timeoutApi) => {
  it("abandons the fetch at the timeout, so the message's waitUntil settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = loadWorker({ timeoutApi });
    let settled = false;
    const done = scope.message({ type: "CACHE_URLS", urls: [KEEP_URL] }).then(() => void (settled = true));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await done;

    expect(settled).toBe(true);
    expect(scope.fetchSignals[0]?.aborted).toBe(true);
    // Said, not swallowed.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(KEEP_URL);
  });
});

describe("keeping Sue's clips", () => {
  it("fetches a clip under /sounds/ to keep it, and still refuses the API and other folders", async () => {
    const scope = loadWorker({ timeoutApi: true, answers: true });
    await scope.message({
      type: "CACHE_URLS",
      urls: ["/sounds/sue/flagged.mp3", "/api/trpc/x", "/private/sue.mp3"],
    });
    expect(scope.fetched).toEqual(["/sounds/sue/flagged.mp3"]);
  });

  it("keeps no clip the server doesn't have (the repository ships none), and still keeps the rest", async () => {
    const scope = loadWorker({ timeoutApi: true, answers: true, missing: ["/sounds/sue/flagged.mp3"] });
    await scope.message({ type: "CACHE_URLS", urls: ["/sounds/sue/flagged.mp3", "/sounds/sue/on-it.mp3"] });
    expect(scope.fetched).toEqual(["/sounds/sue/flagged.mp3", "/sounds/sue/on-it.mp3"]);
    expect(scope.kept()).toEqual(["/sounds/sue/on-it.mp3"]);
  });
});
