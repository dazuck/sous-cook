"use client";

import { createTRPCClient, httpLink } from "@trpc/client";
import { useCallback, useSyncExternalStore } from "react";
import {
  createReportOutbox,
  type OutboxEntry,
  type ReportOutbox,
  type StringStore,
} from "@/lib/kitchen/report-outbox";
import { safeLocalStorage } from "@/lib/persist/safe-storage";
import type { AppRouter } from "@/server/routers/_app";

/**
 * The tablet's localStorage (or its in-memory fallback), reached via
 * `safeLocalStorage()` so a blocked origin or WebView never crashes.
 */
const browserStore: StringStore = {
  getItem: (key) => {
    const store = safeLocalStorage();
    if (!store) throw new Error("localStorage unavailable");
    return store.getItem(key);
  },
  setItem: (key, value) => {
    const store = safeLocalStorage();
    if (!store) throw new Error("localStorage unavailable");
    store.setItem(key, value);
  },
  removeItem: (key) => {
    const store = safeLocalStorage();
    if (!store) throw new Error("localStorage unavailable");
    store.removeItem(key);
  },
};

let outbox: ReportOutbox | null = null;

/**
 * The tablet's one outbox (B2 decision 6), made on first use in the browser.
 * It sends through its own unbatched client: a report is up to 320 KB, and
 * one the server refuses must not take another down with it.
 */
export function reportOutbox(): ReportOutbox {
  if (outbox === null) {
    const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: "/api/trpc" })] });
    outbox = createReportOutbox(browserStore, {
      submit: (report) => client.submitCookReport.mutate(report),
      annotate: (id, note) => client.annotateCookReport.mutate({ id, note }),
    });
  }
  return outbox;
}

const NONE: readonly OutboxEntry[] = [];

/**
 * The outbox's entries, newest first, kept current as flags land, send and
 * clear. The server draws none: the outbox is the tablet's, and it is made
 * only in the browser.
 */
export function useReportOutbox(outbox: () => ReportOutbox = reportOutbox): readonly OutboxEntry[] {
  const subscribe = useCallback((listener: () => void) => outbox().subscribe(listener), [outbox]);
  const list = useCallback(() => outbox().list(), [outbox]);
  return useSyncExternalStore(subscribe, list, () => NONE);
}
