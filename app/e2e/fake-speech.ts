/**
 * A speech recognizer a spec can talk to. Every page already gets an inert
 * stand-in for the browser's own (`fixtures.ts`), which never hears anything;
 * a spec that needs one to hear commands installs this one over it with
 * `page.addInitScript(installFakeSpeech)` (`voice-replies.spec.ts`), and
 * speaks through `window.__speech`:
 *
 * - `say(text)` hands the listening recognizer one final result; `say(text,
 *   false)` an interim one, standing in for the interim result before it;
 * - `fail(code)` fails it with a Web Speech error code, which ends it;
 * - `end()` ends it with no error, as Chrome does on its own;
 * - `listening()` counts the recognizers listening now.
 *
 * It keeps the parts of Chrome's contract the hooks rely on: `start()` on a
 * running session throws InvalidStateError, `abort()` reports "aborted",
 * a session that fails or stops ends, one that isn't `continuous` ends
 * after its first final result, and each result event carries the session's
 * whole results list with `resultIndex` at the first that changed.
 */

export interface SpeechDriver {
  say(text: string, isFinal?: boolean): void;
  fail(code: string): void;
  end(): void;
  listening(): number;
}

declare global {
  interface Window {
    __speech: SpeechDriver;
  }
}

/** Runs in the page, so it must stand alone: no imports, no outside names. */
export function installFakeSpeech() {
  type Handler = ((ev: Event) => void) | null;
  type Result = { isFinal: boolean; 0: { transcript: string; confidence: number }; length: number };
  const running = new Set<FakeRecognition>();
  const event = (type: string, extra: object = {}) => Object.assign(new Event(type), extra);

  class FakeRecognition extends EventTarget {
    continuous = false;
    interimResults = false;
    lang = "";
    onstart: Handler = null;
    onend: Handler = null;
    onerror: Handler = null;
    onresult: Handler = null;
    results: Result[] = [];

    start() {
      if (running.has(this)) throw new DOMException("already started", "InvalidStateError");
      running.add(this);
      this.results = [];
      this.onstart?.(event("start"));
    }

    stop() {
      if (running.has(this)) this.end();
    }

    abort() {
      if (!running.has(this)) return;
      this.onerror?.(event("error", { error: "aborted" }));
      this.end();
    }

    end() {
      running.delete(this);
      this.onend?.(event("end"));
    }
  }

  const latest = () => [...running].at(-1);

  window.__speech = {
    say(text, isFinal = true) {
      const rec = latest();
      if (!rec) throw new Error(`nothing is listening to hear "${text}"`);
      const last = rec.results.at(-1);
      const at = last && !last.isFinal ? rec.results.length - 1 : rec.results.length;
      rec.results = [
        ...rec.results.slice(0, at),
        { isFinal, 0: { transcript: text, confidence: 0.9 }, length: 1 },
      ];
      rec.onresult?.(event("result", { resultIndex: at, results: rec.results.slice() }));
      if (!rec.continuous && isFinal && running.has(rec)) rec.end();
    },
    fail(code) {
      const rec = latest();
      if (!rec) throw new Error(`nothing is listening to fail with "${code}"`);
      rec.onerror?.(event("error", { error: code }));
      rec.end();
    },
    end() {
      const rec = latest();
      if (!rec) throw new Error("nothing is listening to end");
      rec.end();
    },
    listening: () => running.size,
  };

  Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition, configurable: true });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    value: FakeRecognition,
    configurable: true,
  });
}
