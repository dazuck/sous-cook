// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSpeechRecognition } from "./testing/fakeSpeechRecognition";
import { useSpeechRecognition } from "./useSpeechRecognition";

beforeEach(() => {
  FakeSpeechRecognition.reset();
  vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSpeechRecognition", () => {
  it("says so where the browser can't listen", () => {
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.isSupported).toBe(false);
  });

  it("builds one recognizer to the options and listens on start", () => {
    const { result } = renderHook(() =>
      useSpeechRecognition({ continuous: true, interimResults: false }),
    );
    expect(result.current.isSupported).toBe(true);
    const rec = FakeSpeechRecognition.current;
    expect(rec).toMatchObject({ continuous: true, interimResults: false, lang: "en-US" });

    act(() => result.current.startListening());
    expect(rec.running).toBe(true);
    expect(result.current.isListening).toBe(true);
  });

  it("keeps a live session when the caller re-renders with new callbacks", () => {
    const heard: string[] = [];
    const { result, rerender } = renderHook(
      ({ tag }) => useSpeechRecognition({ onFinalTranscript: (t) => heard.push(`${tag}:${t}`) }),
      { initialProps: { tag: "a" } },
    );
    act(() => result.current.startListening());
    rerender({ tag: "b" });

    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    const rec = FakeSpeechRecognition.current;
    expect(rec.aborted).toBe(false);
    expect(rec.running).toBe(true);
    // The latest callback gets what is heard.
    act(() => rec.say("add the onions"));
    expect(heard).toEqual(["b:add the onions"]);
  });

  it("hands on final results only, and shows interim ones as they come", () => {
    const onFinalTranscript = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onFinalTranscript }));
    act(() => result.current.startListening());
    const rec = FakeSpeechRecognition.current;

    act(() => rec.say("add the", false));
    expect(result.current.transcript).toBe("add the");
    expect(result.current.isFinal).toBe(false);
    expect(onFinalTranscript).not.toHaveBeenCalled();

    act(() => rec.say("add the onions"));
    expect(onFinalTranscript).toHaveBeenCalledWith("add the onions");
    expect(result.current.isFinal).toBe(true);
  });

  it("hands on the session's whole results list with each result, interim and final", () => {
    const onResults = vi.fn();
    const { result } = renderHook(() =>
      useSpeechRecognition({ continuous: true, interimResults: true, onResults }),
    );
    act(() => result.current.startListening());
    const rec = FakeSpeechRecognition.current;

    act(() => rec.say("the salmon is"));
    act(() => rec.say(" should I", false));
    expect(onResults).toHaveBeenLastCalledWith([
      { transcript: "the salmon is", isFinal: true },
      { transcript: " should I", isFinal: false },
    ]);
    act(() => rec.say(" should I air fry it"));
    expect(onResults).toHaveBeenLastCalledWith([
      { transcript: "the salmon is", isFinal: true },
      { transcript: " should I air fry it", isFinal: true },
    ]);
  });

  it("reports an error with its message and code, but never our own abort", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onError }));
    act(() => result.current.startListening());
    const rec = FakeSpeechRecognition.current;

    act(() => rec.fail("not-allowed"));
    expect(onError).toHaveBeenCalledWith(
      "Microphone access denied. Please allow microphone access.",
      "not-allowed",
    );
    expect(result.current.isListening).toBe(false);

    act(() => result.current.startListening());
    act(() => rec.fail("aborted"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("says when a session is aborted by something else (the system taking the mic), never by itself", () => {
    const onAborted = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechRecognition({ onAborted, onError }));
    const rec = FakeSpeechRecognition.current;

    // Chrome aborts a session the hook didn't stop: reported, and not as an error.
    act(() => result.current.startListening());
    act(() => rec.abort());
    expect(onAborted).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // An "aborted" that follows the hook's own stop is its own doing.
    rec.slowStop = true;
    act(() => result.current.startListening());
    act(() => result.current.stopListening());
    act(() => rec.fail("aborted"));
    expect(onAborted).toHaveBeenCalledTimes(1);

    // A fresh start forgets that stop; the hook's own abort on unmount is never reported.
    act(() => result.current.startListening());
    unmount();
    expect(rec.aborted).toBe(true);
    expect(onAborted).toHaveBeenCalledTimes(1);
  });

  it("ignores a start while already listening", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onError }));
    act(() => result.current.startListening());
    expect(() => act(() => result.current.startListening())).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
    expect(FakeSpeechRecognition.current.starts).toBe(1);
  });

  it("tells the caller when a session ends, and stops on request", () => {
    const onEnd = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onEnd }));
    act(() => result.current.startListening());
    act(() => result.current.stopListening());
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(FakeSpeechRecognition.current.running).toBe(false);
    expect(result.current.isListening).toBe(false);
  });

  it("aborts the session on unmount", () => {
    const { result, unmount } = renderHook(() => useSpeechRecognition());
    act(() => result.current.startListening());
    unmount();
    expect(FakeSpeechRecognition.current.aborted).toBe(true);
    expect(FakeSpeechRecognition.current.running).toBe(false);
  });
});
