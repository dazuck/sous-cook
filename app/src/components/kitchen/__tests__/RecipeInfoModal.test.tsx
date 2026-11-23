// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTAKE_COPY } from "@/lib/kitchen/cook-open";
import { RecipeInfoModal } from "../RecipeInfoModal";

afterEach(() => cleanup());

const VOICE_OFF = { status: "off" as const, echo: null };

describe("RecipeInfoModal source-pack attribution", () => {
  it("renders human attribution and shelf link for a verbatim pack recipe without broken pack: href", () => {
    const { container } = render(
      <RecipeInfoModal
        isOpen={true}
        onClose={() => {}}
        name="Thin White Sauce"
        source="pack:fannie-farmer-1896/thin-white-sauce"
        sourcePack={{
          packId: "fannie-farmer-1896",
          packTitle: "The Boston Cooking-School Cook Book",
          creatorName: "Fannie Merritt Farmer",
          recipeId: "thin-white-sauce",
          recipeTitle: "Thin White Sauce",
          isAdapted: false,
        }}
        times={null}
        voice={VOICE_OFF}
      />,
    );

    const attribution = container.querySelector("[data-pack-attribution]");
    expect(attribution?.textContent).toBe(
      "From Fannie Merritt Farmer: Thin White Sauce (The Boston Cooking-School Cook Book)",
    );

    const shelfLink = screen.getByRole("link", { name: /Open pack on shelf/i });
    expect(shelfLink.getAttribute("href")).toBe(
      "/kitchen/cookpacks/fannie-farmer-1896",
    );

    expect(
      screen.queryByRole("link", { name: /View original recipe/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Cook original from pack/i }),
    ).toBeNull();
  });

  it("renders 'Adapted from ...' and 'Cook original from pack' button for an adapted pack recipe", () => {
    const onCookOriginal = vi.fn();

    const { container } = render(
      <RecipeInfoModal
        isOpen={true}
        onClose={() => {}}
        name="Weeknight Gruyere White Sauce"
        source="pack:fannie-farmer-1896/thin-white-sauce"
        sourcePack={{
          packId: "fannie-farmer-1896",
          packTitle: "The Boston Cooking-School Cook Book",
          creatorName: "Fannie Merritt Farmer",
          recipeId: "thin-white-sauce",
          recipeTitle: "Thin White Sauce",
          isAdapted: true,
        }}
        onCookOriginal={onCookOriginal}
        times={null}
        voice={VOICE_OFF}
      />,
    );

    const attribution = container.querySelector("[data-pack-attribution]");
    expect(attribution?.textContent).toBe(
      "Adapted from Fannie Merritt Farmer: Thin White Sauce (The Boston Cooking-School Cook Book)",
    );

    const shelfLink = screen.getByRole("link", { name: /Open pack on shelf/i });
    expect(shelfLink.getAttribute("href")).toBe(
      "/kitchen/cookpacks/fannie-farmer-1896",
    );

    const cookOriginalBtn = screen.getByRole("button", {
      name: /Cook original from pack/i,
    });
    fireEvent.click(cookOriginalBtn);
    expect(onCookOriginal).toHaveBeenCalledTimes(1);
  });

  it("preserves external HTTP links for web-imported recipes", () => {
    render(
      <RecipeInfoModal
        isOpen={true}
        onClose={() => {}}
        name="Harissa Chicken"
        source="https://example.com/harissa-chicken"
        times={null}
        voice={VOICE_OFF}
      />,
    );

    const link = screen.getByRole("link", { name: /View original recipe/i });
    expect(link.getAttribute("href")).toBe(
      "https://example.com/harissa-chicken",
    );
  });
});

describe("RecipeInfoModal: a recipe shown as sent (cook-fidelity plan)", () => {
  it("says so when intake couldn't cut it", () => {
    const { container } = render(
      <RecipeInfoModal isOpen={true} onClose={() => {}} name="Risotto" shownAsSent times={null} voice={VOICE_OFF} />,
    );
    expect(container.querySelector("[data-shown-as-sent]")?.textContent).toBe(INTAKE_COPY.shownAsSent);
  });

  it("says nothing for a recipe cut, or never sent for cutting", () => {
    const { container } = render(
      <RecipeInfoModal isOpen={true} onClose={() => {}} name="Risotto" times={null} voice={VOICE_OFF} />,
    );
    expect(container.querySelector("[data-shown-as-sent]")).toBeNull();
  });
});
