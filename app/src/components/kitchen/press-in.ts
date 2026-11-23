/**
 * Press-in (P66, FP1; DS §3): a control's sand shows at once on pointer-down
 * and fades out over 320 ms on release. CSS `:active` alone can't promise
 * "at once" on the tablet (Chrome Android holds it back about 100 ms, so a
 * scroll doesn't flash it), so this seam sets `data-pressed` on the nearest
 * pressable the instant the pointer lands, and `globals.css` makes the `active`
 * variant answer to either.
 *
 * Scroll intent isn't a press (the orchestrator's amendment, 2026-10-10): the
 * sand clears with no fade the moment the pointer has moved more than
 * `MOVE_SLOP` px, a scroll starts, the browser cancels the pointer, or the
 * page loses focus. A release is the only thing that fades it out. The "no
 * fade" is `data-press-snap` for the two frames it takes the cleared style to
 * paint, which `globals.css` gives a 0 s transition.
 */

/** How far a pointer may travel before the press is a scroll or a drag, in px. */
export const MOVE_SLOP = 6;

const PRESSABLE =
  "button, a[href], [role='button'], [role='checkbox'], [role='menuitem'], summary, label";

function pressableAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(PRESSABLE);
  if (!el) return null;
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return null;
  return el;
}

/** Starts listening on `doc`; returns the way to stop. */
export function installPressIn(doc: Document = document): () => void {
  let pressed: HTMLElement | null = null;
  let origin: { x: number; y: number } | null = null;
  let pointer: number | null = null;

  const fade = () => {
    pressed?.removeAttribute("data-pressed");
    pressed = null;
    origin = null;
    pointer = null;
  };

  const snap = () => {
    const el = pressed;
    fade();
    if (!el) return;
    el.setAttribute("data-press-snap", "");
    const view = doc.defaultView;
    // Two frames: the cleared style paints with no transition, then the
    // control goes back to its own.
    view?.requestAnimationFrame(() =>
      view.requestAnimationFrame(() => el.removeAttribute("data-press-snap")),
    );
  };

  const down = (e: PointerEvent) => {
    // A second finger is not a press, and doesn't end the first finger's (multi-touch).
    if (!e.isPrimary) return;
    // A stale press (a missed pointer-up) never outlives the next one.
    if (pressed) snap();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = pressableAt(e.target);
    if (!el) return;
    pressed = el;
    origin = { x: e.clientX, y: e.clientY };
    pointer = e.pointerId;
    el.setAttribute("data-pressed", "");
  };

  const move = (e: PointerEvent) => {
    if (!pressed || !origin || e.pointerId !== pointer) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_SLOP) snap();
  };

  const up = (e: PointerEvent) => {
    if (pressed && e.pointerId === pointer) fade();
  };

  const cancel = (e: PointerEvent) => {
    if (pressed && e.pointerId === pointer) snap();
  };

  const interrupt = () => {
    if (pressed) snap();
  };

  // A key press on a control (Enter, Space) is a press too: the sand shows while the key is down.
  const keyDown = (e: KeyboardEvent) => {
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    const el = pressableAt(e.target);
    if (!el || (el.tagName === "A" && e.key === " ")) return;
    if (pressed) snap();
    pressed = el;
    origin = null;
    pointer = null;
    el.setAttribute("data-pressed", "");
  };
  const keyUp = (e: KeyboardEvent) => {
    if (pressed && pointer === null && (e.key === "Enter" || e.key === " ")) fade();
  };

  const view = doc.defaultView;
  doc.addEventListener("pointerdown", down, true);
  doc.addEventListener("pointermove", move, true);
  doc.addEventListener("pointerup", up, true);
  doc.addEventListener("pointercancel", cancel, true);
  doc.addEventListener("scroll", interrupt, true);
  doc.addEventListener("keydown", keyDown, true);
  doc.addEventListener("keyup", keyUp, true);
  doc.addEventListener("visibilitychange", interrupt);
  view?.addEventListener("blur", interrupt);
  return () => {
    doc.removeEventListener("pointerdown", down, true);
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", up, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("scroll", interrupt, true);
    doc.removeEventListener("keydown", keyDown, true);
    doc.removeEventListener("keyup", keyUp, true);
    doc.removeEventListener("visibilitychange", interrupt);
    view?.removeEventListener("blur", interrupt);
    interrupt();
  };
}
