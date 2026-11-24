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
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
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

  it("hands a prep page's jobs on to the assistant, with no step (review round 3)", async () => {
    vi.mocked(chatCookingAssistant).mockResolvedValue({
      content: "Fine as you can.",
      usage: { inputTokens: 80, outputTokens: 6 },
    });
    const prep = {
      jobs: [
        { text: "Mince the garlic", amounts: ["3 cloves garlic"], done: true },
        { text: "Rinse the lentils", amounts: [], done: false },
      ],
    };

    await caller.chatCooking({ ...INPUT, queueId: "q-dal", prep });

    // The kitchen comes from the request's context, then the session, messages, recipe and options.
    const [kitchenId, , , , options] = vi.mocked(chatCookingAssistant).mock.calls[0]!;
    expect(kitchenId).toBe(HOME.id);
    expect(options).toMatchObject({ queueId: "q-dal", prep });
    expect(options?.currentStepIndex).toBeUndefined();
  });

  it("refuses prep that is not jobs of words, amounts and a tick", async () => {
    vi.mocked(chatCookingAssistant).mockResolvedValue({
      content: "Fine as you can.",
      usage: { inputTokens: 80, outputTokens: 6 },
    });
    for (const prep of [
      { jobs: [{ text: "Mince the garlic", amounts: [], done: "yes" }] },
      { jobs: [{ text: "Mince the garlic", amounts: [3], done: false }] },
      { jobs: [{ text: "Mince the garlic", done: false }] },
      { jobs: "Mince the garlic" },
    ]) {
      const failure = await failureOf(caller.chatCooking({ ...INPUT, prep } as never));
      expect((failure as TRPCError).code).toBe("BAD_REQUEST");
    }
    expect(chatCookingAssistant).not.toHaveBeenCalled();
  });

  it("leaves any other failure as it was, so Ask says it couldn't reach Sous", async () => {
    vi.mocked(chatCookingAssistant).mockRejectedValue(new Error("The model declined to answer (blocked)"));

    const failure = await failureOf(caller.chatCooking(INPUT));

    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    expect((failure as TRPCError).code).not.toBe(ASK_CUT_OFF_CODE);
  });
});
