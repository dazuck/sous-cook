// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecipeExtraction } from "@/lib/recipe-import";
import { RecipeImportModal } from "./RecipeImportModal";

// B4 fix round 1, MED 3: the server refuses a recipe the cook page couldn't
// read. The modal waits for the add, and on a refusal stays open with the
// recipe and says so, instead of closing as if it had been queued.

afterEach(cleanup);

const EXTRACTION: RecipeExtraction = {
  recipe: { name: "Lemon Pasta", ingredients: [{ item: "spaghetti" }], steps: ["Boil."] },
  notices: [],
};

/** A tRPC client error as the add's mutateAsync rejects with it. */
function refusal(code: string): Error {
  return Object.assign(new Error("Recipe can't be read as a pack recipe: steps.0.text: …"), {
    data: { code },
  });
}

async function previewed(onAdd: () => Promise<void>, onStart: () => Promise<void>) {
  const onClose = vi.fn();
  render(
    <RecipeImportModal
      isOpen
      onClose={onClose}
      onImport={onAdd}
      onStartCooking={onStart}
      onImportFromUrl={() => Promise.resolve(EXTRACTION)}
      onImportFromText={() => Promise.resolve(null)}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText("https://cooking.nytimes.com/recipes/..."), {
    target: { value: "https://example.com/pasta" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import recipe" }));
  await screen.findByRole("heading", { name: "Lemon Pasta", level: 3 });
  return { onClose };
}

describe("RecipeImportModal: an add the server refuses", () => {
  it.each(["Add to queue", "Start cooking"])(
    "%s: a recipe the app can't read keeps the modal open and says so",
    async (action) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const reject = () => Promise.reject(refusal("UNPROCESSABLE_CONTENT"));
      const { onClose } = await previewed(reject, reject);
      fireEvent.click(screen.getByRole("button", { name: action }));
      await screen.findByText("Couldn't read that recipe, so it wasn't added.");
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "Lemon Pasta", level: 3 })).toBeTruthy();
      // The server's own words are not the cook's.
      expect(screen.queryByText(/pack recipe/)).toBeNull();
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    },
  );

  it("a serving count Sous couldn't estimate (B4b) keeps the modal open and says so", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reject = () => Promise.reject(refusal("PRECONDITION_FAILED"));
    const { onClose } = await previewed(reject, reject);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await screen.findByText("Couldn't work out how many that serves, so it wasn't added. Try again.");
    expect(onClose).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("any other failure says the add failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reject = () => Promise.reject(refusal("INTERNAL_SERVER_ERROR"));
    const { onClose } = await previewed(reject, reject);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await screen.findByText("Couldn't add that recipe. Try again.");
    expect(onClose).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("an add that succeeds closes the modal", async () => {
    const ok = () => Promise.resolve();
    const { onClose } = await previewed(ok, ok);
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
