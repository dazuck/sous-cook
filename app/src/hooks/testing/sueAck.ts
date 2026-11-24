/**
 * Sue's acknowledgements for a hook test: the real acknowledger over the real
 * sounds, on a fake browser context (`lib/kitchen/testing/fakeAudioContext`),
 * with the setting and the dice in the test's hands.
 */

import { createAckAudio } from "@/lib/kitchen/ack-audio";
import type { SueReplies } from "@/lib/kitchen/cook-prefs";
import { FakeAudioContext, clipBytes } from "@/lib/kitchen/testing/fakeAudioContext";
import { createAcknowledger } from "@/lib/kitchen/voice-ack";

export function sueAck(initial: SueReplies = "sounds") {
  const ctx = new FakeAudioContext();
  const state = { mode: initial, draws: [] as number[] };
  const problems: string[] = [];
  const audio = createAckAudio({
    context: () => ctx.as(),
    fetchClip: (url) => Promise.resolve(clipBytes(url)),
    report: (_level, message) => problems.push(message),
  });
  const ack = createAcknowledger({
    audio,
    mode: () => state.mode,
    random: () => state.draws.shift() ?? 0.99,
  });
  return { ack, ctx, state, problems, audio };
}
