import { afterEach, describe, expect, it } from "vitest";
import { forgetPackFiles, loadAppPackFiles, PACKS_DIR } from "./load";
import { SHELF_SOURCES } from "./registry";

// The pack files a `pack:` queue row reads natively (slice B5d, D1; verify round 1).

afterEach(() => forgetPackFiles());

describe("loadAppPackFiles", () => {
  it("loads the registry's pack files and keeps them for the next call", async () => {
    const first = loadAppPackFiles({ packsDir: PACKS_DIR });
    const files = await first;
    expect(files.packs.map((p) => p.id)).toEqual(["fannie-farmer-1896"]);
    expect(files.libraries).not.toBeNull();
    expect(loadAppPackFiles({ packsDir: "/nowhere" })).toBe(first);
  });

  it("never throws: a packs/ that isn't there comes back with no packs and why, and isn't kept", async () => {
    const files = await loadAppPackFiles({ packsDir: "/nowhere/packs" });
    expect(files.packs).toEqual([]);
    expect(files.libraries).toBeNull();
    // Tried again next time, so a passing failure doesn't stick for the server's life.
    const again = await loadAppPackFiles({ packsDir: PACKS_DIR });
    expect(again.packs).toHaveLength(1);
  });

  it("reads only the registry's pack-file sources", async () => {
    const files = await loadAppPackFiles({ sources: SHELF_SOURCES, packsDir: PACKS_DIR });
    expect(files.errors).toEqual([]);
  });
});
