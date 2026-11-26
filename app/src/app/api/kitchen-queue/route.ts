import { NextResponse } from "next/server";
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import { checkWebhookRateLimit } from "@/lib/kitchens/webhook-rate-limit";
import {
  queueRecipeForKitchen,
  type KitchenQueueWebhookInput,
} from "@/lib/kitchens/webhook-queue";

export type { KitchenQueueWebhookInput };

/**
 * After the response, the add runs intake (up to 90 s) and then the cook plan,
 * inside this function's time.
 */
export const maxDuration = 300;

/**
 * POST /api/kitchen-queue
 *
 * Webhook endpoint for pushing recipes into a kitchen's queue.
 * Used by external apps (an assistant, a script) to send recipes to the tablet.
 *
 * Auth: Per-kitchen Bearer token (required in every environment).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateWebhookRequest(request);
  if (!auth.ok) return auth.response;

  const rateLimit = checkWebhookRateLimit(auth.kitchen.id);
  if (!rateLimit.ok) return rateLimit.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = await queueRecipeForKitchen(auth.kitchen.id, body);
  return NextResponse.json(result.body, { status: result.status });
}
