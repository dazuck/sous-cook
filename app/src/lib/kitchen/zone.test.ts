import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function zoneWith(tz: string | undefined): Promise<string> {
  vi.resetModules();
  if (tz === undefined) vi.stubEnv("NEXT_PUBLIC_KITCHEN_TZ", "");
  else vi.stubEnv("NEXT_PUBLIC_KITCHEN_TZ", tz);
  return (await import("./zone")).KITCHEN_TIME_ZONE;
}

describe("KITCHEN_TIME_ZONE", () => {
  it("is the zone the kitchen is set to", async () => {
    expect(await zoneWith("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("is the screen clock's default zone when none is set: one default for both", async () => {
    const { DEFAULT_KITCHEN_LOCATION } = await import("../ambient/location");
    expect(await zoneWith(undefined)).toBe(DEFAULT_KITCHEN_LOCATION.tz);
  });
});
