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
import { FORGET_MARKER_KEY } from "@/lib/auth/device";
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

async function loadFreshKitchenModules() {
  vi.resetModules();
  const [
    { QueryClient, QueryClientProvider },
    { default: FreshKitchenSectionLayout },
    {
      SignInModeProvider: FreshSignInModeProvider,
      useSignInMode: freshUseSignInMode,
    },
    { reportOutbox: freshReportOutbox },
    { timerStore: freshTimerStore },
  ] = await Promise.all([
    import("@tanstack/react-query"),
    import("./layout"),
    import("@/components/kitchen/SignInMode"),
    import("@/hooks/useReportOutbox"),
    import("@/lib/kitchen/timer-store"),
  ]);

  function FreshModeReader() {
    const signInMode = freshUseSignInMode();
    return <div data-testid="sign-in-mode">{String(signInMode)}</div>;
  }

  return {
    QueryClient,
    QueryClientProvider,
    KitchenSectionLayout: FreshKitchenSectionLayout,
    SignInModeProvider: FreshSignInModeProvider,
    ModeReader: FreshModeReader,
    reportOutbox: freshReportOutbox,
    timerStore: freshTimerStore,
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  storageWindow = new Window({ url: "https://app.example.com/kitchen" });
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("Failed to fetch"),
  );
  window.localStorage.clear();
  window.sessionStorage.clear();
  setSignInCookie(false);
  timerStore.reload();
});

afterEach(async () => {
  vi.useRealTimers();
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
  it("empties sessionStorage and reloads on localStorage clear, ignores other keys and areas, and reloads without clearing on persisted pageshow", async () => {
    setSignInCookie(true);
    const {
      SignInModeProvider: FreshSignInModeProvider,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
    } = await loadFreshKitchenModules();
    const reload = vi.fn();

    render(
      <FreshSignInModeProvider reload={reload}>
        <FreshModeReader />
      </FreshSignInModeProvider>,
    );

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageClear(window.localStorage);
    expect(window.sessionStorage.length).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    dispatchStorageKey("sous-feedback", window.localStorage);
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);

    dispatchStorageKey(FORGET_MARKER_KEY, window.localStorage);
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
    expect(freshReportOutbox().list()).toEqual([]);
  });

  it("leaves outbox, timers, rendered child, and query cache untouched in single-kitchen mode", async () => {
    setSignInCookie(false);
    const {
      QueryClient,
      QueryClientProvider,
      SignInModeProvider: FreshSignInModeProvider,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
      timerStore: freshTimerStore,
    } = await loadFreshKitchenModules();
    const reload = vi.fn();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["kitchen", "queue"], [{ id: "q1" }]);

    const outbox = freshReportOutbox();
    const captured = makeReport();
    await expect(outbox.add(captured)).resolves.toBe("flagged");
    await outbox.flush();

    freshTimerStore.start(
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

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <FreshSignInModeProvider reload={reload}>
            <FreshModeReader />
          </FreshSignInModeProvider>
        </QueryClientProvider>,
      );

      window.sessionStorage.setItem("sous.cook-scale.q1", "2");
      window.localStorage.clear();
      dispatchStorageClear(window.localStorage);
      dispatchStorageKey("sous-feedback", window.localStorage);
      dispatchPageShow(true);
      dispatchPageShow(false);

      expect(reload).not.toHaveBeenCalled();
      expect(outbox.list().map((entry) => entry.id)).toEqual([captured.id]);
      expect(freshTimerStore.getSnapshot().map((timer) => timer.id)).toEqual([
        "timer-simmer",
      ]);
      expect(screen.getByTestId("sign-in-mode").textContent).toBe("false");
      expect(queryClient.getQueryData(["kitchen", "queue"])).toEqual([
        { id: "q1" },
      ]);
      expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    } finally {
      outbox.forget();
      freshTimerStore.reload();
      queryClient.clear();
    }
    expect(outbox.list()).toEqual([]);
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

  it("empties outbox and timers, unmounts children, stops write-backs, and reloads the real kitchen layout on clear", async () => {
    vi.useFakeTimers();
    setSignInCookie(true);
    const {
      KitchenSectionLayout: FreshKitchenSectionLayout,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
      timerStore: freshTimerStore,
    } = await loadFreshKitchenModules();
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});

    const outbox = freshReportOutbox();
    const captured = makeReport();
    await expect(outbox.add(captured)).resolves.toBe("flagged");
    await outbox.flush();
    expect(
      outbox.list().find((entry) => entry.id === captured.id)?.status,
    ).toBe("waiting");

    freshTimerStore.start(
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
    expect(freshTimerStore.getSnapshot()).toHaveLength(1);

    const { unmount } = render(
      <FreshKitchenSectionLayout>
        <FreshModeReader />
      </FreshKitchenSectionLayout>,
    );
    expect(screen.getByTestId("sign-in-mode").textContent).toBe("true");

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    window.localStorage.clear();
    dispatchStorageClear(window.localStorage);

    expect(outbox.list()).toEqual([]);
    expect(freshTimerStore.getSnapshot()).toEqual([]);
    expect(screen.queryByTestId("sign-in-mode")).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);

    outbox.annotate(captured.id, "written after clear");
    await expect(outbox.add(makeReport())).resolves.toBe("failed");
    expect(window.localStorage.getItem("sous-feedback")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(window.localStorage.getItem("sous-chimer")).toBeNull();
    expect(window.localStorage.getItem("sous-timers")).toBeNull();

    unmount();
    expect(outbox.list()).toEqual([]);
  });

  it("writes nothing and makes no second send when an in-flight outbox request settles after clear", async () => {
    setSignInCookie(true);
    const {
      KitchenSectionLayout: FreshKitchenSectionLayout,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
    } = await loadFreshKitchenModules();
    const reloadSpy = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});

    let fetchCalls = 0;
    let resolveFirst: (response: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      fetchCalls += 1;
      return new Promise<Response>((resolve) => {
        if (fetchCalls === 1) {
          resolveFirst = resolve;
        }
      });
    });

    const outbox = freshReportOutbox();
    const first = makeReport();
    const second = makeReport();
    await expect(outbox.add(first)).resolves.toBe("flagged");
    await settleMicrotasks();
    await expect(outbox.add(second)).resolves.toBe("flagged");
    expect(fetchCalls).toBe(1);

    const { unmount } = render(
      <FreshKitchenSectionLayout>
        <FreshModeReader />
      </FreshKitchenSectionLayout>,
    );

    window.localStorage.clear();
    dispatchStorageClear(window.localStorage);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    resolveFirst(
      new Response(
        JSON.stringify({ result: { data: { id: first.id, duplicate: false } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await settleMicrotasks();

    expect(window.localStorage.getItem("sous-feedback")).toBeNull();
    expect(fetchCalls).toBe(1);
    expect(outbox.list()).toEqual([]);

    unmount();
  });

  it("clears the real QueryClient cache on cross-tab clear", async () => {
    setSignInCookie(true);
    const {
      QueryClient,
      QueryClientProvider,
      SignInModeProvider: FreshSignInModeProvider,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
    } = await loadFreshKitchenModules();
    const reload = vi.fn();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["kitchen", "queue"], [{ id: "q1" }]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    render(
      <QueryClientProvider client={queryClient}>
        <FreshSignInModeProvider reload={reload}>
          <FreshModeReader />
        </FreshSignInModeProvider>
      </QueryClientProvider>,
    );

    window.localStorage.clear();
    dispatchStorageClear(window.localStorage);

    expect(queryClient.getQueryData(["kitchen", "queue"])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(freshReportOutbox().list()).toEqual([]);
  });

  it("runs the same preparation on persisted pageshow while keeping sessionStorage", async () => {
    setSignInCookie(true);
    const {
      QueryClient,
      QueryClientProvider,
      SignInModeProvider: FreshSignInModeProvider,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
      timerStore: freshTimerStore,
    } = await loadFreshKitchenModules();
    const reload = vi.fn();
    const queryClient = new QueryClient();
    queryClient.setQueryData(["kitchen", "queue"], [{ id: "q1" }]);

    const outbox = freshReportOutbox();
    await expect(outbox.add(makeReport())).resolves.toBe("flagged");
    await outbox.flush();
    expect(outbox.list()).toHaveLength(1);

    freshTimerStore.start(
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
    expect(freshTimerStore.getSnapshot()).toHaveLength(1);

    render(
      <QueryClientProvider client={queryClient}>
        <FreshSignInModeProvider reload={reload}>
          <FreshModeReader />
        </FreshSignInModeProvider>
      </QueryClientProvider>,
    );

    window.sessionStorage.setItem("sous.cook-scale.q1", "2");
    window.localStorage.clear();
    dispatchPageShow(true);

    expect(outbox.list()).toEqual([]);
    expect(freshTimerStore.getSnapshot()).toEqual([]);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(screen.queryByTestId("sign-in-mode")).toBeNull();
    expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("skips clearing sessionStorage on SecurityError and still reloads", async () => {
    setSignInCookie(true);
    const {
      SignInModeProvider: FreshSignInModeProvider,
      ModeReader: FreshModeReader,
      reportOutbox: freshReportOutbox,
    } = await loadFreshKitchenModules();
    const reload = vi.fn();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    render(
      <FreshSignInModeProvider reload={reload}>
        <FreshModeReader />
      </FreshSignInModeProvider>,
    );

    expect(() => dispatchStorageClear(window.localStorage)).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(freshReportOutbox().list()).toEqual([]);
  });
});
