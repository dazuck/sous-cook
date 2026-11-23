import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../hooks/types");
  return {
    connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, false])),
  };
});
vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import {
  DeploymentConfigError as ModeDeploymentConfigError,
  SIGN_IN_MODE_COOKIE,
  getDeploymentMode as modeGetDeploymentMode,
  readSignInModeCookie,
} from "./mode";
import {
  DeploymentConfigError as DeploymentDeploymentConfigError,
  getDeploymentMode as deploymentGetDeploymentMode,
} from "./deployment";

describe("MODE-8: standalone deployment mode module and sign-in mode cookie", () => {
  it("resolves SOUS_SIGN_IN from the passed environment and refuses unknown values", () => {
    expect(modeGetDeploymentMode({})).toBe("sign-in");
    expect(modeGetDeploymentMode({ SOUS_SIGN_IN: "" })).toBe("sign-in");
    expect(modeGetDeploymentMode({ SOUS_SIGN_IN: "on" })).toBe("sign-in");
    expect(modeGetDeploymentMode({ SOUS_SIGN_IN: "off" })).toBe(
      "single-kitchen",
    );

    let caught: unknown;
    try {
      modeGetDeploymentMode({ SOUS_SIGN_IN: "yes" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModeDeploymentConfigError);
    expect((caught as Error).message).toMatch(/SOUS_SIGN_IN.*"yes"/);
  });

  it("re-exports the same getDeploymentMode function and DeploymentConfigError class from deployment.ts", () => {
    expect(deploymentGetDeploymentMode).toBe(modeGetDeploymentMode);
    expect(DeploymentDeploymentConfigError).toBe(ModeDeploymentConfigError);

    let caught: unknown;
    try {
      modeGetDeploymentMode({ SOUS_SIGN_IN: "yes" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DeploymentDeploymentConfigError);
  });

  it("reads the sign-in mode cookie by exact trimmed name=value match", () => {
    expect(SIGN_IN_MODE_COOKIE).toBe("sous-sign-in");

    expect(readSignInModeCookie("a=b; sous-sign-in=1")).toBe(true);
    expect(readSignInModeCookie("sous-sign-in=1")).toBe(true);

    expect(readSignInModeCookie("")).toBe(false);
    expect(readSignInModeCookie("sous-sign-in=0")).toBe(false);
    expect(readSignInModeCookie("sous-sign-in=10")).toBe(false);
    expect(readSignInModeCookie("xsous-sign-in=1")).toBe(false);
    expect(readSignInModeCookie("a=sous-sign-in=1")).toBe(false);
  });
});
