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
}

/** Loads the worker; `timeoutApi` false leaves AbortSignal without `timeout`. */
function loadWorker({ timeoutApi }: { timeoutApi: boolean }): Scope {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetchSignals: AbortSignal[] = [];
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
    fetch: (_request: Request, init: { signal: AbortSignal }) => {
      fetchSignals.push(init.signal);
      // A server that never answers: only the signal ends it.
      return new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      );
    },
  };
  vm.runInNewContext(SOURCE, sandbox);
  return {
    fetchSignals,
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
