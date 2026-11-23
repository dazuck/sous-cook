import { TRPCError } from "@trpc/server";
import { getQueueItem, type KitchenQueueItem } from "@/lib/kitchen-queue";

/**
 * Reads a queue item owned by the given kitchen, or throws NOT_FOUND.
 * Missing ids and ids belonging to another kitchen receive the same error so
 * callers cannot confirm whether an id exists in another kitchen.
 */
export async function requireOwnedQueueItem(
  kitchenId: string,
  queueId: string,
): Promise<KitchenQueueItem> {
  const item = await getQueueItem(kitchenId, queueId);
  if (!item) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Queue item not found" });
  }
  return item;
}
