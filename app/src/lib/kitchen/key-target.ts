// Elements that use arrow keys and Enter themselves: fields, media with
// their own controls, and the ARIA widgets that move a cursor, a value or a
// selection with the arrows. The composite roles (listbox, menu, grid and
// the rest) are there as well as their items because a composite can keep
// focus on itself and point at the active item with aria-activedescendant.
const TAKES_EVERY_KEY = [
  "input",
  "textarea",
  "select",
  "video[controls]",
  "audio[controls]",
  ...[
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton",
    "slider",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "treeitem",
    "gridcell",
    "listbox",
    "menu",
    "menubar",
    "tablist",
    "grid",
    "treegrid",
    "tree",
    "radiogroup",
    "toolbar",
  ].map((role) => `[role="${role}"]`),
].join(", ");

// Controls that Enter activates but that do nothing with the arrows.
const TAKES_ENTER = [
  "button",
  "a[href]",
  "summary",
  ...["button", "link", "checkbox", "switch"].map((role) => `[role="${role}"]`),
].join(", ");

/**
 * Whether a keydown belongs to the element it was pressed on rather than to
 * the cook view's step navigation, which listens on the window.
 *
 * Any key pressed in a field (the Ask Claude box, say) or in a widget that
 * moves with the arrows (a slider, a tab list, a menu) is that element's, so
 * an arrow must not turn the page and Enter must not finish the recipe. Enter
 * on a focused button or link activates that control, so it must not also
 * act as the navigation's Enter: on the last step, a focused Next button
 * would otherwise finish the recipe twice. Arrow keys on a button still turn
 * the page, since a button does nothing with them.
 *
 * The element is read from the event's composed path, so a field inside a
 * shadow root is seen as itself rather than as its host.
 */
export function keyBelongsToTarget(e: KeyboardEvent): boolean {
  const target = e.composedPath()[0] ?? e.target;
  if (!(target instanceof Element)) return false;
  if (
    (target instanceof HTMLElement && target.isContentEditable) ||
    target.closest(TAKES_EVERY_KEY) !== null
  ) {
    return true;
  }
  return e.key === "Enter" && target.closest(TAKES_ENTER) !== null;
}
