import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import { db } from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import { stubSignInEnv } from "@/lib/__tests__/test-auth";
import { MAX_CIRCLE_MEMBERS } from "../../../drizzle/schema";
import { parseCommand } from "../../../scripts/kitchens";
import {
  KitchenCircleError,
  addKitchenToCircle,
  createCircle,
  listCircles,
  removeKitchenFromCircle,
} from "./circles";

const client = (dbModule as unknown as { client: PGlite }).client;

async function expectCircleError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(KitchenCircleError);
  expect((caught as Error).message).toMatch(pattern);
}

let kitchensSeeded: KitchenRow[] = [];

beforeEach(async () => {
  stubSignInEnv();
  await client.exec(
    "delete from circle_members; delete from circles; delete from kitchen_pack_shares; delete from kitchen_packs; delete from ai_usage; delete from kitchen_webhook_tokens; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchensSeeded = [];
  for (let i = 1; i <= 14; i++) {
    const seeded = await seedKitchen(db, {
      slug: `kitchen-${i}`,
      name: `Kitchen ${i}`,
    });
    kitchensSeeded.push(seeded.kitchen);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("kitchen circles operator commands", () => {
  it("parses all circle CLI subcommands cleanly", () => {
    expect(parseCommand(["circle", "create", "--name", "Sunday Cooks"])).toEqual({
      kind: "circle-create",
      input: { name: "Sunday Cooks" },
    });
    expect(
      parseCommand([
        "circle",
        "add",
        "--circle",
        "00000000-0000-4000-8000-000000000001",
        "--kitchen",
        "kitchen-1",
      ]),
    ).toEqual({
      kind: "circle-add",
      input: {
        circleId: "00000000-0000-4000-8000-000000000001",
        kitchenSlug: "kitchen-1",
      },
    });
    expect(
      parseCommand(["circle", "remove", "--kitchen", "kitchen-1"]),
    ).toEqual({
      kind: "circle-remove",
      input: { kitchenSlug: "kitchen-1", circleId: undefined },
    });
    expect(parseCommand(["circle", "list"])).toEqual({ kind: "circle-list" });
  });

  it("refuses all circle commands in single-kitchen mode", async () => {
    const singleEnv = { SOUS_SIGN_IN: "off" };
    await expectCircleError(
      createCircle({ name: "Test" }, db, singleEnv),
      /single-kitchen mode/,
    );
    await expectCircleError(
      addKitchenToCircle(
        {
          circleId: "00000000-0000-4000-8000-000000000001",
          kitchenSlug: "kitchen-1",
        },
        db,
        singleEnv,
      ),
      /single-kitchen mode/,
    );
    await expectCircleError(
      removeKitchenFromCircle({ kitchenSlug: "kitchen-1" }, db, singleEnv),
      /single-kitchen mode/,
    );
    await expectCircleError(listCircles(db, singleEnv), /single-kitchen mode/);
  });

  it("creates, adds, lists, enforces max 12 members and at most 1 circle per kitchen, and removes", async () => {
    const c1 = await createCircle({ name: "Supper Club" }, db);
    const c2 = await createCircle({ name: "Pastry Friends" }, db);

    expect(c1.name).toBe("Supper Club");
    expect(await listCircles(db)).toHaveLength(2);

    // Add 12 kitchens to c1
    for (let i = 1; i <= MAX_CIRCLE_MEMBERS; i++) {
      const added = await addKitchenToCircle(
        { circleId: c1.id, kitchenSlug: `kitchen-${i}` },
        db,
      );
      expect(added.kitchenSlug).toBe(`kitchen-${i}`);
    }

    // 13th kitchen is refused
    await expectCircleError(
      addKitchenToCircle({ circleId: c1.id, kitchenSlug: "kitchen-13" }, db),
      /already has 12 kitchens/,
    );

    // Kitchen already in c1 cannot join c2
    await expectCircleError(
      addKitchenToCircle({ circleId: c2.id, kitchenSlug: "kitchen-1" }, db),
      /already in circle "Supper Club"/,
    );

    const listed = await listCircles(db);
    expect(listed.find((c) => c.id === c1.id)!.members).toHaveLength(12);
    expect(listed.find((c) => c.id === c2.id)!.members).toHaveLength(0);

    // Wrong circle on remove refuses
    await expectCircleError(
      removeKitchenFromCircle(
        { kitchenSlug: "kitchen-1", circleId: c2.id },
        db,
      ),
      /is in circle "Supper Club"/,
    );

    // Remove kitchen-1 from c1 -> now kitchen-13 can join c1 and kitchen-1 can join c2
    const removed = await removeKitchenFromCircle(
      { kitchenSlug: "kitchen-1" },
      db,
    );
    expect(removed.circleId).toBe(c1.id);

    await addKitchenToCircle({ circleId: c1.id, kitchenSlug: "kitchen-13" }, db);
    await addKitchenToCircle({ circleId: c2.id, kitchenSlug: "kitchen-1" }, db);

    // Removing a kitchen not in any circle refuses
    await expectCircleError(
      removeKitchenFromCircle({ kitchenSlug: "kitchen-14" }, db),
      /not in any circle/,
    );

    const listedAfter = await listCircles(db);
    expect(listedAfter.find((c) => c.id === c1.id)!.members).toHaveLength(12);
    expect(
      listedAfter.find((c) => c.id === c2.id)!.members.map((m) => m.slug),
    ).toEqual(["kitchen-1"]);
  });
});
