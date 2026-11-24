// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";

const connectionControl = vi.hoisted(() => ({
  connection: vi.fn(() => Promise.resolve()),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: connectionControl.connection,
  };
});

import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import NotInvitedPage from "./page";

beforeEach(() => {
  connectionControl.connection.mockClear();
});

afterEach(() => {
  cleanup();
  connectionControl.connection.mockClear();
  vi.unstubAllEnvs();
});

describe("PAGE-1: /not-invited respects deployment mode", () => {
  it("redirects /not-invited to /kitchen in single-kitchen mode", async () => {
    vi.stubEnv("SOUS_SIGN_IN", "off");

    let caught: unknown;
    try {
      await NotInvitedPage({ searchParams: Promise.resolve({}) });
    } catch (err) {
      caught = err;
    }

    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(isRedirectError(caught)).toBe(true);
    if (isRedirectError(caught)) {
      expect(getURLFromRedirectError(caught)).toBe("/kitchen");
    }
  });

  it("does not redirect in sign-in mode", async () => {
    stubSignInEnv();

    const element = await NotInvitedPage({ searchParams: Promise.resolve({}) });
    expect(connectionControl.connection).toHaveBeenCalledTimes(1);
    expect(element).toBeTruthy();
  });
});

describe("PAGE-3: /not-invited renders copy and link based on the error parameter", () => {
  it("shows the invite-list message and account switch link when no error is given", async () => {
    stubSignInEnv();

    const element = await NotInvitedPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByRole("heading", { name: "Sous" })).toBeTruthy();
    expect(
      screen.getByText(
        "This Google account isn't on this Sous's invite list. Ask the person who runs it to invite you.",
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "Use another Google account",
    });
    expect(link.getAttribute("href")).toBe("/sign-in");
  });

  it("shows the invite-list message and account switch link when error is not_invited", async () => {
    stubSignInEnv();

    const element = await NotInvitedPage({
      searchParams: Promise.resolve({ error: "not_invited" }),
    });
    render(element);

    expect(
      screen.getByText(
        "This Google account isn't on this Sous's invite list. Ask the person who runs it to invite you.",
      ),
    ).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "Use another Google account",
    });
    expect(link.getAttribute("href")).toBe("/sign-in");
  });

  it("shows the generic failure message and retry link when error is access_denied", async () => {
    stubSignInEnv();

    const element = await NotInvitedPage({
      searchParams: Promise.resolve({ error: "access_denied" }),
    });
    render(element);

    expect(screen.getByRole("heading", { name: "Sous" })).toBeTruthy();
    expect(screen.getByText("Sign-in didn't finish. Try again.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Try again" });
    expect(link.getAttribute("href")).toBe("/sign-in");
  });

  it("uses the first value when error is an array", async () => {
    stubSignInEnv();

    const element = await NotInvitedPage({
      searchParams: Promise.resolve({
        error: ["access_denied", "not_invited"],
      }),
    });
    render(element);

    expect(screen.getByText("Sign-in didn't finish. Try again.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Try again" });
    expect(link.getAttribute("href")).toBe("/sign-in");
  });
});
