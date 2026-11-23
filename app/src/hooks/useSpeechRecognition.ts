"use client";

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";

// Type definitions for Web Speech API
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
    | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

// Extend Window interface
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export interface UseSpeechRecognitionOptions {
  /** Language for recognition (default: 'en-US') */
  lang?: string;
  /** Whether to get interim (in-progress) results (default: true) */
  interimResults?: boolean;
  /** Whether to continue listening after getting a result (default: false) */
  continuous?: boolean;
  /**
   * Callback when an error occurs, with the message shown and the Web Speech
   * error code ("not-allowed", "network", …). Not called for "aborted".
   */
  onError?: (error: string, code: string) => void;
  /** Callback when recognition ends (by user or automatically) */
  onEnd?: () => void;
  /** Callback when a final transcript is received */
  onFinalTranscript?: (transcript: string) => void;
  /**
   * Callback on every result, interim or final, with the session's whole
   * results list in order (a continuous session's earlier results included),
   * for a caller that reads the session as one transcript.
   */
  onResults?: (results: SessionResult[]) => void;
  /**
   * Callback when Chrome aborts a session this hook neither stopped nor
   * aborted. On Android that is most likely a generic recognizer error
   * (`ERROR_CLIENT`) or the page going hidden (Blink aborts then). Our own
   * stop or abort never calls it, and an abort is never an `onError`.
   */
  onAborted?: () => void;
}

/** One result of the session: its best transcript, and whether Chrome has settled it. */
export interface SessionResult {
  transcript: string;
  isFinal: boolean;
}

export interface UseSpeechRecognitionReturn {
  /** Whether the browser is currently listening */
  isListening: boolean;
  /** Whether the browser supports speech recognition */
  isSupported: boolean;
  /** Current error message, if any */
  error: string | null;
  /** Current transcript (interim or final) */
  transcript: string;
  /** Start listening for speech */
  startListening: () => void;
  /** Stop listening */
  stopListening: () => void;
  /** Clear the current transcript */
  resetTranscript: () => void;
  /** Whether the current transcript is final (not interim) */
  isFinal: boolean;
}

/**
 * Check if the browser supports the Web Speech API
 */
function getSpeechRecognitionConstructor():
  | SpeechRecognitionConstructor
  | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

/**
 * Hook for using the Web Speech API for voice input.
 *
 * - Graceful degradation (returns isSupported: false if not available)
 * - Manages listening state, transcript, and errors
 * - Aborts on unmount
 * - The recognizer is rebuilt only when lang, interimResults or continuous
 *   change. Callbacks are read through a ref, so a caller passing inline
 *   functions never aborts a session mid-sentence by re-rendering.
 *
 * Chrome's recognition streams the audio to Google; nothing is recorded here.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionReturn {
  const {
    lang = "en-US",
    interimResults = true,
    continuous = false,
    onError,
    onEnd,
    onFinalTranscript,
    onResults,
    onAborted,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [isFinal, setIsFinal] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isMountedRef = useRef(true);
  const callbacks = useRef({ onError, onEnd, onFinalTranscript, onResults, onAborted });
  // This hook stopped or aborted the session under way, so an "aborted" from
  // it is our own doing; a start clears it.
  const ownStop = useRef(false);
  useLayoutEffect(() => {
    callbacks.current = { onError, onEnd, onFinalTranscript, onResults, onAborted };
  });

  // Check for browser support on mount (client-side only)
  // This is a one-time initialization that must happen client-side
  useEffect(() => {
    const SpeechRecognitionClass = getSpeechRecognitionConstructor();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsSupported(!!SpeechRecognitionClass);
  }, []);

  // Create and configure recognition instance
  useEffect(() => {
    const SpeechRecognitionClass = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionClass) return;

    const recognition = new SpeechRecognitionClass();
    recognition.lang = lang;
    recognition.interimResults = interimResults;
    recognition.continuous = continuous;

    recognition.onstart = () => {
      if (isMountedRef.current) {
        setIsListening(true);
        setError(null);
      }
    };

    recognition.onend = () => {
      if (isMountedRef.current) {
        setIsListening(false);
        callbacks.current.onEnd?.();
      }
    };

    recognition.onerror = (event) => {
      if (!isMountedRef.current) return;

      let errorMessage: string;

      switch (event.error) {
        case "no-speech":
          errorMessage = "No speech detected. Please try again.";
          break;
        case "audio-capture":
          errorMessage = "No microphone found. Please check your device.";
          break;
        case "not-allowed":
          errorMessage =
            "Microphone access denied. Please allow microphone access.";
          break;
        case "network":
          errorMessage = "Network error. Please check your connection.";
          break;
        case "aborted":
          // Not an error: ours, or else said through onAborted.
          errorMessage = "";
          if (!ownStop.current) callbacks.current.onAborted?.();
          break;
        default:
          errorMessage = `Speech recognition error: ${event.error}`;
      }

      if (errorMessage) {
        setError(errorMessage);
        callbacks.current.onError?.(errorMessage, event.error);
      }
      setIsListening(false);
    };

    recognition.onresult = (event) => {
      if (!isMountedRef.current) return;

      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (callbacks.current.onResults) {
        const all: SessionResult[] = [];
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          all.push({ transcript: result[0]?.transcript ?? "", isFinal: result.isFinal });
        }
        callbacks.current.onResults(all);
      }

      if (finalTranscript) {
        setTranscript(finalTranscript);
        setIsFinal(true);
        callbacks.current.onFinalTranscript?.(finalTranscript);
      } else if (interimTranscript) {
        setTranscript(interimTranscript);
        setIsFinal(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      ownStop.current = true;
      recognition.abort();
    };
  }, [lang, interimResults, continuous]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (recognitionRef.current) {
        ownStop.current = true;
        recognitionRef.current.abort();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) {
      setError("Speech recognition not supported");
      return;
    }

    // Clear previous state
    setError(null);
    setTranscript("");
    setIsFinal(false);

    try {
      recognitionRef.current.start();
      // Only a start that took: a refused one leaves the closing session ours.
      ownStop.current = false;
    } catch (e) {
      // Handle case where recognition is already started
      if (e instanceof DOMException && e.name === "InvalidStateError") {
        // Already started, ignore
      } else {
        setError("Failed to start speech recognition");
        callbacks.current.onError?.("Failed to start speech recognition", "start-failed");
      }
    }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      ownStop.current = true;
      recognitionRef.current.stop();
    }
    setIsListening(false);
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setIsFinal(false);
    setError(null);
  }, []);

  return {
    isListening,
    isSupported,
    error,
    transcript,
    startListening,
    stopListening,
    resetTranscript,
    isFinal,
  };
}
