// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  markSignedOut,
  resetSignedOutForTests,
  useSignedOut,
} from "./signed-out";

function SignedOutReader() {
  const signedOut = useSignedOut();
  return <div data-testid="signed-out">{String(signedOut)}</div>;
}

afterEach(() => {
  cleanup();
  resetSignedOutForTests();
});

describe("useSignedOut", () => {
  it("renders false, updates to true after markSignedOut, and returns to false after resetSignedOutForTests", () => {
    render(<SignedOutReader />);
    expect(screen.getByTestId("signed-out").textContent).toBe("false");

    act(() => {
      markSignedOut();
    });
    expect(screen.getByTestId("signed-out").textContent).toBe("true");

    act(() => {
      resetSignedOutForTests();
    });
    expect(screen.getByTestId("signed-out").textContent).toBe("false");
  });
});
