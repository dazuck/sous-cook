// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { ReportEvent } from "./report-events";
import {
  DOM_MAX_BYTES,
  buildReport,
  byteLength,
  serializeDom,
  type CaptureInputs,
  type CookSnapshot,
} from "./report-capture";

// The report builder is pure over injected inputs (ported from Player's
// captureReport.test.ts): what a flag says happened is assertable without a
// browser. The cook's state comes from a snapshot the cook screen hands over,
// not from stores, which the app doesn't have.

const added: Element[] = [];

function mount(html: string): HTMLElement {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  const node = holder.content.firstElementChild;
  if (!(node instanceof HTMLElement)) throw new Error("bad test html");
  document.body.appendChild(node);
  added.push(node);
  return node;
}

afterEach(() => {
  for (const node of added.splice(0)) node.remove();
});

const events: ReportEvent[] = [{ at: "2026-10-04T10:00:00.000Z", kind: "voice", detail: "next" }];

const plan = { version: 4, tasks: [{ id: "s1", text: "Toast the chiles" }] };

function cook(overrides?: Partial<CookSnapshot>): CookSnapshot {
  return {
    queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    recipeName: "Mole",
    plan,
    planVersion: 4,
    state: { mode: "go", pos: 3, ticked: ["m1"], passed: ["s1"], kept: [] },
    screen: "step",
    stepKey: "s2+s3",
    chapterId: "batch:s2",
    step: { n: 3, of: 9, name: "Grind the paste" },
    part: { at: 1, of: 2 },
    layers: { pane: true, card: null, more: false },
    voice: { mode: "always", status: "listening" },
    ask: { sessionId: "cook-queue-1770000000000", open: false },
    ...overrides,
  };
}

function inputs(root: Element, overrides?: Partial<CaptureInputs>): CaptureInputs {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    now: 1_770_000_000_000,
    build: "b-123",
    href: "https://kitchen.example.com/kitchen/queue/4b1d?fixture=mole#top",
    online: true,
    ua: "test-agent",
    viewport: { w: 1280, h: 800, dpr: 2 },
    root,
    cook: cook(),
    events,
    ...overrides,
  };
}

describe("buildReport", () => {
  it("carries the moment: id, time, build, viewport, connectivity, agent, events", () => {
    const report = buildReport(inputs(mount("<div></div>")));
    expect(report.id).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(report.capturedAt).toBe(new Date(1_770_000_000_000).toISOString());
    expect(report.build).toBe("b-123");
    expect(report.context.viewport).toEqual({ w: 1280, h: 800, dpr: 2 });
    expect(report.context.online).toBe(true);
    expect(report.context.ua).toBe("test-agent");
    expect(report.events).toEqual(events);
  });

  it("keeps the route's path and drops its query and hash", () => {
    const report = buildReport(inputs(mount("<div></div>")));
    expect(report.path).toBe("/kitchen/queue/4b1d");
  });

  it("carries the cook: queue item, recipe, plan with its version, state", () => {
    const report = buildReport(inputs(mount("<div></div>")));
    expect(report.queueId).toBe("4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a");
    expect(report.recipeName).toBe("Mole");
    expect(report.plan).toEqual(plan);
    expect(report.planVersion).toBe(4);
    expect(report.state).toEqual({ mode: "go", pos: 3, ticked: ["m1"], passed: ["s1"], kept: [] });
  });

  it("names where the cook was: screen, step, chapter, part, layers", () => {
    const report = buildReport(
      inputs(mount("<div></div>"), {
        cook: cook({ screen: "all-steps", layers: { pane: false, card: "screen", more: false } }),
      }),
    );
    expect(report.screen).toBe("all-steps");
    expect(report.stepKey).toBe("s2+s3");
    expect(report.chapterId).toBe("batch:s2");
    expect(report.context.part).toEqual({ at: 1, of: 2 });
    expect(report.context.layers).toEqual({ pane: false, card: "screen", more: false });
  });

  it("carries voice and Ask's session id, so the reader can join conversation_logs", () => {
    const report = buildReport(
      inputs(mount("<div></div>"), {
        cook: cook({ ask: { sessionId: "cook-queue-42", open: true } }),
      }),
    );
    expect(report.context.voice).toEqual({ mode: "always", status: "listening" });
    expect(report.context.ask).toEqual({ sessionId: "cook-queue-42", open: true });
  });

  it("snapshots the cook root's markup", () => {
    const root = mount('<div data-cook-root><main aria-label="Cook">Step text</main></div>');
    const report = buildReport(inputs(root));
    expect(report.dom).toContain("data-cook-root");
    expect(report.dom).toContain("Step text");
    expect(report.domTruncated).toBe(false);
  });

  it("starts with no note: only a hand knows why a screen was flagged", () => {
    expect(buildReport(inputs(mount("<div></div>"))).note).toBe("");
  });

  it("holds data only: what the snapshot carries round-trips through JSON", () => {
    const report = buildReport(inputs(mount("<div></div>")));
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("carries no cookies, storage, env or IP (F12): exactly its named fields", () => {
    document.cookie = "sb-session=secret-cookie";
    try {
      const report = buildReport(
        inputs(mount("<div>screen</div>"), {
          cook: cook({ ask: { sessionId: "cook-queue-1", open: true } }),
        }),
      );
      expect(JSON.stringify(report)).not.toContain("secret-cookie");
      // A field added later has to be added here, on purpose.
      expect(Object.keys(report).sort()).toEqual(
        [
          "build",
          "capturedAt",
          "chapterId",
          "context",
          "dom",
          "domTruncated",
          "events",
          "id",
          "note",
          "path",
          "plan",
          "planVersion",
          "queueId",
          "recipeName",
          "screen",
          "state",
          "stepKey",
        ].sort(),
      );
      expect(Object.keys(report.context).sort()).toEqual(
        ["ask", "layers", "online", "part", "ua", "viewport", "voice"].sort(),
      );
      expect(Object.keys(report.context.ask).sort()).toEqual(["open", "sessionId"]);
    } finally {
      document.cookie = "sb-session=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    }
  });
});

describe("serializeDom: a photo in Ask's conversation (review round 1)", () => {
  it("leaves the photo's data out and says one was there; the words stay", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-ask-thread><div data-from="cook"><img alt="Dish photo" data-ask-photo="" src="data:image/jpeg;base64,AAAASECRETBYTES"><p>Check against this step</p></div>' +
      '<div data-from="sous"><p>Golden at the edges.</p></div></div><img alt="logo" src="/icon-192.png">';
    const { dom } = serializeDom(root);
    expect(dom).not.toContain("AAAASECRETBYTES");
    expect(dom).not.toContain("data:image");
    const read = document.createElement("div");
    read.innerHTML = dom;
    const photo = read.querySelector("[data-ask-photo]")!;
    expect(photo.hasAttribute("src")).toBe(false);
    expect(photo.hasAttribute("data-capture-redacted")).toBe(true);
    expect(photo.getAttribute("alt")).toBe("Dish photo");
    expect(read.textContent).toContain("Check against this step");
    expect(read.textContent).toContain("Golden at the edges.");
    // A picture that is the app's own keeps its address.
    expect(read.querySelector('img[alt="logo"]')!.getAttribute("src")).toBe("/icon-192.png");
    // The screen itself is untouched.
    expect(root.querySelector("[data-ask-photo]")!.getAttribute("src")).toContain("AAAASECRETBYTES");
  });
});

describe("serializeDom", () => {
  it("drops what is marked data-capture-omit from the clone, not from the screen", () => {
    const root = mount(
      '<div><p>under the menu</p><div data-capture-omit id="menu"><button>Flag this screen</button></div></div>',
    );
    const { dom } = serializeDom(root);
    expect(dom).toContain("under the menu");
    expect(dom).not.toContain("Flag this screen");
    // The live menu is untouched.
    expect(document.getElementById("menu")).not.toBeNull();
    expect(root.textContent).toContain("Flag this screen");
  });

  describe("words typed and not sent stay on the tablet (F12)", () => {
    it("drops a text field's value, as React writes it to the attribute", () => {
      const root = mount('<div><input type="text" placeholder="Ask Sous"></div>');
      const field = root.querySelector("input")!;
      field.setAttribute("value", "is the oil hot enough");
      field.value = "is the oil hot enough";
      const { dom } = serializeDom(root);
      expect(dom).not.toContain("is the oil hot enough");
      expect(dom).toContain('placeholder="Ask Sous"');
      expect(dom).toContain("data-capture-redacted");
      // The live field keeps its words.
      expect(field.value).toBe("is the oil hot enough");
    });

    it("drops a textarea's text", () => {
      const root = mount("<div><textarea>my half-written question</textarea></div>");
      const { dom } = serializeDom(root);
      expect(dom).not.toContain("my half-written question");
      expect(dom).toContain("<textarea data-capture-redacted");
      expect(root.querySelector("textarea")!.value).toBe("my half-written question");
    });

    it("drops what is typed into an editable element, at any depth", () => {
      const root = mount(
        '<div><div contenteditable="true"><p>draft <b>words</b></p></div><div contenteditable="plaintext-only">more</div></div>',
      );
      const { dom } = serializeDom(root);
      expect(dom).not.toContain("draft");
      expect(dom).not.toContain("words");
      expect(dom).not.toContain("more");
    });

    it("marks only a field that held words, and keeps a button's label and an element that isn't editable", () => {
      const root = mount(
        '<div><input type="text"><input type="submit" value="Send"><div contenteditable="false">the step</div></div>',
      );
      const { dom } = serializeDom(root);
      expect(dom).not.toContain("data-capture-redacted");
      expect(dom).toContain('value="Send"');
      expect(dom).toContain("the step");
    });
  });

  it("keeps a DOM at the cap whole", () => {
    const filler = "a".repeat(DOM_MAX_BYTES - "<div></div>".length);
    const root = mount(`<div>${filler}</div>`);
    const { dom, truncated } = serializeDom(root);
    expect(byteLength(dom)).toBe(DOM_MAX_BYTES);
    expect(truncated).toBe(false);
  });

  // Measured 2026-10-04 on the e2e build at 1280×800, the whole cook's pane
  // open, flagged by touch: mole 24.7 KB, roast 35.3 KB, neither cut. The cap
  // is for a screen gone wrong (a runaway list), not for the screens we have.
  it("cuts a DOM over the cap to 200 KB and says so", () => {
    expect(DOM_MAX_BYTES).toBe(200 * 1024);
    const root = mount(`<div>${"a".repeat(DOM_MAX_BYTES)}</div>`);
    const { dom, truncated } = serializeDom(root);
    expect(byteLength(dom)).toBe(DOM_MAX_BYTES);
    expect(truncated).toBe(true);
    expect(dom.startsWith("<div>aaa")).toBe(true);
  });

  it("cuts in bytes, never leaving half a character", () => {
    // Three-byte characters across the cut: the cut lands on a whole one.
    const root = mount(`<div>${"é€".repeat(DOM_MAX_BYTES / 2)}</div>`);
    const { dom, truncated } = serializeDom(root);
    expect(truncated).toBe(true);
    expect(byteLength(dom)).toBeLessThanOrEqual(DOM_MAX_BYTES);
    expect(byteLength(dom)).toBeGreaterThan(DOM_MAX_BYTES - 4);
    expect(dom).not.toContain("�");
  });

  it("a report over the cap carries the cut DOM and its flag", () => {
    const root = mount(`<div>${"a".repeat(DOM_MAX_BYTES + 10)}</div>`);
    const report = buildReport(inputs(root));
    expect(report.domTruncated).toBe(true);
    expect(byteLength(report.dom)).toBe(DOM_MAX_BYTES);
  });
});
