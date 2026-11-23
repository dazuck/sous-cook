import { describe, expect, it, vi } from "vitest";

// A pack-file load that throws (an I/O error deep in the registry) reaches a
// cook as its projection, never as a page that won't open (B5d verify round 1).
vi.mock("./registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registry")>()),
  loadPackFiles: vi
    .fn()
    .mockRejectedValueOnce(new Error("EIO: i/o error, realpath"))
    .mockResolvedValue({ packs: [], errors: [], libraries: { commons: [], states: [] } }),
}));

import { loadAppPackFiles } from "./load";

describe("loadAppPackFiles when the load throws", () => {
  it("comes back with the reason and no packs, and tries again next time", async () => {
    const files = await loadAppPackFiles();
    expect(files).toEqual({
      packs: [],
      errors: [],
      libraries: null,
      loadError: "the pack files didn't load: EIO: i/o error, realpath",
    });
    // Not kept: the next call loads afresh.
    await expect(loadAppPackFiles()).resolves.toMatchObject({ libraries: { commons: [], states: [] } });
  });
});
