/**
 * Schema-checked localStorage for what the tablet keeps between loads (slice
 * B5a, A6; ported from the Player's `stores/persistence.ts`, without zustand).
 * Timers (B5a) and the cook session (B5b) are stored through it.
 *
 * A value is stored in an envelope, `{ version, state }`. Reading it back
 * checks the version and the shape: stored data that isn't JSON, has drifted
 * from the schema, or was written at another version is cleared, and the
 * clearing is recorded as a notice for the UI to say once ("Saved timers
 * couldn't be read and were reset."). A reset the cook can see is recovery; a
 * silent one is data loss (the Player's failure mode 11).
 *
 * Storage that is missing (the server) or throws (private browsing, blocked
 * site data, a full quota) is not corruption: a read gives nothing, a write
 * reports false, and both are logged. What is kept is a convenience; the
 * kitchen never breaks over it.
 */

import type { ZodType } from "zod";

export interface StringStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ListedStore extends StringStore {
  readonly length: number;
  key(index: number): string | null;
}

const STORAGE_PROBE_KEY = "__sous_storage_probe__";

function createMemoryStore(map: Map<string, string>): ListedStore {
  return {
    get length() {
      return map.size;
    },
    key(index: number): string | null {
      if (index < 0 || index >= map.size) return null;
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

const localMemoryMap = new Map<string, string>();
const sessionMemoryMap = new Map<string, string>();

export const memoryLocalStore: ListedStore = createMemoryStore(localMemoryMap);
export const memorySessionStore: ListedStore = createMemoryStore(sessionMemoryMap);

/** Clear both in-memory fallback stores (for unit tests). */
export function resetMemoryStorageForTests(): void {
  localMemoryMap.clear();
  sessionMemoryMap.clear();
}

function probeStorage(getNative: () => Storage | undefined, fallback: ListedStore): ListedStore | null {
  try {
    const store = getNative();
    if (store === undefined) {
      return typeof window === "undefined" ? null : fallback;
    }
    const existing = store.getItem(STORAGE_PROBE_KEY);
    store.setItem(STORAGE_PROBE_KEY, existing ?? "1");
    if (existing === null) {
      store.removeItem(STORAGE_PROBE_KEY);
    }
    return store;
  } catch {
    if (typeof window === "undefined") return null;
    return fallback;
  }
}

/**
 * The browser's localStorage when accessible, an in-memory ListedStore when
 * `localStorage` getter or write throws `SecurityError` (e.g. a sandboxed WebView),
 * or `null` on the server.
 */
export function safeLocalStorage(): ListedStore | null {
  return probeStorage(
    () =>
      typeof window !== "undefined"
        ? window.localStorage
        : typeof localStorage === "undefined"
          ? undefined
          : localStorage,
    memoryLocalStore,
  );
}

/**
 * The browser's sessionStorage when accessible, an in-memory ListedStore when
 * `sessionStorage` getter or write throws `SecurityError` (e.g. a sandboxed WebView),
 * or `null` on the server.
 */
export function safeSessionStorage(): ListedStore | null {
  return probeStorage(
    () =>
      typeof window !== "undefined"
        ? window.sessionStorage
        : typeof sessionStorage === "undefined"
          ? undefined
          : sessionStorage,
    memorySessionStore,
  );
}

/** A stored value that couldn't be read and was cleared. */
export interface CorruptionNotice {
  /** The storage key. */
  store: string;
  reason: string;
  /**
   * What the UI says about it, from the store that read it (B5b fix round 1):
   * each kind of kept data words its own reset, so a cook session's never
   * reads as the timers'. Absent when the reader gave none.
   */
  text?: string;
}

const notices: CorruptionNotice[] = [];
const listeners = new Set<() => void>();

/** Read and clear the pending notices: the UI shows each once. */
export function consumeCorruptionNotices(): CorruptionNotice[] {
  return notices.splice(0, notices.length);
}

/** Hear when a notice arrives. Returns the unsubscribe. */
export function subscribeCorruptionNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function report(store: string, reason: string, text: string | undefined): void {
  notices.push(text === undefined ? { store, reason } : { store, reason, text });
  for (const listener of listeners) listener();
}

/**
 * The page's localStorage (or in-memory fallback when blocked), or null on the server.
 */
function browserStore(): StringStore | null {
  return safeLocalStorage();
}

/**
 * The page's sessionStorage when accessible, or null where sessionStorage is
 * missing (the server) or touching it throws (blocked site data).
 */
export function browserSessionStore(): StringStore | null {
  try {
    const store =
      typeof window !== "undefined"
        ? window.sessionStorage
        : typeof sessionStorage === "undefined"
          ? undefined
          : sessionStorage;
    if (store === undefined) return null;
    const existing = store.getItem(STORAGE_PROBE_KEY);
    store.setItem(STORAGE_PROBE_KEY, existing ?? "1");
    if (existing === null) {
      store.removeItem(STORAGE_PROBE_KEY);
    }
    return store;
  } catch {
    return null;
  }
}

function clear(key: string, store: StringStore): void {
  try {
    store.removeItem(key);
  } catch (err) {
    console.warn(`Could not clear stored ${key}:`, err);
  }
}

/**
 * The value stored under `key`, checked against `schema` at `version`; null
 * when nothing is stored, storage can't be read, or the stored value was
 * cleared as corrupt (with a notice, carrying `resetText` when given).
 */
export function readStored<S>(
  key: string,
  schema: ZodType<S>,
  backing: StringStore | null = browserStore(),
  version = 1,
  resetText?: string,
): S | null {
  if (backing === null) return null;
  let raw: string | null;
  try {
    raw = backing.getItem(key);
  } catch (err) {
    console.warn(`Could not read stored ${key}:`, err);
    return null;
  }
  if (raw === null) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    clear(key, backing);
    report(key, "stored data was not valid JSON", resetText);
    return null;
  }

  const { state, version: storedVersion } =
    typeof envelope === "object" && envelope !== null
      ? (envelope as { state?: unknown; version?: unknown })
      : {};
  if (typeof storedVersion === "number" && storedVersion !== version) {
    clear(key, backing);
    report(key, "stored data was written by another version", resetText);
    return null;
  }
  const parsed = schema.safeParse(state);
  if (storedVersion === undefined || !parsed.success) {
    clear(key, backing);
    report(key, "stored data did not match the expected shape", resetText);
    return null;
  }
  return parsed.data;
}

/** Store `value` under `key`; false (and logged) when storage refuses it. */
export function writeStored<S>(
  key: string,
  value: S,
  backing: StringStore | null = browserStore(),
  version = 1,
): boolean {
  if (backing === null) return false;
  try {
    backing.setItem(key, JSON.stringify({ version, state: value }));
    return true;
  } catch (err) {
    console.warn(`Could not store ${key}:`, err);
    return false;
  }
}

/** Remove `key`; a refusal is logged, never thrown. */
export function removeStored(key: string, backing: StringStore | null = browserStore()): void {
  if (backing === null) return;
  clear(key, backing);
}
