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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A build with every clip, as `next.config.ts` marks one (`ack-clips-build.ts`). */
const withClips = () => vi.stubEnv("SOUS_SUE_CLIPS", "1");

describe("Sue's replies preference", () => {
  it("is sounds until the cook chooses", () => {
    expect(getSueReplies()).toBe("sounds");
    expect(DEFAULT_SUE_REPLIES).toBe("sounds");
  });

  it("with the clips in the build, keeps each of the three and reads it back", () => {
    withClips();
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

  it("with the clips in the build, goes sounds, voice, off, sounds", () => {
    withClips();
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

describe("Sue's replies in a build without the clips (as this repository ships)", () => {
  it("never offers voice: a press goes sounds, off, sounds", () => {
    expect(nextSueReplies("sounds")).toBe("off");
    expect(nextSueReplies("off")).toBe("sounds");
    // A page still showing voice from before moves on as it would have.
    expect(nextSueReplies("voice")).toBe("off");
  });

  it("reads a stored voice, chosen under a build that had them, as sounds, and says nothing about it", () => {
    const said = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    store[SUE_REPLIES_KEY] = "voice";
    expect(getSueReplies()).toBe("sounds");
    // The device's choice is left as it was, for a later build that has the clips.
    expect(store[SUE_REPLIES_KEY]).toBe("voice");
    for (const spy of said) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps off and sounds as ever", () => {
    for (const mode of ["off", "sounds"] as const) {
      setSueReplies(mode);
      expect(getSueReplies()).toBe(mode);
    }
  });
});
