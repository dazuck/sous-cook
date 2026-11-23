// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";

type FetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const fetchControl = vi.hoisted(() => {
  const originalFetch = globalThis.fetch;
  let handler: FetchHandler = async () => {
    throw new Error("Unexpected fetch call without a configured test handler");
  };
  const stubFetch: typeof fetch = (input, init) => handler(input, init);
  globalThis.fetch = stubFetch;
  return {
    stubFetch,
    originalFetch,
    setHandler(next: FetchHandler) {
      handler = next;
    },
    resetHandler() {
      handler = async () => {
        throw new Error(
          "Unexpected fetch call without a configured test handler",
        );
      };
    },
  };
});

const connectionControl = vi.hoisted(() => ({
  connection: vi.fn(() => Promise.resolve()),
}));

const headersControl = vi.hoisted(() => {
  let current = new Headers();
  return {
    headers: () => Promise.resolve(current),
    set(next: Headers) {
      current = next;
    },
    reset() {
      current = new Headers();
    },
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: connectionControl.connection,
  };
});

vi.mock("next/headers", () => ({
  headers: headersControl.headers,
}));

import { TEST_AUTH_ENV, stubSignInEnv } from "@/lib/__tests__/test-auth";
import SignInPage from "./page";
import {
  SIGN_IN_NETWORK_ERROR,
  SIGN_IN_REFUSED_ERROR,
  SIGN_IN_TOO_MANY_TRIES_ERROR,
  SignInButton,
} from "./SignInButton";
import SignInDonePage from "./done/page";
import { ForgetAndEnter } from "./done/ForgetAndEnter";

let storageWindow: Window | null = null;

function seedStorage(): void {
  window.localStorage.setItem("sous-feedback", "saved-feedback");
  window.localStorage.setItem("sous-cook:q1", "saved-cook");
  window.sessionStorage.setItem("sous.cook-scale.q1", "2");
}

function assertStorageSeeded(): void {
  expect(window.localStorage.getItem("sous-feedback")).toBe("saved-feedback");
  expect(window.localStorage.getItem("sous-cook:q1")).toBe("saved-cook");
  expect(window.sessionStorage.getItem("sous.cook-scale.q1")).toBe("2");
}

beforeEach(() => {
  // Node 25 defines a built-in global localStorage stub without a backing file
  // that shadows happy-dom's Storage on globalThis. Attach a real happy-dom
  // Storage instance for the test and close it in afterEach.
  storageWindow = new Window({ url: TEST_AUTH_ENV.BETTER_AUTH_URL });
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  vi.stubGlobal("sessionStorage", storageWindow.sessionStorage);
  globalThis.fetch = fetchControl.stubFetch;
  fetchControl.resetHandler();
  connectionControl.connection.mockClear();
  headersControl.reset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  fetchControl.resetHandler();
  connectionControl.connection.mockClear();
  headersControl.reset();
  if (storageWindow) {
    await storageWindow.happyDOM.close();
    storageWindow = null;
  }
  vi.unstubAllGlobals();
  globalThis.fetch = fetchControl.originalFetch;
  vi.unstubAllEnvs();
});

describe("PAGE-1: /sign-in and /sign-in/done respect deployment mode", () => {
  it("redirects /sign-in to /kitchen in single-kitchen mode", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");

    let caught: unknown;
    try {
      await SignInPage();
    } catch (err) {
      caught = err;
    }

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(isRedirectError(caught)).toBe(true);
    if (isRedirectError(caught)) {
      expect(getURLFromRedirectError(caught)).toBe("/kitchen");
    }
  });

  it("redirects /sign-in/done to /kitchen in single-kitchen mode", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");

    let caught: unknown;
    try {
      await SignInDonePage();
    } catch (err) {
      caught = err;
    }

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(isRedirectError(caught)).toBe(true);
    if (isRedirectError(caught)) {
      expect(getURLFromRedirectError(caught)).toBe("/kitchen");
    }
  });

  it("renders /sign-in with the Google sign-in button in sign-in mode", async () => {
    stubSignInEnv();

    const element = await SignInPage();
    render(element);

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Sous" })).toBeTruthy();
    expect(
      screen.getByText("Sign in with the Google account your invite went to."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sign in with Google" }),
    ).toBeTruthy();
  });

  it("redirects /sign-in/done to /sign-in without emptying storage when no cookie header is present", async () => {
    stubSignInEnv();
    seedStorage();

    let caught: unknown;
    try {
      await SignInDonePage();
    } catch (err) {
      caught = err;
    }

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(isRedirectError(caught)).toBe(true);
    if (isRedirectError(caught)) {
      expect(getURLFromRedirectError(caught)).toBe("/sign-in");
    }
    assertStorageSeeded();
  });

  it("redirects /sign-in/done to /sign-in when the session cookie value is empty", async () => {
    stubSignInEnv();
    seedStorage();
    headersControl.set(new Headers({ cookie: "better-auth.session_token=" }));

    let caught: unknown;
    try {
      await SignInDonePage();
    } catch (err) {
      caught = err;
    }

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(isRedirectError(caught)).toBe(true);
    if (isRedirectError(caught)) {
      expect(getURLFromRedirectError(caught)).toBe("/sign-in");
    }
    assertStorageSeeded();
  });

  it("renders /sign-in/done, empties storage, and navigates to /kitchen when a session cookie is present", async () => {
    stubSignInEnv();
    seedStorage();
    headersControl.set(
      new Headers({ cookie: "better-auth.session_token=made-up-token" }),
    );
    const replaceSpy = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});

    const element = await SignInDonePage();
    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(element).toBeTruthy();

    render(element);

    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledTimes(1);
    });
    expect(replaceSpy).toHaveBeenCalledWith("/kitchen");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("PAGE-2: ForgetAndEnter clears storage before navigating to /kitchen", () => {
  it("empties localStorage and sessionStorage and then calls replace('/kitchen')", async () => {
    seedStorage();
    const calls: Array<{
      url: string;
      localLength: number;
      sessionLength: number;
    }> = [];
    const navigation = {
      replace(url: string) {
        calls.push({
          url,
          localLength: window.localStorage.length,
          sessionLength: window.sessionStorage.length,
        });
      },
    };

    render(<ForgetAndEnter navigation={navigation} />);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      url: "/kitchen",
      localLength: 0,
      sessionLength: 0,
    });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("PAGE-4: SignInButton reports each refusal outcome through real startSignIn and authClient", () => {
  it("shows the network sentence and keeps storage intact when sign-out throws", async () => {
    seedStorage();
    const assignSpy = vi.spyOn(window.location, "assign");
    const replaceSpy = vi.spyOn(window.location, "replace");
    const requestedUrls: string[] = [];

    let rejectFetch!: (reason?: unknown) => void;
    fetchControl.setHandler((input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requestedUrls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      });
    });

    render(<SignInButton />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    const button = screen.getByRole("button", {
      name: "Sign in with Google",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(requestedUrls.length).toBe(1);
    });
    expect(button.disabled).toBe(true);

    rejectFetch(new TypeError("Failed to fetch"));

    await waitFor(() => {
      expect(status.textContent).toBe(SIGN_IN_NETWORK_ERROR);
    });
    expect(button.disabled).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/sign-out"))).toBe(true);
    assertStorageSeeded();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("shows the refused sentence and keeps storage intact when sign-out answers 500", async () => {
    seedStorage();
    const assignSpy = vi.spyOn(window.location, "assign");
    const replaceSpy = vi.spyOn(window.location, "replace");

    fetchControl.setHandler(async () => {
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    render(<SignInButton />);
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", {
      name: "Sign in with Google",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(status.textContent).toBe(SIGN_IN_REFUSED_ERROR);
    });
    expect(button.disabled).toBe(false);
    assertStorageSeeded();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("shows the too-many-tries sentence and keeps storage intact when sign-out answers 429", async () => {
    seedStorage();
    const assignSpy = vi.spyOn(window.location, "assign");
    const replaceSpy = vi.spyOn(window.location, "replace");

    fetchControl.setHandler(async () => {
      return new Response("{}", {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    render(<SignInButton />);
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", {
      name: "Sign in with Google",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(status.textContent).toBe(SIGN_IN_TOO_MANY_TRIES_ERROR);
    });
    expect(button.disabled).toBe(false);
    assertStorageSeeded();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("keeps the button disabled after starting sign-in until a persisted pageshow event fires", async () => {
    seedStorage();
    const googleUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=made-up&state=made-up";
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});

    fetchControl.setHandler(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/sign-out")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/sign-in/social")) {
        return new Response(
          JSON.stringify({ url: googleUrl, redirect: false }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected request URL: ${url}`);
    });

    render(<SignInButton />);
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", {
      name: "Sign in with Google",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledTimes(1);
    });
    expect(assignSpy).toHaveBeenCalledWith(googleUrl);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(status.textContent).toBe("");
    expect(button.disabled).toBe(true);

    const notPersisted = new Event("pageshow");
    Object.defineProperty(notPersisted, "persisted", { value: false });
    act(() => {
      window.dispatchEvent(notPersisted);
    });
    expect(button.disabled).toBe(true);

    const persisted = new Event("pageshow");
    Object.defineProperty(persisted, "persisted", { value: true });
    act(() => {
      window.dispatchEvent(persisted);
    });
    expect(button.disabled).toBe(false);
  });

  it("catches an unexpected throw from startSignIn, shows the refused sentence, and re-enables the button", async () => {
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    const throwingStorage: Storage = {
      length: 0,
      clear() {
        throw new TypeError("storage clear failed");
      },
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
    };
    vi.stubGlobal("localStorage", throwingStorage);

    fetchControl.setHandler(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/sign-out")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request URL: ${url}`);
    });

    render(<SignInButton />);
    const status = screen.getByRole("status");
    const button = screen.getByRole("button", {
      name: "Sign in with Google",
    }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(status.textContent).toBe(SIGN_IN_REFUSED_ERROR);
    });
    expect(button.disabled).toBe(false);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
