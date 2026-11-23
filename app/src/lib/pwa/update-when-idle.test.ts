import { afterEach, describe, expect, it, vi } from "vitest";
import { holdUpdates, isCookRoute, onIdle, updatesHeld, updateWhenIdle } from "./update-when-idle";

describe("isCookRoute", () => {
  it("is a queued recipe's cook page, nothing else", () => {
    expect(isCookRoute("/kitchen/queue/00000000-0000-4000-8000-000000000004")).toBe(true);
    for (const path of ["/kitchen", "/kitchen/cookpacks", "/kitchen/cookpacks/fannie", "/", "/kitchen/queue"]) {
      expect(isCookRoute(path), path).toBe(false);
    }
  });
});

// Ported from the Player's `swUpdates.test.ts` (failure mode 8): an update
// must never reload the kitchen mid-cook. Here "mid-cook" is a cook page on
// screen (B5.md E2).

const releases: (() => void)[] = [];
function hold() {
  const release = holdUpdates();
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

describe("updateWhenIdle", () => {
  it("applies immediately when no cook page is open", () => {
    const apply = vi.fn();
    updateWhenIdle(apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("holds through a cook page and applies the moment it goes", () => {
    const release = hold();
    const apply = vi.fn();
    updateWhenIdle(apply);
    expect(updatesHeld()).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    release();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(updatesHeld()).toBe(false);
  });

  it("waits for the last of two cook pages (a remount overlapping an unmount)", () => {
    const first = hold();
    const second = hold();
    const apply = vi.fn();
    updateWhenIdle(apply);
    first();
    expect(apply).not.toHaveBeenCalled();
    second();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("onIdle hears every moment the last cook page goes, until unsubscribed", () => {
    const heard = vi.fn();
    const stop = onIdle(heard);
    const a = hold();
    const b = hold();
    a();
    expect(heard).not.toHaveBeenCalled();
    b();
    expect(heard).toHaveBeenCalledTimes(1);
    hold()();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    hold()();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("applies once, not on every later idle moment, and a release is idempotent", () => {
    const release = hold();
    const apply = vi.fn();
    updateWhenIdle(apply);
    release();
    release();
    hold()();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(updatesHeld()).toBe(false);
  });
});
