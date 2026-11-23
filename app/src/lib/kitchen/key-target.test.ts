// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { keyBelongsToTarget } from "./key-target";

/** Dispatches a keydown on `target` and reports what the predicate said. */
function pressOn(target: Element, key: string): boolean {
  let belongs: boolean | undefined;
  const listener = (e: Event) => {
    belongs = keyBelongsToTarget(e as KeyboardEvent);
  };
  window.addEventListener("keydown", listener);
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
  );
  window.removeEventListener("keydown", listener);
  if (belongs === undefined) throw new Error("keydown never reached window");
  return belongs;
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("keyBelongsToTarget", () => {
  it("leaves keys on the page itself to the step navigation", () => {
    mount("<p>Step 3</p>");
    expect(pressOn(document.body, "ArrowRight")).toBe(false);
    expect(pressOn(document.body, "Enter")).toBe(false);
  });

  it.each(["input", "textarea", "select"])(
    "gives every key typed into a %s to the field",
    (tag) => {
      const field = mount(`<${tag}></${tag}>`).querySelector(tag)!;
      expect(pressOn(field, "ArrowLeft")).toBe(true);
      expect(pressOn(field, "Enter")).toBe(true);
    },
  );

  it.each(["video", "audio"])(
    "gives every key pressed on a %s with controls to it",
    (tag) => {
      const media = mount(`<${tag} controls></${tag}>`).querySelector(tag)!;
      expect(pressOn(media, "ArrowRight")).toBe(true);
      expect(pressOn(media, "Enter")).toBe(true);
    },
  );

  it("leaves keys on a video without controls to the step navigation", () => {
    const video = mount("<video></video>").querySelector("video")!;
    expect(pressOn(video, "ArrowRight")).toBe(false);
  });

  it("gives keys typed into editable text to it, down to a nested element", () => {
    const span = mount(
      '<div contenteditable="true"><p><span>note</span></p></div>',
    ).querySelector("span")!;
    expect(pressOn(span, "ArrowRight")).toBe(true);
    expect(pressOn(span, "Enter")).toBe(true);
  });

  it.each([
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
  ])("gives every key pressed on a role=%s widget to the widget", (role) => {
    const widget = mount(
      `<div role="${role}" tabindex="0"><span>item</span></div>`,
    ).querySelector("span")!;
    expect(pressOn(widget, "ArrowRight")).toBe(true);
    expect(pressOn(widget, "Enter")).toBe(true);
  });

  it.each([
    ["a button", "<button>Next</button>", "button"],
    ["a link", '<a href="/kitchen">Back</a>', "a"],
    [
      "a role=button element",
      '<div role="button" tabindex="0">Done</div>',
      "div",
    ],
    ["a summary", "<details><summary>Notes</summary></details>", "summary"],
    [
      "a role=link element",
      '<span role="link" tabindex="0">Recipe</span>',
      "span",
    ],
    [
      "a role=checkbox element",
      '<div role="checkbox" tabindex="0"></div>',
      "div",
    ],
    ["a role=switch element", '<div role="switch" tabindex="0"></div>', "div"],
  ])(
    "gives Enter on %s to the control, so it isn't pressed twice",
    (_label, html, selector) => {
      const control = mount(html).querySelector(selector)!;
      expect(pressOn(control, "Enter")).toBe(true);
    },
  );

  it.each([
    ["a button", "<button>Next</button>", "button"],
    ["a role=switch element", '<div role="switch" tabindex="0"></div>', "div"],
  ])(
    "leaves arrow keys on %s to the step navigation",
    (_label, html, selector) => {
      const control = mount(html).querySelector(selector)!;
      expect(pressOn(control, "ArrowRight")).toBe(false);
      expect(pressOn(control, "ArrowLeft")).toBe(false);
    },
  );

  it("leaves keys on a role it doesn't know to the step navigation", () => {
    const region = mount(
      '<div role="region" tabindex="0">Step 3</div>',
    ).querySelector("div")!;
    expect(pressOn(region, "ArrowRight")).toBe(false);
    expect(pressOn(region, "Enter")).toBe(false);
  });

  it("gives Enter on a button's icon to the button", () => {
    const icon = mount("<button><svg><path /></svg></button>").querySelector(
      "path",
    )!;
    expect(pressOn(icon, "Enter")).toBe(true);
  });

  it("sees a field inside a shadow root, though the event is retargeted to its host", () => {
    const host = mount('<div id="widget"></div>').querySelector("#widget")!;
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).appendChild(input);
    // A browser retargets a window listener's e.target from the input to the
    // shadow host; happy-dom doesn't, so the event is built the way a
    // browser delivers it.
    const retargeted = {
      key: "ArrowLeft",
      target: host,
      composedPath: () => [input, input.getRootNode(), host, document.body],
    } as unknown as KeyboardEvent;
    expect(keyBelongsToTarget(retargeted)).toBe(true);
  });
});
