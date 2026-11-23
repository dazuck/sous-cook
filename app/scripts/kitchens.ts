/**
 * Operator CLI for managing kitchens and per-kitchen webhook tokens.
 *
 * Usage:
 *   pnpm --dir app kitchens token create --kitchen <slug> --label <text>
 *   pnpm --dir app kitchens token revoke --id <id>
 *   pnpm --dir app kitchens token list [--kitchen <slug>]
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";
import {
  KitchenAdminError,
  createWebhookToken,
  listWebhookTokens,
  revokeWebhookToken,
} from "../src/lib/kitchens/admin";

const USAGE = [
  "Usage:",
  "  pnpm --dir app kitchens token create --kitchen <slug> --label <text>",
  "  pnpm --dir app kitchens token revoke --id <id>",
  "  pnpm --dir app kitchens token list [--kitchen <slug>]",
].join("\n");

function parseFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      throw new KitchenAdminError(`Unexpected argument "${arg}".\n${USAGE}`);
    }
    const name = arg.slice(2);
    if (!allowed.has(name)) {
      throw new KitchenAdminError(`Unknown option "--${name}".\n${USAGE}`);
    }
    if (flags.has(name)) {
      throw new KitchenAdminError(`Option "--${name}" was passed more than once.`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new KitchenAdminError(`Option "--${name}" requires a value.`);
    }
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === "") {
    throw new KitchenAdminError(`Missing required option "--${name}".\n${USAGE}`);
  }
  return value;
}

function formatDate(value: Date | null): string {
  return value === null ? "-" : value.toISOString();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const [group, subcommand, ...rest] = args;
  if (group !== "token" || !subcommand) {
    throw new KitchenAdminError(`Unknown command "${args.join(" ")}".\n${USAGE}`);
  }

  if (
    subcommand !== "create" &&
    subcommand !== "revoke" &&
    subcommand !== "list"
  ) {
    throw new KitchenAdminError(
      `Unknown token subcommand "${subcommand}".\n${USAGE}`,
    );
  }

  const flags =
    subcommand === "create"
      ? parseFlags(rest, new Set(["kitchen", "label"]))
      : subcommand === "revoke"
        ? parseFlags(rest, new Set(["id"]))
        : parseFlags(rest, new Set(["kitchen"]));

  // Validate required flags before opening a database connection.
  const createInput =
    subcommand === "create"
      ? {
          kitchenSlug: requireFlag(flags, "kitchen"),
          label: requireFlag(flags, "label"),
        }
      : null;
  const revokeInput =
    subcommand === "revoke" ? { id: requireFlag(flags, "id") } : null;
  const listInput =
    subcommand === "list"
      ? { kitchenSlug: flags.get("kitchen") }
      : null;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new KitchenAdminError("DATABASE_URL environment variable is required.");
  }

  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const db = drizzle(client, { schema });

    if (createInput) {
      const created = await createWebhookToken(createInput, db);
      console.log(
        `Created webhook token ${created.id} for kitchen "${created.kitchenSlug}" (label: "${created.label}").`,
      );
      console.log("Save this token now; it will not be shown again:");
      console.log(created.token);
      return;
    }

    if (revokeInput) {
      const revoked = await revokeWebhookToken(revokeInput, db);
      console.log(
        `Revoked webhook token ${revoked.id} for kitchen "${revoked.kitchenSlug}" (label: "${revoked.label}") at ${revoked.revokedAt.toISOString()}.`,
      );
      return;
    }

    if (listInput) {
      const tokens = await listWebhookTokens(listInput, db);
      if (tokens.length === 0) {
        console.log("No webhook tokens found.");
        return;
      }
      console.log(
        ["id", "kitchen", "label", "created", "last_used", "revoked"].join("\t"),
      );
      for (const row of tokens) {
        console.log(
          [
            row.id,
            row.kitchenSlug,
            row.label,
            formatDate(row.createdAt),
            formatDate(row.lastUsedAt),
            formatDate(row.revokedAt),
          ].join("\t"),
        );
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
