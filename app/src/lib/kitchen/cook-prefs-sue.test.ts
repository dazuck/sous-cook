// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUE_REPLIES,
  SUE_REPLIES_EVENT,
  SUE_REPLIES_KEY,
  getSueReplies,
  nextSueReplies,
  setSueReplies,
} from "./cook-prefs";

/** Sue's replies, per device: the three settings, their default, and a page that can't keep one. */

let store: Record<string, string>;

function stubStorage() {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  });
}

beforeEach(() => {
  store = {};
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sue's replies preference", () => {
  it("is sounds until the cook chooses", () => {
    expect(getSueReplies()).toBe("sounds");
    expect(DEFAULT_SUE_REPLIES).toBe("sounds");
  });

  it("keeps each of the three and reads it back", () => {
    for (const mode of ["off", "voice", "sounds"] as const) {
      setSueReplies(mode);
      expect(store[SUE_REPLIES_KEY]).toBe(mode);
      expect(getSueReplies()).toBe(mode);
    }
  });

  it("reads anything else it finds as the default, never as off", () => {
    store[SUE_REPLIES_KEY] = "loud";
    expect(getSueReplies()).toBe("sounds");
  });

  it("goes sounds, voice, off, sounds", () => {
    expect(nextSueReplies("sounds")).toBe("voice");
    expect(nextSueReplies("voice")).toBe("off");
    expect(nextSueReplies("off")).toBe("sounds");
  });

  it("tells the page it changed", () => {
    const heard = vi.fn();
    window.addEventListener(SUE_REPLIES_EVENT, heard);
    setSueReplies("off");
    window.removeEventListener(SUE_REPLIES_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("where the browser's storage throws, it never breaks the cook: the default, and a choice kept for the page's life", () => {
    const fail = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    expect(getSueReplies()).toBe("sounds");
    expect(() => setSueReplies("off")).not.toThrow();
    expect(getSueReplies()).toBe("off");
    setSueReplies("sounds");
  });
});
