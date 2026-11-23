import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

function makeRequest(
  path = "/api/packs",
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "GET",
    headers,
  });
}

describe("GET /api/packs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
  });

  it("rejects missing or invalid Bearer token in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KITCHEN_QUEUE_API_TOKEN", "secret-pack-token");

    const noTokenRes = await GET(makeRequest("/api/packs"));
    expect(noTokenRes.status).toBe(401);

    const wrongTokenRes = await GET(
      makeRequest("/api/packs", { Authorization: "Bearer wrong-token" }),
    );
    expect(wrongTokenRes.status).toBe(401);

    const okRes = await GET(
      makeRequest("/api/packs", { Authorization: "Bearer secret-pack-token" }),
    );
    expect(okRes.status).toBe(200);
  });

  it("returns the creator pack digest for installed shelf packs", async () => {
    const res = await GET(makeRequest("/api/packs"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      packs: Array<{
        id: string;
        title: string;
        creator: { name: string; handle: string };
        description: string;
        recipes: Array<{
          id: string;
          title: string;
          time_total_min: number;
          time_active_min: number;
          tags: string[];
          main_ingredients: string[];
          hook: string;
        }>;
      }>;
    };

    expect(Array.isArray(body.packs)).toBe(true);
    const fannie = body.packs.find((p) => p.id === "fannie-farmer-1896");
    expect(fannie).toBeDefined();
    expect(fannie?.title).toBe("The Boston Cooking-School Cook Book");
    expect(fannie?.creator.name).toBe("Fannie Merritt Farmer");
    expect(fannie?.recipes.length).toBeGreaterThanOrEqual(5);

    const whiteSauce = fannie?.recipes.find((r) => r.id === "thin-white-sauce");
    expect(whiteSauce).toBeDefined();
    expect(whiteSauce?.title).toBe("Thin White Sauce");
    expect(whiteSauce?.main_ingredients).toContain("Butter");
    expect(whiteSauce?.main_ingredients).toContain("Milk");
    expect(typeof whiteSauce?.hook).toBe("string");
  });

  it("returns full recipe, pack header, library subset, and projection for ?pack=&recipe=", async () => {
    const res = await GET(
      makeRequest("/api/packs?pack=fannie-farmer-1896&recipe=boiled-custard"),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      pack: { id: string; title: string; creator: { name: string } };
      recipe: { id: string; title: string; steps: unknown[]; ingredients: unknown[] };
      library: {
        states: Array<{ id: string }>;
        commons: Array<{ id: string }>;
      };
      projection: {
        name: string;
        source: string;
        ingredients: unknown[];
        steps: string[];
      } | null;
    };

    expect(body.pack.id).toBe("fannie-farmer-1896");
    expect(body.pack.creator.name).toBe("Fannie Merritt Farmer");
    expect(body.recipe.id).toBe("boiled-custard");
    expect(body.recipe.title).toBe("Boiled Custard");
    expect(body.library.states.map((s) => s.id)).toContain(
      "state:custard-coats-the-spoon",
    );
    expect(body.library.commons.map((c) => c.id)).toContain(
      "commons:tempering-eggs",
    );
    expect(body.projection?.source).toBe(
      "pack:fannie-farmer-1896/boiled-custard",
    );
  });

  it("returns 404 when the pack or recipe is not on the shelf", async () => {
    const missingPack = await GET(
      makeRequest("/api/packs?pack=no-such-pack&recipe=boiled-custard"),
    );
    expect(missingPack.status).toBe(404);

    const missingRecipe = await GET(
      makeRequest("/api/packs?pack=fannie-farmer-1896&recipe=no-such-recipe"),
    );
    expect(missingRecipe.status).toBe(404);
  });

  it("returns 404 when only one of pack or recipe is provided", async () => {
    const onlyPack = await GET(
      makeRequest("/api/packs?pack=fannie-farmer-1896"),
    );
    expect(onlyPack.status).toBe(404);
  });
});
