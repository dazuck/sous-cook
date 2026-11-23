// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { keysHeld, stepsOnTop, topLayer } from "./layers";

afterEach(() => {
  document.body.innerHTML = "";
});

function add(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  return holder.firstElementChild as HTMLElement;
}

describe("layers", () => {
  it("finds nothing over the steps on a bare page", () => {
    add("<main>The steps</main><aside>The pane</aside>");
    expect(topLayer()).toBeNull();
    expect(keysHeld()).toBe(false);
    expect(stepsOnTop()).toBe(true);
  });

  it("takes the last modal in the document as the one on top, and only a modal", () => {
    add('<div role="dialog">Not modal</div>');
    expect(topLayer()).toBeNull();
    const library = add('<div role="dialog" aria-modal="true">Library</div>');
    expect(topLayer()).toBe(library);
    const picker = add('<div role="dialog" aria-modal="true">Who is here?</div>');
    expect(topLayer()).toBe(picker);
    expect(stepsOnTop()).toBe(false);
    picker.remove();
    expect(topLayer()).toBe(library);
  });

  it("counts anything that holds the keys as over the steps", () => {
    const menu = add("<div data-holds-keys>More</div>");
    expect(topLayer()).toBeNull();
    expect(keysHeld()).toBe(true);
    expect(stepsOnTop()).toBe(false);
    menu.remove();
    expect(stepsOnTop()).toBe(true);
  });
});
