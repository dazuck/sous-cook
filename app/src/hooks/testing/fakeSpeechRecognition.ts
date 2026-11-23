/**
 * A stand-in for Chrome's `webkitSpeechRecognition`, for hook tests: the
 * browser boundary, driven by the test. It keeps Chrome's contract as far as
 * the hooks rely on it: `start()` on a running session throws
 * InvalidStateError; `stop()` ends the session (or, with `slowStop`, leaves
 * it to the test to end, as Chrome may hand over a last result first);
 * `abort()` reports "aborted", then ends; an error is always followed by the
 * end of the session. Each result event carries the session's whole results
 * list, as Chrome's do: a final result is added to it, an interim one stands
 * in for the interim result before it, and `resultIndex` is the first that
 * changed.
 */

type Handler<E = Event> = ((ev: E) => void) | null;

interface FakeResult {
  isFinal: boolean;
  0: { transcript: string; confidence: number };
  length: number;
}

interface ResultEvent extends Event {
  resultIndex: number;
  results: FakeResult[];
}

const resultOf = (transcript: string, isFinal: boolean): FakeResult => ({
  isFinal,
  0: { transcript, confidence: 0.9 },
  length: 1,
});

export class FakeSpeechRecognition extends EventTarget {
  static instances: FakeSpeechRecognition[] = [];

  /** The recognizer the hook built last. */
  static get current(): FakeSpeechRecognition {
    const last = FakeSpeechRecognition.instances.at(-1);
    if (!last) throw new Error("no recognizer was built");
    return last;
  }

  static reset() {
    FakeSpeechRecognition.instances = [];
  }

  continuous = false;
  interimResults = false;
  lang = "";
  onstart: Handler = null;
  onend: Handler = null;
  onerror: Handler<Event & { error: string }> = null;
  onresult: Handler<ResultEvent> = null;

  running = false;
  starts = 0;
  aborted = false;
  /** The next `start()` throws, as Chrome's may for reasons other than a running session. */
  refuseStart = false;
  /** `stop()` doesn't end the session; the test does, with `end()`. */
  slowStop = false;
  stopped = false;
  /** The session's results so far; a start begins a new list. */
  results: FakeResult[] = [];

  constructor() {
    super();
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    if (this.running) throw new DOMException("already started", "InvalidStateError");
    if (this.refuseStart) {
      this.refuseStart = false;
      throw new DOMException("refused", "NotAllowedError");
    }
    this.running = true;
    this.starts += 1;
    this.results = [];
    this.onstart?.(new Event("start"));
  }

  stop() {
    this.stopped = true;
    if (this.running && !this.slowStop) this.end();
  }

  abort() {
    this.aborted = true;
    if (!this.running) return;
    this.onerror?.(Object.assign(new Event("error"), { error: "aborted" }));
    this.end();
  }

  /**
   * Chrome hears `transcript`: a final result added to the session's list,
   * or (`isFinal` false) an interim one in place of the interim before it.
   */
  say(transcript: string, isFinal = true) {
    const last = this.results.at(-1);
    const at = last && !last.isFinal ? this.results.length - 1 : this.results.length;
    this.results = [...this.results.slice(0, at), resultOf(transcript, isFinal)];
    this.dispatchResults(at);
  }

  /** Chrome hands over exactly these results as the session's list (its Android repeats, say). */
  sayResults(results: { transcript: string; isFinal: boolean }[], resultIndex = 0) {
    this.results = results.map((r) => resultOf(r.transcript, r.isFinal));
    this.dispatchResults(resultIndex);
  }

  private dispatchResults(resultIndex: number) {
    const results = this.results.slice();
    this.onresult?.(Object.assign(new Event("result"), { resultIndex, results }));
  }

  /** The session fails with `code`, and so ends. */
  fail(code: string) {
    this.onerror?.(Object.assign(new Event("error"), { error: code }));
    this.end();
  }

  /** The session ends on its own, as Chrome's do after a while. */
  end() {
    this.running = false;
    this.onend?.(new Event("end"));
  }
}
