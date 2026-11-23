import { NextResponse } from "next/server";
import { z } from "zod";
import { sweepAndLogIdleCooks } from "@/lib/kitchen-auto-finish";
import { DEFAULT_COOK, isValidUserId } from "@/lib/cook-id";
import { webhookAuthRefusal } from "@/lib/webhook-auth";

/** The cook whose cooks the sweep finishes: a slug, `DEFAULT_COOK` when left out. */
const SweepSchema = z
  .object({ targetUser: z.string().refine(isValidUserId, { message: "targetUser must be a slug" }).optional() })
  .strict();

/**
 * Each sweep writes the Cook Log rows of the cooks it finishes before it
 * answers: a Cook Log call bounds its own time, and a night holds few cooks.
 */
export const maxDuration = 60;

/**
 * POST /api/kitchen-queue/sweep
 *
 * Finishes the cooks left idle on their last screen past the wait
 * (cook-fidelity decision 7), for `targetUser`, writing each
 * one's Cook Log row before the next, and writes the row of any cook the app
 * finished lately (`RELOG_LOOKBACK_MS`) whose write failed or was lost. Meant for a
 * nightly job to call before it asks for ratings, so a cook
 * whose tablet slept on its last screen is asked about that night. Safe to
 * call again: a cook finished is no longer cooking, and one logged has its row.
 *
 * Body: `{ targetUser?: string }` (a cook's slug; `{}` for the default cook).
 * Answers `{ finished: [...], relogged: [...] }`, each `{ queueId, name,
 * cookLog }`, `cookLog` being where the row stands ("logged", or "failed"
 * for the app's retry).
 *
 * Auth: the kitchen-queue webhook's Bearer token (`webhookAuthRefusal`).
 */
export async function POST(request: Request): Promise<Response> {
  const refusal = webhookAuthRefusal(request);
  if (refusal) return refusal;

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

  return NextResponse.json(await sweepAndLogIdleCooks([parsed.data.targetUser ?? DEFAULT_COOK]));
}
