"use client";

import { useId, useRef, useState } from "react";
import { footMask, useMoreBelow } from "@/hooks/useMoreBelow";
import { ACTION, ACTION_AT_REST, ACTION_IN_FORCE } from "./control-style";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";
import { hrefOf, LABEL, ROW_TAP, Row, RowEdit, type KitchenItem } from "./KitchenRows";
import { TimeLineWords } from "./TimeLineWords";

/** The queue screen's words (placeholder copy). */
export const QUEUE_COPY = {
  kind: "Up next",
  edit: "Edit",
  underWay: "Under way",
  madeRecently: "Made recently",
  remove: "Remove",
  markDone: "Mark as done",
  empty: "Nothing queued.",
} as const;

interface QueueScreenProps {
  cooking: KitchenItem[];
  queue: KitchenItem[];
  recent: KitchenItem[];
  onStart: (item: KitchenItem) => void;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onClose: () => void;
}

/**
 * The full queue, as a borrowed screen over the kitchen (P65; FP1 D10): the
 * rows the home used to carry, with Edit, and the cooks under way and Made
 * recently as their own sections. A row is one tap that starts (or goes back
 * into) its cook. Remove and Mark as done wait behind Edit, which is this
 * screen's own state and goes with it; the screen stays open when the last
 * row leaves (F8), saying so in one line.
 */
export function QueueScreen({ cooking, queue, recent, onStart, onRemove, onMarkDone, onClose }: QueueScreenProps) {
  const ids = useId();
  const [editOn, setEditOn] = useState(false);
  const editable = cooking.length + queue.length > 0;
  // Nothing left to edit ends the edit, so a cook queued later isn't met with its Remove already out.
  if (editOn && !editable) setEditOn(false);
  const editing = editOn && editable;
  const nothing = cooking.length + queue.length === 0;
  // A list with more below fades its foot rather than cutting a row against the ledge band (P56).
  const scroller = useRef<HTMLDivElement>(null);
  const below = useMoreBelow(scroller, `${cooking.length}|${queue.length}|${recent.length}|${editing}`);
  const mask = footMask(below);

  return (
    <BorrowedScreen
      kind={QUEUE_COPY.kind}
      back={BACK_TO_KITCHEN}
      onClose={onClose}
      kindTrailing={
        editable && (
          <button
            type="button"
            aria-pressed={editing}
            onClick={() => setEditOn(!editing)}
            className={`${ACTION} ${editing ? ACTION_IN_FORCE : ACTION_AT_REST}`}
          >
            {QUEUE_COPY.edit}
          </button>
        )
      }
    >
      <div data-queue-screen className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          style={{ maskImage: mask, WebkitMaskImage: mask }}
          className={`min-h-0 flex-1 overflow-y-auto pb-[var(--space-4)] ${EDGE_X}`}
        >
          {cooking.length > 0 && (
            <section>
              <h3 id={`${ids}-under-way`} className={`mb-[calc(6*var(--cpx))] ${LABEL}`}>
                {QUEUE_COPY.underWay}
              </h3>
              <ul aria-labelledby={`${ids}-under-way`}>
                {cooking.map((item) => (
                  <Row
                    key={item.id}
                    title={
                      <a href={hrefOf(item)} className={ROW_TAP}>
                        {item.name}
                      </a>
                    }
                    edit={editing ? <RowEdit label={QUEUE_COPY.markDone} onClick={() => onMarkDone(item.id)} /> : undefined}
                    go
                  />
                ))}
              </ul>
            </section>
          )}

          <section className={cooking.length > 0 ? "mt-[var(--space-6)]" : undefined}>
            {queue.length > 0 ? (
              <ul aria-label={QUEUE_COPY.kind}>
                {queue.map((item) => (
                  <Row
                    key={item.id}
                    title={
                      <button type="button" data-row-start onClick={() => onStart(item)} className={ROW_TAP}>
                        {item.name}
                      </button>
                    }
                    slot={item.times && <TimeLineWords parts={item.times} />}
                    edit={editing ? <RowEdit label={QUEUE_COPY.remove} onClick={() => onRemove(item.id)} /> : undefined}
                    go
                  />
                ))}
              </ul>
            ) : (
              nothing && <p className={LABEL}>{QUEUE_COPY.empty}</p>
            )}
          </section>

          {recent.length > 0 && (
            <section data-made-recently className="mt-[var(--space-6)]">
              <h3 id={`${ids}-recent`} className={`mb-[calc(6*var(--cpx))] ${LABEL}`}>
                {QUEUE_COPY.madeRecently}
              </h3>
              <ul aria-labelledby={`${ids}-recent`}>
                {recent.map((item) => (
                  <Row
                    key={item.id}
                    title={
                      <a href={hrefOf(item)} className={ROW_TAP}>
                        {item.name}
                      </a>
                    }
                    go
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </BorrowedScreen>
  );
}
