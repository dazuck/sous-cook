// @vitest-environment happy-dom
import { TRPCClientError } from "@trpc/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookReport } from "@/lib/kitchen/report-capture";
import {
  createReportOutbox,
  type ReportOutbox,
  type StringStore,
} from "@/lib/kitchen/report-outbox";
import { SIGN_IN_MODE_COOKIE } from "@/lib/kitchens/mode";
import { HomeRail } from "./HomeRail";
import { CLEAR_ARM_MS } from "./ShoppingListModal";
import { SignInModeProvider } from "./SignInMode";
import * as signOutModule from "./SignOutItem";
import { SIGN_OUT_COPY } from "./SignOutItem";

let storageWindow: Window | null = null;
let recordedRequests: Array<{ method: string; url: string }> = [];
let signOutResponder: () => Promise<Response>;
let replaceSpy: ReturnType<typeof vi.spyOn>;
let assignSpy: ReturnType<typeof vi.spyOn>;

function setSignInCookie(enabled: boolean): void {
  if (enabled) {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=1; path=/`;
  } else {
    document.cookie = `${SIGN_IN_MODE_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function requestPath(url: string): string {
  return new URL(url, window.location.href).pathname;
}

function signOutPostCount(): number {
  return recordedRequests.filter(
    (req) =>
      req.method.toUpperCase() === "POST" &&
      requestPath(req.url).endsWith("/api/auth/sign-out"),
  ).length;
}

function makeRailProps() {
  return {
    cookpacks: "Cookpacks",
    word: null,
    onOpenQueue: vi.fn(),
    onOpenImport: vi.fn(),
    onOpenAddIngredients: vi.fn(),
    onOpenShoppingList: vi.fn(),
    onOpenSaved: vi.fn(),
    onOpenAsk: vi.fn(),
    addIngredientsLabel: "Add ingredients",
  };
}

function openRailMenu(): void {
  const handle = document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  expect(handle).not.toBeNull();
  fireEvent.click(handle!);
}

function memoryStore(): StringStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

type Answer = "ok" | "offline" | "refused";

function answerOutbox(how: Answer): Promise<unknown> {
  if (how === "ok") return Promise.resolve();
  if (how === "offline") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.reject(
    TRPCClientError.from({
      error: {
        code: -32600,
        message: "BAD_REQUEST",
        data: { code: "BAD_REQUEST", httpStatus: 400 },
      },
    }),
  );
}

function makeReport(id: string, capturedAt: string): CookReport {
  return {
    id,
    capturedAt,
    build: "b-1",
    path: "/kitchen/queue/q1",
    screen: "step",
    queueId: null,
    recipeName: "Lemon Soup",
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
    events: [],
    dom: "<div></div>",
    domTruncated: false,
    note: "",
  };
}

function createControlledOutbox() {
  const submits: Record<string, Answer> = {};
  const annotates: Record<string, Answer> = {};
  const outbox = createReportOutbox(memoryStore(), {
    submit: (report) => answerOutbox(submits[report.id] ?? "ok"),
    annotate: (id) => answerOutbox(annotates[id] ?? "ok"),
  });
  return { outbox, submits, annotates };
}

/** Sign out as the rail's panel draws it, from the given module: the row in a menu, the status outside it. */
function SignOutMenu({
  from,
  outbox,
}: {
  from: typeof signOutModule;
  outbox: () => ReportOutbox;
}) {
  const { SignOutScope, SignOutRow, SignOutStatus } = from;
  return (
    <SignOutScope outbox={outbox}>
      <div role="menu">
        <SignOutRow rowClassName="tab-row" />
      </div>
      <SignOutStatus className="status-line" />
    </SignOutScope>
  );
}

/** The status line once a reason is in it: its live region stands empty from the menu's opening. */
async function failureStatus(): Promise<HTMLElement> {
  return waitFor(() => {
    const status = screen.getByRole("status");
    expect(status.textContent).not.toBe("");
    return status;
  });
}

function renderSignOutStandalone(outbox: ReportOutbox) {
  return render(
    <SignInModeProvider>
      <SignOutMenu from={signOutModule} outbox={() => outbox} />
    </SignInModeProvider>,
  );
}

beforeEach(() => {
  storageWindow = new Window({ url: "https://app.example.com/kitchen" });
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  window.localStorage.clear();
  window.sessionStorage.clear();
  setSignInCookie(false);

  recordedRequests = [];
  signOutResponder = async () =>
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const stubFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    recordedRequests.push({ method, url });

    const path = requestPath(url);
    if (path.startsWith("/api/trpc")) {
      throw new TypeError("Failed to fetch");
    }
    if (method.toUpperCase() === "POST" && path.endsWith("/api/auth/sign-out")) {
      return signOutResponder();
    }
    throw new TypeError(`Unexpected request: ${method} ${url}`);
  };
  vi.stubGlobal("fetch", stubFetch);

  replaceSpy = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  assignSpy = vi
    .spyOn(window.location, "assign")
    .mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSignInCookie(false);
  if (storageWindow) {
    await storageWindow.happyDOM.close();
    storageWindow = null;
  }
  vi.unstubAllGlobals();
});

describe("SIGNOUT-1: Sign out in the kitchen home rail menu", () => {
  it("a. shows Sign out last in sign-in mode and matches bare HomeRail when the cookie is absent", () => {
    setSignInCookie(true);
    const signedInView = render(
      <SignInModeProvider>
        <HomeRail {...makeRailProps()} />
      </SignInModeProvider>,
    );
    openRailMenu();
    const signedInNames = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(signedInNames.at(-1)).toBe(SIGN_OUT_COPY.item);
    // Drawn as the panel's other rows are: its words, then its glyph in the rail's column.
    const signOutRow = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    expect(signOutRow.firstElementChild?.textContent).toBe(SIGN_OUT_COPY.item);
    expect(signOutRow.lastElementChild?.querySelector("svg")).toBeTruthy();
    signedInView.unmount();

    setSignInCookie(false);
    const singleModeView = render(
      <SignInModeProvider>
        <HomeRail {...makeRailProps()} />
      </SignInModeProvider>,
    );
    openRailMenu();
    const singleModeNames = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(singleModeNames).not.toContain(SIGN_OUT_COPY.item);
    singleModeView.unmount();

    render(<HomeRail {...makeRailProps()} />);
    openRailMenu();
    const bareNames = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(singleModeNames).toEqual(bareNames);
    expect(bareNames).toContain("Add ingredients");
    expect(bareNames).toContain("Shopping list");
    expect(bareNames).toContain("Saved for later");
    expect(
      document.querySelectorAll('nav[aria-label="Kitchen shortcuts"] > *'),
    ).toHaveLength(3); // Cookpacks, Import recipe, More handle (word is null)
  });

  it("b. shows the refused message, keeps the menu open, and keeps storage intact on a 500 response", async () => {
    setSignInCookie(true);
    window.localStorage.setItem("sous-keep", "value");
    signOutResponder = async () =>
      new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" },
      });

    render(
      <SignInModeProvider>
        <HomeRail {...makeRailProps()} />
      </SignInModeProvider>,
    );
    openRailMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item }));

    const status = await failureStatus();
    expect(status.textContent).toBe(SIGN_OUT_COPY.refused);
    // The line is the panel's, under the rows: a menu holds only rows you can choose, and the row keeps its name.
    expect(status.closest('[role="menu"]')).toBeNull();
    expect(status.closest("[data-rail-tab]")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item }).textContent).toBe(SIGN_OUT_COPY.item);
    expect(Array.from(screen.getByRole("menu").children).every((c) => c.getAttribute("role") === "menuitem")).toBe(true);
    // Closed and opened again, the panel starts over: Sign out, and nothing in the line.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu")).toBeNull();
    openRailMenu();
    expect(screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(signOutPostCount()).toBe(1);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("sous-keep")).toBe("value");
  });

  it("c. shows the network message and keeps storage intact when fetch rejects", async () => {
    setSignInCookie(true);
    window.localStorage.setItem("sous-keep", "value");
    signOutResponder = async () => {
      throw new TypeError("Failed to fetch");
    };

    render(
      <SignInModeProvider>
        <HomeRail {...makeRailProps()} />
      </SignInModeProvider>,
    );
    openRailMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item }));

    const status = await failureStatus();
    expect(status.textContent).toBe(SIGN_OUT_COPY.network);
    expect(signOutPostCount()).toBe(1);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("sous-keep")).toBe("value");
  });

  it("d. empties storage and replaces location with /sign-in on a confirmed sign-out", async () => {
    setSignInCookie(true);
    window.localStorage.setItem("sous-keep", "value");
    window.sessionStorage.setItem("sous-tab", "value");

    render(
      <SignInModeProvider>
        <HomeRail {...makeRailProps()} />
      </SignInModeProvider>,
    );
    openRailMenu();
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);

    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledTimes(1);
    });
    expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    expect(assignSpy).not.toHaveBeenCalled();
    expect(signOutPostCount()).toBe(1);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("e. arms for waiting reports and unsent note edits, ignoring refused and fully sent reports", async () => {
    setSignInCookie(true);
    const { outbox, submits, annotates } = createControlledOutbox();
    submits["refused-1"] = "refused";
    submits["waiting-1"] = "offline";
    annotates["dirty-1"] = "offline";

    await outbox.add(makeReport("sent-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();
    await outbox.add(makeReport("dirty-1", "2026-10-04T18:01:00.000Z"));
    await outbox.flush();
    await outbox.add(makeReport("refused-1", "2026-10-04T18:02:00.000Z"));
    await outbox.flush();
    outbox.annotate("dirty-1", "step text clipped");
    await outbox.flush();
    await outbox.add(makeReport("waiting-1", "2026-10-04T18:03:00.000Z"));
    await outbox.flush();

    expect(
      outbox.list().map((entry) => ({
        id: entry.id,
        status: entry.status,
        note: entry.note,
        sentNote: entry.sentNote,
      })),
    ).toEqual([
      { id: "waiting-1", status: "waiting", note: "", sentNote: "" },
      { id: "refused-1", status: "refused", note: "", sentNote: "" },
      {
        id: "dirty-1",
        status: "sent",
        note: "step text clipped",
        sentNote: "",
      },
      { id: "sent-1", status: "sent", note: "", sentNote: "" },
    ]);

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);
    expect(item.textContent).toBe(SIGN_OUT_COPY.armed(2));
    expect(item.textContent).toBe(
      "2 reports not sent yet. Tap again to sign out and remove them.",
    );
    expect(signOutPostCount()).toBe(0);

    fireEvent.click(item);
    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    });
    expect(signOutPostCount()).toBe(1);
  });

  it("f. uses singular armed wording when exactly one report is unsent", async () => {
    setSignInCookie(true);
    const { outbox, submits } = createControlledOutbox();
    submits["waiting-1"] = "offline";

    await outbox.add(makeReport("waiting-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();

    expect(
      outbox.list().map((entry) => ({
        id: entry.id,
        status: entry.status,
        note: entry.note,
        sentNote: entry.sentNote,
      })),
    ).toEqual([{ id: "waiting-1", status: "waiting", note: "", sentNote: "" }]);

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);
    expect(item.textContent).toBe(
      "1 report not sent yet. Tap again to sign out and remove it.",
    );
    expect(signOutPostCount()).toBe(0);

    fireEvent.click(item);
    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    });
    expect(signOutPostCount()).toBe(1);
  });

  it("g. does not arm when the outbox only holds refused and fully sent reports", async () => {
    setSignInCookie(true);
    const { outbox, submits } = createControlledOutbox();
    submits["refused-1"] = "refused";

    await outbox.add(makeReport("sent-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();
    await outbox.add(makeReport("refused-1", "2026-10-04T18:01:00.000Z"));
    await outbox.flush();

    expect(
      outbox.list().map((entry) => ({
        id: entry.id,
        status: entry.status,
        note: entry.note,
        sentNote: entry.sentNote,
      })),
    ).toEqual([
      { id: "refused-1", status: "refused", note: "", sentNote: "" },
      { id: "sent-1", status: "sent", note: "", sentNote: "" },
    ]);

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);
    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    });
    expect(signOutPostCount()).toBe(1);
  });

  it("h. resets armed state when the rail menu closes and opens again", async () => {
    setSignInCookie(true);
    vi.resetModules();
    const [
      { HomeRail: FreshHomeRail },
      { SignInModeProvider: FreshProvider },
      { reportOutbox: freshReportOutbox },
    ] = await Promise.all([
      import("./HomeRail"),
      import("./SignInMode"),
      import("@/hooks/useReportOutbox"),
    ]);

    const singleton = freshReportOutbox();
    await singleton.add(makeReport("wait-h", "2026-10-04T18:00:00.000Z"));
    await singleton.flush();
    expect(
      singleton.list().map((entry) => ({ id: entry.id, status: entry.status })),
    ).toEqual([{ id: "wait-h", status: "waiting" }]);

    render(
      <FreshProvider>
        <FreshHomeRail {...makeRailProps()} />
      </FreshProvider>,
    );

    openRailMenu();
    const firstOpenItem = screen.getByRole("menuitem", {
      name: SIGN_OUT_COPY.item,
    });
    fireEvent.click(firstOpenItem);
    expect(firstOpenItem.textContent).toBe(SIGN_OUT_COPY.armed(1));
    expect(signOutPostCount()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("menu")).toBeNull();

    openRailMenu();
    const reopenedItem = screen.getByRole("menuitem", {
      name: SIGN_OUT_COPY.item,
    });
    expect(reopenedItem.textContent).toBe(SIGN_OUT_COPY.item);
    fireEvent.click(reopenedItem);
    expect(reopenedItem.textContent).toBe(SIGN_OUT_COPY.armed(1));
    expect(signOutPostCount()).toBe(0);
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it("i. disarms itself after CLEAR_ARM_MS milliseconds without sending anything", async () => {
    setSignInCookie(true);
    const { outbox, submits } = createControlledOutbox();
    submits["waiting-1"] = "offline";
    await outbox.add(makeReport("waiting-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();
    expect(outbox.list().map((entry) => entry.status)).toEqual(["waiting"]);

    vi.useFakeTimers();
    try {
      renderSignOutStandalone(outbox);
      const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
      fireEvent.click(item);
      expect(item.textContent).toBe(SIGN_OUT_COPY.armed(1));

      act(() => {
        vi.advanceTimersByTime(CLEAR_ARM_MS - 1);
      });
      expect(item.textContent).toBe(SIGN_OUT_COPY.armed(1));

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(item.textContent).toBe(SIGN_OUT_COPY.item);
      expect(signOutPostCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("j. ignores a second tap while sign-out is in flight and marks the row aria-disabled", async () => {
    setSignInCookie(true);
    const { outbox } = createControlledOutbox();
    const pending: Array<(res: Response) => void> = [];
    signOutResponder = () =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      });

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);

    await vi.waitFor(() => {
      expect(signOutPostCount()).toBe(1);
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(item);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(signOutPostCount()).toBe(1);

    for (const resolve of pending) {
      resolve(
        new Response("{}", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    const status = await failureStatus();
    expect(status.textContent).toBe(SIGN_OUT_COPY.refused);
    expect(signOutPostCount()).toBe(1);
    expect(item.getAttribute("aria-disabled")).toBeNull();
  });

  it("k. renders nothing and never subscribes to the outbox when the sign-in cookie is absent", () => {
    setSignInCookie(false);
    const { outbox } = createControlledOutbox();
    const subscribeSpy = vi.spyOn(outbox, "subscribe");

    renderSignOutStandalone(outbox);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("l. returns the label to Sign out when a waiting report finishes sending while armed, and signs out on the next tap", async () => {
    setSignInCookie(true);
    let releaseSubmit: () => void = () => {};
    const outbox = createReportOutbox(memoryStore(), {
      submit: () =>
        new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        }),
      annotate: () => Promise.resolve(),
    });

    await expect(
      outbox.add(makeReport("waiting-in-flight", "2026-10-04T18:00:00.000Z")),
    ).resolves.toBe("flagged");
    expect(outbox.list().map((entry) => entry.status)).toEqual(["waiting"]);

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);
    expect(item.textContent).toBe(SIGN_OUT_COPY.armed(1));
    expect(signOutPostCount()).toBe(0);

    await act(async () => {
      releaseSubmit();
      await outbox.flush();
    });
    expect(outbox.list().map((entry) => entry.status)).toEqual(["sent"]);
    expect(item.textContent).toBe(SIGN_OUT_COPY.item);

    fireEvent.click(item);
    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    });
    expect(signOutPostCount()).toBe(1);
  });

  it("m. restores the Sign out label immediately on the second tap while sign-out is still pending", async () => {
    setSignInCookie(true);
    const { outbox, submits } = createControlledOutbox();
    submits["waiting-1"] = "offline";
    await outbox.add(makeReport("waiting-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();

    let resolveSignOut: (res: Response) => void = () => {};
    signOutResponder = () =>
      new Promise<Response>((resolve) => {
        resolveSignOut = resolve;
      });

    renderSignOutStandalone(outbox);
    const item = screen.getByRole("menuitem", { name: SIGN_OUT_COPY.item });
    fireEvent.click(item);
    expect(item.textContent).toBe(SIGN_OUT_COPY.armed(1));
    expect(signOutPostCount()).toBe(0);

    fireEvent.click(item);
    await vi.waitFor(() => {
      expect(signOutPostCount()).toBe(1);
    });
    expect(item.textContent).toBe(SIGN_OUT_COPY.item);
    expect(item.getAttribute("aria-disabled")).toBe("true");

    resolveSignOut(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await vi.waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/sign-in");
    });
    expect(signOutPostCount()).toBe(1);
  });

  it("n. shows the connection line, stays usable, and leaves storage and outbox unchanged when loading sign-out code fails", async () => {
    setSignInCookie(true);
    window.localStorage.setItem("sous-keep", "value");
    window.sessionStorage.setItem("sous-tab", "value");

    const { outbox } = createControlledOutbox();
    await outbox.add(makeReport("sent-1", "2026-10-04T18:00:00.000Z"));
    await outbox.flush();
    expect(
      outbox.list().map((entry) => ({ id: entry.id, status: entry.status })),
    ).toEqual([{ id: "sent-1", status: "sent" }]);

    vi.resetModules();
    let loadAttempts = 0;
    vi.doMock("@/lib/auth/device", () => {
      loadAttempts += 1;
      throw new TypeError("Failed to fetch dynamically imported module");
    });

    try {
      const [
        { SignInModeProvider: FreshProvider },
        freshSignOut,
      ] = await Promise.all([
        import("./SignInMode"),
        import("./SignOutItem"),
      ]);
      const freshCopy = freshSignOut.SIGN_OUT_COPY;

      render(
        <FreshProvider>
          <SignOutMenu from={freshSignOut} outbox={() => outbox} />
        </FreshProvider>,
      );

      const item = screen.getByRole("menuitem", { name: freshCopy.item });
      fireEvent.click(item);

      const status = await failureStatus();
      expect(status.textContent).toBe(freshCopy.network);
      expect(item.getAttribute("aria-disabled")).toBeNull();
      expect(loadAttempts).toBe(1);
      expect(window.localStorage.getItem("sous-keep")).toBe("value");
      expect(window.sessionStorage.getItem("sous-tab")).toBe("value");
      expect(
        outbox.list().map((entry) => ({ id: entry.id, status: entry.status })),
      ).toEqual([{ id: "sent-1", status: "sent" }]);
      expect(signOutPostCount()).toBe(0);
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(assignSpy).not.toHaveBeenCalled();

      fireEvent.click(item);
      await vi.waitFor(() => {
        expect(loadAttempts).toBe(2);
      });
      expect((await failureStatus()).textContent).toBe(
        freshCopy.network,
      );
      expect(item.getAttribute("aria-disabled")).toBeNull();
    } finally {
      vi.doUnmock("@/lib/auth/device");
      vi.resetModules();
    }
  });
});
