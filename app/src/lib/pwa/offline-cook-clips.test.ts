// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIP_NAMES, clipUrl } from "@/lib/kitchen/ack-clips";
import { keepCookOffline } from "./offline-cook";

// What a cook page asks the service worker to keep, as far as Sue's clips go:
// a build without them asks for none, a build with them asks for every one.

let posted: { type: string; urls: string[] }[];

beforeEach(() => {
  posted = [];
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ active: { postMessage: (data: { type: string; urls: string[] }) => void posted.push(data) } }) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllEnvs();
});

async function keptPaths(): Promise<string[]> {
  keepCookOffline();
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]!.type).toBe("CACHE_URLS");
  return posted[0]!.urls.map((u) => new URL(u).pathname);
}

describe("keeping a cook page offline", () => {
  it("in a build without the clips, asks for none of them", async () => {
    const kept = await keptPaths();
    expect(kept.filter((p) => p.startsWith("/sounds/"))).toEqual([]);
    // The page itself is still kept.
    expect(kept).toContain(window.location.pathname);
  });

  it("in a build with the clips, asks for every one, whatever the setting", async () => {
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    const kept = await keptPaths();
    expect(kept.filter((p) => p.startsWith("/sounds/")).sort()).toEqual(CLIP_NAMES.map(clipUrl).sort());
  });
});
