import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db, kitchenWebhookTokens } from "@/lib/db";
import { seedKitchen } from "@/lib/__tests__/kitchens";
import {
  KitchenAdminError,
  createWebhookToken,
  listWebhookTokens,
  revokeWebhookToken,
} from "./admin";
import { authenticateWebhookRequest } from "./webhook-tokens";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeEach(async () => {
  await client.exec("delete from kitchen_webhook_tokens");
  await client.exec("delete from kitchens where slug <> 'home'");
});

describe("Webhook token admin commands", () => {
  it("creates a token stored only as SHA-256, authenticates requests, lists without secret, and revokes it", async () => {
    await seedKitchen(db, { slug: "north", name: "North Kitchen" });

    const created = await createWebhookToken(
      { kitchenSlug: "north", label: "chat agent" },
      db,
    );
    expect(created.token).toMatch(/^sous_[A-Za-z0-9_-]+$/);
    expect(created.kitchenSlug).toBe("north");
    expect(created.label).toBe("chat agent");

    const [stored] = await db
      .select()
      .from(kitchenWebhookTokens)
      .where(eq(kitchenWebhookTokens.id, created.id));
    expect(stored?.tokenSha256).toBe(
      createHash("sha256").update(created.token).digest("hex"),
    );
    expect(stored?.tokenSha256).not.toBe(created.token);

    // Works for webhook authentication and stamps last_used_at.
    const okAuth = await authenticateWebhookRequest(
      new Request("http://localhost/api/packs", {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(okAuth.ok).toBe(true);
    if (okAuth.ok) {
      expect(okAuth.kitchen.slug).toBe("north");
    }

    // Listing exposes metadata and never the token or hash.
    const listedAll = await listWebhookTokens({}, db);
    expect(listedAll).toHaveLength(1);
    expect(listedAll[0]).toMatchObject({
      id: created.id,
      kitchenSlug: "north",
      label: "chat agent",
      revokedAt: null,
    });
    expect(listedAll[0]?.lastUsedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listedAll)).not.toContain(created.token);
    expect(JSON.stringify(listedAll)).not.toContain(stored!.tokenSha256);

    // Filtering by kitchen slug returns only that kitchen's tokens.
    expect(await listWebhookTokens({ kitchenSlug: "home" }, db)).toEqual([]);
    expect(await listWebhookTokens({ kitchenSlug: "north" }, db)).toHaveLength(
      1,
    );

    // Revoking marks revoked_at and stops webhook auth immediately.
    const revoked = await revokeWebhookToken({ id: created.id }, db);
    expect(revoked.id).toBe(created.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    const rejected = await authenticateWebhookRequest(
      new Request("http://localhost/api/packs", {
        headers: { Authorization: `Bearer ${created.token}` },
      }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.response.status).toBe(401);
    }

    // Revoking again refuses cleanly.
    await expect(revokeWebhookToken({ id: created.id }, db)).rejects.toThrow(
      KitchenAdminError,
    );
  });

  it("refuses unknown kitchens, empty labels, malformed ids, and missing token ids", async () => {
    await expect(
      createWebhookToken({ kitchenSlug: "missing", label: "agent" }, db),
    ).rejects.toThrow(KitchenAdminError);

    await expect(
      createWebhookToken({ kitchenSlug: "home", label: "   " }, db),
    ).rejects.toThrow(KitchenAdminError);

    await expect(
      listWebhookTokens({ kitchenSlug: "missing" }, db),
    ).rejects.toThrow(KitchenAdminError);

    await expect(
      revokeWebhookToken({ id: "not-a-uuid" }, db),
    ).rejects.toThrow(KitchenAdminError);

    await expect(
      revokeWebhookToken(
        { id: "00000000-0000-4000-8000-000000000000" },
        db,
      ),
    ).rejects.toThrow(KitchenAdminError);
  });
});
