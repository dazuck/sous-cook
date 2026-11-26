import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

const mockAiChat = vi.fn();
vi.mock("../ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai")>()),
  chat: (...args: unknown[]) => mockAiChat(...args),
  getConfig: () => ({
    textProvider: "google",
    textModel: "gemini-3.5-flash",
    cookChatModel: "gemini-3.5-flash",
    visionProvider: "google",
    visionModel: "gemini-2.5-flash",
  }),
}));

vi.mock("../kitchen-queue", () => ({ getQueueItemForKitchen: vi.fn() }));
vi.mock("../shelf/load", () => ({ loadAppPackFiles: vi.fn() }));

import * as dbModule from "@/lib/db";
import { conversationLogs, db, kitchens } from "@/lib/db";
import { seedKitchen } from "../__tests__/kitchens";
import { chatCookingAssistant } from "../claude";
import { dbHouseholdContext } from "./db-household-context";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenAId: string;
let kitchenBId: string;

beforeEach(async () => {
  mockAiChat.mockReset();
  mockAiChat.mockResolvedValue({
    content: "Use olive oil.",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  await client.exec(
    "delete from conversation_logs; delete from kitchen_cook_log; delete from doc_recipes; delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenAId = (await seedKitchen(db, { slug: "ctx-a", name: "Ctx A" })).kitchen.id;
  kitchenBId = (await seedKitchen(db, { slug: "ctx-b", name: "Ctx B" })).kitchen.id;
});

describe("dbHouseholdContext + Ask Sous", () => {
  it("omits reference_info when kitchens.about is empty and includes it per kitchen when non-empty", async () => {
    expect(await dbHouseholdContext(kitchenAId).read()).toBe("");

    await chatCookingAssistant(
      kitchenAId,
      "session-empty",
      [{ role: "user", content: "What should I cook?" }],
      "Pasta",
    );
    expect(mockAiChat.mock.calls[0]![0].systemPrompt).not.toContain(
      "<reference_info>",
    );

    await db
      .update(kitchens)
      .set({ about: "We avoid peanuts. Two vegetarians." })
      .where(eq(kitchens.id, kitchenAId));

    await chatCookingAssistant(
      kitchenAId,
      "session-filled",
      [{ role: "user", content: "Can I add a garnish?" }],
      "Stir Fry",
    );

    const promptA = mockAiChat.mock.calls[1]![0].systemPrompt as string;
    expect(promptA).toContain("<reference_info>");
    expect(promptA).toContain(
      "Family context:\nWe avoid peanuts. Two vegetarians.",
    );

    const [logA] = await db
      .select()
      .from(conversationLogs)
      .where(
        and(
          eq(conversationLogs.kitchenId, kitchenAId),
          eq(conversationLogs.role, "user"),
          eq(conversationLogs.sessionId, "session-filled"),
        ),
      )
      .orderBy(desc(conversationLogs.createdAt));
    expect(JSON.stringify(logA?.context)).toContain(
      "We avoid peanuts. Two vegetarians.",
    );

    // Kitchen B does not receive Kitchen A's about text.
    await chatCookingAssistant(
      kitchenBId,
      "session-b",
      [{ role: "user", content: "Can I add peanuts?" }],
      "Stir Fry",
    );
    expect(mockAiChat.mock.calls[2]![0].systemPrompt).not.toContain(
      "We avoid peanuts",
    );
  });
});
