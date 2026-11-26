import { NextResponse } from "next/server";
import { z } from "zod";
import { sweepAndLogIdleCooks } from "@/lib/kitchen-auto-finish";
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import { checkWebhookRateLimit } from "@/lib/kitchens/webhook-rate-limit";

/** Empty object only; the token identifies the kitchen. */
const SweepSchema = z.object({}).strict();

/**
 * Each sweep writes the Cook Log rows of the cooks it finishes before it
 * answers: a Cook Log call bounds its own time, and a night holds few cooks.
 */
export const maxDuration = 60;

/**
 * POST /api/kitchen-queue/sweep
 *
 * Finishes the cooks left idle on their last screen past the wait for the
 * token's kitchen, writing each one's Cook Log row before the next, and writes
 * the row of any cook the app finished lately (`RELOG_LOOKBACK_MS`) whose write
 * failed or was lost. Meant for a nightly job to call before it asks for
 * ratings, so a cook whose tablet slept on its last screen is asked about that
 * night. Safe to call again: a cook finished is no longer cooking, and one
 * logged has its row.
 *
 * Body: `{}`.
 * Answers `{ finished: [...], relogged: [...] }`, each `{ queueId, name,
 * cookLog }`, `cookLog` being where the row stands ("logged", or "failed"
 * for the app's retry).
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
  const parsed = SweepSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sweep", details: parsed.error.issues }, { status: 400 });
  }

  return NextResponse.json(await sweepAndLogIdleCooks(auth.kitchen.id));
}
