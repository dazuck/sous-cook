import { describe, expect, it } from "vitest";
import { fetchWithin } from "./fetch-within";

/** A server that never answers: the call ends only when its signal aborts. */
function hangs(seen: { signal?: AbortSignal | null }) {
  return (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.signal = init?.signal;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  };
}

describe("fetchWithin", () => {
  it("gives up a call that hangs once its time is out", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const started = Date.now();
    await expect(fetchWithin(30, hangs(seen))("/api/trpc/markCookActivity")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("still ends when the caller aborts first", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    const caller = new AbortController();
    const call = fetchWithin(60_000, hangs(seen))("/api/trpc/markCookActivity", { signal: caller.signal });
    caller.abort(new Error("left the page"));
    await expect(call).rejects.toThrow("left the page");
  });

  it("passes an answer through untouched", async () => {
    const answer = new Response("{}");
    const call = fetchWithin(60_000, async () => answer)("/api/trpc/markCookActivity", { method: "POST" });
    await expect(call).resolves.toBe(answer);
  });
});
