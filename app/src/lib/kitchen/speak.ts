/**
 * The one place the cook page talks (slice B5d, D13; the Player's `speak.ts`,
 * ported). A newer answer always cancels an older one still being read. With
 * no `speechSynthesis` (jsdom, an old WebView) it says nothing and reports
 * that, and the answer on screen stands alone.
 */

export interface Speaking {
  /** Called once when the utterance ends, fails or is cancelled by a newer one. */
  onDone: () => void;
}

/** Speak `text`; false when this browser can't, in which case `onDone` is never called. */
export function speak(text: string, { onDone }: Speaking): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    return false;
  }
  // Only when something is being said: Chrome can drop a speak() made just
  // after a cancel() (B5d verify round 1).
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
  return true;
}

/** Stop whatever is being said. */
export function hush(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}
