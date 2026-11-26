import { NextResponse } from "next/server";
import { librarySubset } from "@/lib/pack-convert/native-read";
import { EMPTY_LIBRARY } from "@/lib/pack-convert/recipe-library";
import { packRecipeToQueueData } from "@/lib/pack-convert/to-queue";
import { loadAppPackFiles } from "@/lib/shelf/load";
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import { checkWebhookRateLimit } from "@/lib/kitchens/webhook-rate-limit";
import { buildPackDigest } from "@/lib/kitchens/pack-digest";

/**
 * GET /api/packs
 *
 * Serves the live registered creator packs (`SHELF_SOURCES` `pack-file` entries)
 * plus the kitchen's owned and shared DB packs to `kitchen.py`:
 * - `GET /api/packs`: compact digest per pack and per recipe.
 * - `GET /api/packs?pack=<packId>&recipe=<recipeId>`: full validated Recipe +
 *   pack header + resolved commons/states subset + queue projection.
 *
 * Auth: Per-kitchen Bearer token (required in every environment).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateWebhookRequest(request);
  if (!auth.ok) return auth.response;

  const rateLimit = checkWebhookRateLimit(auth.kitchen.id);
  if (!rateLimit.ok) return rateLimit.response;

  const files = await loadAppPackFiles({ kitchenId: auth.kitchen.id });
  if (files.loadError !== undefined) {
    return NextResponse.json({ error: files.loadError }, { status: 500 });
  }

  const url = new URL(request.url);
  const packParam = url.searchParams.get("pack");
  const recipeParam = url.searchParams.get("recipe");

  if (packParam !== null || recipeParam !== null) {
    if (!packParam || !recipeParam) {
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }
    const pack = files.packs.find((p) => p.id === packParam);
    const recipe = pack?.recipes.find((r) => r.id === recipeParam);
    if (!pack || !recipe) {
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }
    const meta = files.packMeta?.get(pack.id);
    const projected = packRecipeToQueueData(recipe, pack.id);
    const library = files.libraries
      ? librarySubset(recipe, files.libraries)
      : EMPTY_LIBRARY;
    return NextResponse.json({
      pack: {
        id: pack.id,
        title: pack.title,
        creator: pack.creator,
        ...(meta?.fromKitchenName ? { from_kitchen_name: meta.fromKitchenName } : {}),
      },
      recipe,
      library,
      projection: projected.ok ? projected.projection.recipeData : null,
    });
  }

  return NextResponse.json({ packs: buildPackDigest(files) });
}
