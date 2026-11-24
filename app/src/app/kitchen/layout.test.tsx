// @vitest-environment happy-dom
import { randomUUID } from "node:crypto";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/app/providers";
import {
  SignInModeProvider,
  useSignInMode,
} from "@/components/kitchen/SignInMode";
import { reportOutbox } from "@/hooks/useReportOutbox";
import type { CookReport } from "@/lib/kitchen/report-capture";
import { timerStore } from "@/lib/kitchen/timer-store";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import KitchenSectionLayout from "./layout";

let storageWindow: Window | null = null;

function setSignInCookie(enabled: boolean): void {
  if (enabled) {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
  } else {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function ModeReader() {
  const signInMode = useSignInMode();
  return <div data-testid="sign-in-mode">{String(signInMode)}</div>;
}

function dispatchStorageClear(storageArea: Storage | null = window.localStorage): void {
  const event = new StorageEvent("storage", { key: null });
  Object.defineProperty(event, "storageArea", {
    value: storageArea,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

function dispatchStorageKey(
  key: string,
  storageArea: Storage | null = window.localStorage,
): void {
  const event = new StorageEvent("storage", { key });
  Object.defineProperty(event, "storageArea", {
    value: storageArea,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

function dispatchPageShow(persisted: boolean): void {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", {
    value: persisted,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

function makeReport(): CookReport {
  return {
    id: randomUUID(),
    capturedAt: "2026-10-04T10:00:00.000Z",
    build: "b-1",
    path: "/kitchen/queue/q1",
    screen: "step",
    queueId: null,
    recipeName: "Mole",
    stepKey: "s1",
    chapterId: null,
    planVersion: 4,
    plan: null,
    state: { mode: "go", pos: 1, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: null, status: "unsupported" },
      ask: { sessionId: "cook-queue-1", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: [
      {
        at: "2026-10-04T09:59:59.000Z",
        kind: "step",
        detail: "next -> 1",
      },
    ],
    dom: '<div id="root"></div>',
    domTruncated: false,
    note: "",
  };
}

beforeEach(() => {
  storageWindow = new Window({ url: "https://app.example.com/kitchen" });
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  window.localStorage.clear();
  window.sessionStorage.clear();
  setSignInCookie(false);
  timerStore.reload();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setSignInCookie(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
  timerStore.reload();
  if (storageWindow) {
    await storageWindow.happyDOM.close();
    storageWindow = null;
  }
  vi.unstubAllGlobals();
});

describe("LAYOUT-1: KitchenSectionLayout provides sign-in mode and starts the report outbox", () => {
  it("reads true after mount when the sign-in cookie is set and false when absent", () => {
    setSignInCookie(true);
    const { unmount } = render(
      <KitchenSectionLayout>
        <ModeReader />
      </KitchenSectionLayout>,
    );
    expect(screen.getByTestId("sign-in-mode").textContent).toBe("true");
    unmount();

    setSignInCookie(false);
    render(
      <KitchenSectionLayout>
        <ModeReader />
      </KitchenSectionLayout>,
    );
    expect(screen.getByTestId("sign-in-mode").textContent).toBe("false");
  });

  it("renders false during server HTML generation even when the sign-in cookie is set", () => {
    setSignInCookie(true);
    const html = renderToString(
      <SignInModeProvider>
        <ModeReader />
      </SignInModeProvider>,
    );
    expect(html).toContain(">false<");
  });

  it("starts the report outbox once when KitchenSectionLayout mounts and not when Providers mounts alone", () => {
    const startSpy = vi.spyOn(reportOutbox(), "start");

    const providersView = render(
      <Providers>
        <div>root child</div>
      </Providers>,
    );
    expect(startSpy).not.toHaveBeenCalled();
    providersView.unmount();

    render(
      <KitchenSectionLayout>
        <ModeReader />
      </KitchenSectionLayout>,
    );
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe("LAYOUT-2: SignInModeProvider reloads on cross-tab storage clear and bfcache restore", () => {
  it("empties sessionStorage and reloads on localStorage clear, ignores other keys and areas, and reloads without clearing on persisted pageshow", () => {
    setSignInCookie(true);
    const reload = vi.fn();

    render(
      <SignInModeProvider reload={reload}>
        <ModeReader />
      </SignInModeProvider>,
    );

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageClear(window.localStorage);
    expect(window.sessionStorage.length).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageKey("sous-feedback", window.localStorage);
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);

    dispatchStorageClear(window.sessionStorage);
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);

    dispatchPageShow(true);
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(2);

    dispatchPageShow(false);
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("installs no listeners when the sign-in cookie is absent", () => {
    setSignInCookie(false);
    const reload = vi.fn();

    render(
      <SignInModeProvider reload={reload}>
        <ModeReader />
      </SignInModeProvider>,
    );

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageClear(window.localStorage);
    dispatchStorageKey("sous-feedback", window.localStorage);
    dispatchPageShow(true);
    dispatchPageShow(false);

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
  });

  it("removes listeners on unmount", () => {
    setSignInCookie(true);
    const reload = vi.fn();

    const { unmount } = render(
      <SignInModeProvider reload={reload}>
        <ModeReader />
      </SignInModeProvider>,
    );
    unmount();

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageClear(window.localStorage);
    dispatchPageShow(true);

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
  });

  it("reloads the real kitchen layout when another tab clears localStorage while a report waits and a timer runs", async () => {
    setSignInCookie(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});

    const outbox = reportOutbox();
    const captured = makeReport();
    await expect(outbox.add(captured)).resolves.toBe("flagged");
    await outbox.flush();
    expect(
      outbox.list().find((entry) => entry.id === captured.id)?.status,
    ).toBe("waiting");

    timerStore.start(
      {
        id: "timer-simmer",
        queueId: "q1",
        recipeName: "Mole",
        stepId: "s1",
        label: "Simmer",
        durationMs: 60_000,
      },
      Date.now(),
    );
    expect(timerStore.getSnapshot()).toHaveLength(1);

    const { unmount } = render(
      <KitchenSectionLayout>
        <ModeReader />
      </KitchenSectionLayout>,
    );
    expect(screen.getByTestId("sign-in-mode").textContent).toBe("true");

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    window.localStorage.clear();
    dispatchStorageClear(window.localStorage);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);

    unmount();
    timerStore.dismiss("timer-simmer");
  });

  it("skips clearing sessionStorage on SecurityError and still reloads", () => {
    setSignInCookie(true);
    const reload = vi.fn();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(
      <SignInModeProvider reload={reload}>
        <ModeReader />
      </SignInModeProvider>,
    );

    expect(() => dispatchStorageClear(window.localStorage)).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
