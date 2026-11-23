import { describe, expect, it } from "vitest";
import { voiceModeFor } from "./voice-mode";

const PIXEL_TABLET =
  "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** What Chrome on a large Android tablet sends when it asks for desktop sites, its default. */
const TABLET_AS_DESKTOP =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROMEBOOK =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("voiceModeFor", () => {
  it("listens on a tap on Android, where every restart chimes", () => {
    expect(voiceModeFor(PIXEL_TABLET, 10)).toBe("tap");
  });

  it("knows the tablet when it asks for desktop sites and says it is Linux", () => {
    expect(voiceModeFor(TABLET_AS_DESKTOP, 10)).toBe("tap");
  });

  it("listens all the time elsewhere", () => {
    expect(voiceModeFor(MAC_CHROME, 0)).toBe("always");
    expect(voiceModeFor(MAC_CHROME, 5)).toBe("always");
    expect(voiceModeFor(TABLET_AS_DESKTOP, 0)).toBe("always");
    expect(voiceModeFor(CHROMEBOOK, 10)).toBe("always");
    expect(voiceModeFor("", 0)).toBe("always");
  });
});
