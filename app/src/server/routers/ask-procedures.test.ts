/**
 * Ask Sous's procedure tells a reply cut at the token cap apart from any
 * other failure (feedback review 2026-10-27): `AnswerCutOff` answers
 * `ASK_CUT_OFF_CODE`, which Ask reads to say the answer ran long instead of
 * "Couldn't reach Sous". The cut itself is tested in
 * `lib/claude.ask-truncation.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../../lib/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/claude")>()),
  chatCookingAssistant: vi.fn(),
}));

import { chatCookingAssistant } from "../../lib/claude";
import { AnswerCutOff, ASK_CUT_OFF_CODE } from "../../lib/kitchen/ask-failure";
import { appRouter } from "./_app";

const caller = appRouter.createCaller({ db: {} as never });
const INPUT = {
  sessionId: "cook-queue-1",
  messages: [{ role: "user" as const, content: "Can the noodles go in now?" }],
};

async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chatCooking", () => {
  it("answers a reply cut at the token cap with the cut-off code, carrying the cause", async () => {
    const cut = new AnswerCutOff(12);
    vi.mocked(chatCookingAssistant).mockRejectedValue(cut);

    const failure = await failureOf(caller.chatCooking(INPUT));

    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(ASK_CUT_OFF_CODE);
    expect((failure as TRPCError).cause).toBe(cut);
  });

  it("leaves any other failure as it was, so Ask says it couldn't reach Sous", async () => {
    vi.mocked(chatCookingAssistant).mockRejectedValue(new Error("The model declined to answer (blocked)"));

    const failure = await failureOf(caller.chatCooking(INPUT));

    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((failure as TRPCError).code).not.toBe(ASK_CUT_OFF_CODE);
  });
});
