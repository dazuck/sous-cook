import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PREP_MODE,
  PREP_MODE_KEY,
  VOICE_KEY,
  getPrepMode,
  getVoiceEnabled,
  setPrepMode,
  setVoiceEnabled,
} from "./cook-prefs";

function stubStorage(store: Record<string, string>) {
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

function throwingStorage() {
  const fail = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prep mode preference", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    stubStorage(store);
  });

  it("defaults to Prep first on a device that has never chosen", () => {
    expect(DEFAULT_PREP_MODE).toBe("first");
    expect(getPrepMode()).toBe("first");
  });

  it("remembers the last mode chosen", () => {
    setPrepMode("go");
    expect(store[PREP_MODE_KEY]).toBe("go");
    expect(getPrepMode()).toBe("go");
    setPrepMode("first");
    expect(getPrepMode()).toBe("first");
  });

  it("ignores a stored value that is not a mode", () => {
    store[PREP_MODE_KEY] = "sometimes";
    expect(getPrepMode()).toBe("first");
  });
});

describe("prep mode preference without storage", () => {
  it("reads the default when storage throws", () => {
    throwingStorage();
    expect(getPrepMode()).toBe("first");
  });

  it("reads the default on the server, where there is no storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(getPrepMode()).toBe("first");
  });

  it("warns and carries on when a write fails", () => {
    throwingStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => setPrepMode("go")).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "Could not remember the prep mode:",
      expect.any(DOMException),
    );
  });
});

describe("voice preference", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    stubStorage(store);
  });

  it("is on for a tablet that has never chosen", () => {
    expect(getVoiceEnabled()).toBe(true);
  });

  it("remembers turning voice off, and on again", () => {
    setVoiceEnabled(false);
    expect(store[VOICE_KEY]).toBe("off");
    expect(getVoiceEnabled()).toBe(false);
    setVoiceEnabled(true);
    expect(store[VOICE_KEY]).toBe("on");
    expect(getVoiceEnabled()).toBe(true);
  });

  it("reads anything but “off” as on", () => {
    store[VOICE_KEY] = "maybe";
    expect(getVoiceEnabled()).toBe(true);
  });

  it("reads on when storage throws or is missing", () => {
    throwingStorage();
    expect(getVoiceEnabled()).toBe(true);
    vi.stubGlobal("localStorage", undefined);
    expect(getVoiceEnabled()).toBe(true);
  });

  it("warns and carries on when a write fails", () => {
    throwingStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => setVoiceEnabled(false)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Could not remember the voice setting:", expect.any(DOMException));
  });
});

