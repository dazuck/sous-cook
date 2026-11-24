/**
 * Ask Sous's reply cut off at the token cap.
 * `answerContent` throws `AnswerCutOff`, the `chatCooking` procedure answers
 * it with `ASK_CUT_OFF_CODE`, and Ask reads the code to say the answer ran
 * long, rather than "Couldn't reach Sous", which would be false about the
 * cause. Shared by server and client, so nothing here imports server code.
 *
 * `UNPROCESSABLE_CONTENT` (422): the request was fine and the server couldn't
 * make a whole answer of it. Nothing else in that procedure answers it (bad
 * input is BAD_REQUEST, anything unexpected INTERNAL_SERVER_ERROR), and a 4xx
 * reaches the client as the app sent it.
 */
export const ASK_CUT_OFF_CODE = "UNPROCESSABLE_CONTENT" as const;

/** The model stopped at the output token cap, mid-answer. */
export class AnswerCutOff extends Error {
  constructor(readonly outputTokens: number | undefined) {
    super(
      outputTokens === undefined
        ? "The model's reply was cut off at the token limit"
        : `The model's reply was cut off at the token limit after ${outputTokens} output tokens`,
    );
    this.name = "AnswerCutOff";
  }
}

/** Whether a failed ask was the server refusing a reply cut at the cap. */
export function isAnswerCutOff(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) return false;
  const { data } = error as { data?: { code?: unknown } | null };
  return data?.code === ASK_CUT_OFF_CODE;
}
