/**
 * A stand-in for the browser's `AudioContext`, for the sounds Sue makes: the
 * browser boundary, driven by the test. It records what was started (a note
 * of a given wave and pitch, or a decoded clip) and when, on a clock the test
 * moves, and decodes a clip's bytes to a buffer named by their text, so a
 * test can tell which clip played.
 */

import type { AckAudioContext } from "../ack-audio";

export interface Started {
  kind: "note" | "clip";
  at: number;
  /** A note's pitch in Hz. */
  frequency?: number;
  type?: OscillatorType;
  /** The clip's name, from the bytes `clipBytes` made. */
  clip?: string;
}

export class FakeAudioContext {
  state: AudioContextState;
  currentTime = 10;
  destination = {};
  started: Started[] = [];
  resumes = 0;
  /** Names of clips whose bytes fail to decode. */
  undecodable = new Set<string>();

  constructor(state: AudioContextState = "running") {
    this.state = state;
  }

  resume = () => {
    this.resumes += 1;
    return Promise.resolve();
  };

  createGain = () => {
    const node = {
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: (next: unknown) => next,
    };
    return node as unknown as GainNode;
  };

  createOscillator = () => {
    const osc = {
      type: "sine" as OscillatorType,
      frequency: { value: 0 },
      connect: (next: unknown) => next,
      stop: () => undefined,
      start: (at: number) => {
        this.started.push({ kind: "note", at, frequency: osc.frequency.value, type: osc.type });
      },
    };
    return osc as unknown as OscillatorNode;
  };

  createBufferSource = () => {
    const source = {
      buffer: null as unknown as { name: string },
      connect: (next: unknown) => next,
      start: (at: number) => {
        this.started.push({ kind: "clip", at, clip: source.buffer.name });
      },
    };
    return source as unknown as AudioBufferSourceNode;
  };

  decodeAudioData = (bytes: ArrayBuffer) => {
    const name = new TextDecoder().decode(bytes);
    if (this.undecodable.has(name)) return Promise.reject(new Error(`cannot decode ${name}`));
    return Promise.resolve({ name, duration: 1 } as unknown as AudioBuffer);
  };

  as(): AckAudioContext {
    return this as unknown as AckAudioContext;
  }

  notes(): Started[] {
    return this.started.filter((s) => s.kind === "note");
  }

  clips(): string[] {
    return this.started.filter((s) => s.kind === "clip").map((s) => s.clip ?? "");
  }
}

/** The "file" a clip's url names, as bytes the fake context decodes back to that name. */
export function clipBytes(url: string): ArrayBuffer {
  const name = url.replace(/^.*\//, "").replace(/\.mp3$/, "");
  return new TextEncoder().encode(name).buffer as ArrayBuffer;
}
