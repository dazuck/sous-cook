"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  buildReport,
  type CookReport,
  type CookSnapshot,
  type FlagStep,
} from "@/lib/kitchen/report-capture";
import { flagMisses, type Miss } from "@/lib/kitchen/flag-misses";
import { recentEvents, recordEvent, redactError } from "@/lib/kitchen/report-events";
import type { FlagResult } from "@/lib/kitchen/report-outbox";
import { reportOutbox } from "./useReportOutbox";

/**
 * How long the More pill says how a flag went (B2 decision 3): "Noted", or
 * "Not kept" for a flag the tablet couldn't keep, which then waits in the
 * hub's label rather than hold over the cook (panel round 4).
 */
export const FLAG_ACK_MS = 1600;

/** A second flag this soon at the same place is the same flag, pressed twice (F5). */
export const FLAG_FOLD_MS = 2000;

/** What the pill says: nothing of its own, or how the last flag went. */
export type FlagAck = "idle" | FlagResult;

export interface CookFlagDeps {
  /** Keeps the report, with the step in hand for the panel's row. */
  add: (report: CookReport, step: FlagStep | null) => Promise<FlagResult>;
  now: () => number;
  id: () => string;
  build: () => string;
  /** Logs a flag not kept, for the hub and the panel to say. */
  miss: (why: Miss) => void;
  /** Writes the cook's note on a kept flag, by its id (the outbox sends it). */
  annotate: (id: string, note: string) => void;
  /** The note a kept flag holds now, by its id ("" for none). */
  noteOf: (id: string) => string;
}

/**
 * What a flag took, said at once: a capture kept (stored, or on its way),
 * folded into the one before it, or one that couldn't be captured.
 */
export type FlagTake = { kind: "kept"; id: string } | { kind: "folded"; id: string } | { kind: "failed" };

const browserDeps: CookFlagDeps = {
  add: (report, step) => reportOutbox().add(report, step),
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
  build: () => {
    // next.config.ts bakes it into every bundle.
    const build = process.env.SOUS_BUILD_ID;
    if (build === undefined) throw new Error("No build id: next.config.ts sets SOUS_BUILD_ID");
    return build;
  },
  miss: (why) => flagMisses.add(why),
  annotate: (id, note) => reportOutbox().annotate(id, note),
  noteOf: (id) => reportOutbox().list().find((e) => e.id === id)?.note ?? "",
};

interface Taken {
  id: string;
  at: number;
  pos: number;
  result: Promise<FlagResult>;
}

/**
 * The flag on the cook page, by touch or voice (B2 decisions 2–5): the screen
 * is captured in the call, before React draws anything the same tap caused,
 * from the cook root (`data-cook-root`) and the snapshot the cook screen
 * hands over. The capture goes to the outbox, and `ack` says how it went for
 * 1.6 s: "flagged", or a flag not kept ("failed", "full"), which also goes
 * to the miss log. A flag that can't be captured says so and logs why.
 *
 * `flag` answers at once with what it took, and `kept` names the latest flag
 * the outbox answered "flagged" for, so the cook can say what read wrong
 * (cook-fidelity decision 8): `annotate` writes a note on a flag through the
 * outbox, sent with the report or after it (`annotateCookReport`). A flag the
 * tablet didn't keep is never `kept`.
 */
export function useCookFlag(
  snapshot: () => CookSnapshot,
  deps: CookFlagDeps = browserDeps,
): CookFlag {
  const [ack, setAck] = useState<FlagAck>("idle");
  const [kept, setKept] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taken = useRef<Taken | null>(null);

  // The flag reads the latest of both from a tap or a recognizer callback.
  const latest = useRef({ snapshot, deps });
  useLayoutEffect(() => {
    latest.current = { snapshot, deps };
  });

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const acknowledge = useCallback((result: FlagResult) => {
    setAck(result);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setAck("idle");
    }, FLAG_ACK_MS);
  }, []);

  const flag = useCallback((): FlagTake => {
    const { snapshot: read, deps: d } = latest.current;
    const at = d.now();
    let report: CookReport;
    let step: FlagStep | null;
    try {
      const cook = read();
      step = cook.step;
      const last = taken.current;
      if (last !== null && at - last.at < FLAG_FOLD_MS && last.pos === cook.state.pos) {
        recordEvent("flag", "folded into the flag before it");
        void last.result.then(acknowledge);
        return { kind: "folded", id: last.id };
      }
      const root = document.querySelector("[data-cook-root]");
      if (root === null) throw new Error("no cook root on the page");
      report = buildReport({
        id: d.id(),
        now: at,
        build: d.build(),
        href: window.location.href,
        online: navigator.onLine,
        ua: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        root,
        cook,
        events: recentEvents(),
      });
    } catch (error) {
      console.error("The flag could not capture the screen", error);
      recordEvent("error", redactError(`flag capture failed: ${String(error)}`));
      d.miss("failed");
      acknowledge("failed");
      return { kind: "failed" };
    }
    const result = d.add(report, step);
    const id = report.id;
    recordEvent("flag", `${report.screen} at ${String(report.state.pos)}`);
    // Only a capture the outbox holds is folded into: after "Not kept",
    // pressing again is a fresh try.
    taken.current = { id, at, pos: report.state.pos, result };
    void result.then((outcome) => {
      if (outcome === "flagged") setKept(id);
      else {
        d.miss(outcome);
        if (taken.current?.result === result) taken.current = null;
      }
      acknowledge(outcome);
    });
    return { kind: "kept", id };
  }, [acknowledge]);

  const annotate = useCallback((id: string, note: string) => {
    latest.current.deps.annotate(id, note);
  }, []);
  const noteOf = useCallback((id: string) => latest.current.deps.noteOf(id), []);

  return { ack, flag, kept, annotate, noteOf };
}

/** The flag on the cook page, as `useCookFlag` hands it over. */
export interface CookFlag {
  ack: FlagAck;
  flag: () => FlagTake;
  /** The latest flag the outbox kept ("flagged"), or none yet. */
  kept: string | null;
  annotate: (id: string, note: string) => void;
  noteOf: (id: string) => string;
}

/** The flag's note as More draws it (`HeaderMore`'s `flagNote`). */
export interface FlagNoteProps {
  open: boolean;
  /**
   * What the field holds. Kept here, not in the panel, so a panel drawn
   * afresh while open (the sheet's More and the header's trade places)
   * carries on from it rather than start empty and save over the note.
   */
  draft: string;
  onDraft: (draft: string) => void;
  onSave: (note: string) => void;
  onClose: () => void;
}

/**
 * A flag by touch opens its note (cook-fidelity decision 8) once the outbox
 * has kept it, never before: a flag refused ("Not kept", the outbox full)
 * opens nothing, rather than open and shut again a moment later. It opens as
 * the cook view's one open menu, "flag", and only if nothing else has opened
 * since the press; the note is pinned to the flag it opened for, and starts
 * from the note that flag holds.
 */
export function useFlagNote<M extends string>(
  { flag, kept, annotate, noteOf }: Pick<CookFlag, "flag" | "kept" | "annotate" | "noteOf">,
  menu: M | "flag" | null,
  setMenu: (menu: "flag" | null) => void,
): { flagByTouch: () => void; note: FlagNoteProps } {
  const [wanted, setWanted] = useState<string | null>(null);
  const [on, setOn] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The note as this panel last left it: only a change made here is written,
  // so closing never writes over a note another tab saved meanwhile.
  const [saved, setSaved] = useState("");
  const flagByTouch = useCallback(() => {
    const take = flag();
    setWanted(take.kind === "failed" ? null : take.id);
  }, [flag]);
  // Shut in the render that finds them, rather than an effect a render later.
  if (wanted !== null && wanted === kept) {
    setWanted(null);
    if (menu === null) {
      setOn(kept);
      const held = noteOf(kept);
      setDraft(held);
      setSaved(held);
      setMenu("flag");
    }
  } else if (on !== null && menu !== "flag") setOn(null);
  return {
    flagByTouch,
    note: {
      open: menu === "flag" && on !== null,
      draft,
      onDraft: setDraft,
      // The panel saves as it goes, every way out; a note cleared is removed.
      onSave: (note) => {
        if (on === null || note === saved) return;
        annotate(on, note);
        setSaved(note);
      },
      onClose: () => setMenu(null),
    },
  };
}
