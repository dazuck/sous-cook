/**
 * Operator CLI for managing kitchens, invites, members, and webhook tokens.
 *
 * Usage:
 *   pnpm --dir app kitchens invite --email <email> --new-kitchen <name> [--slug <slug>]
 *   pnpm --dir app kitchens invite --email <email> --kitchen <slug> --role owner|cook
 *   pnpm --dir app kitchens uninvite --email <email>
 *   pnpm --dir app kitchens remove-member --email <email> (--revoke-tokens | --keep-tokens)
 *   pnpm --dir app kitchens list
 *   pnpm --dir app kitchens rename --kitchen <slug> --name <name>
 *   pnpm --dir app kitchens token create --kitchen <slug> --label <text>
 *   pnpm --dir app kitchens token revoke --id <id>
 *   pnpm --dir app kitchens token list [--kitchen <slug>]
 *   pnpm --dir app kitchens spend [--month YYYY-MM]
 *   pnpm --dir app kitchens cap set --kitchen <slug> --usd <amount>
 *   pnpm --dir app kitchens cap clear --kitchen <slug>
 *   pnpm --dir app kitchens export --kitchen <slug> --out <file>
 *   pnpm --dir app kitchens import --kitchen <slug> --file <file> [--dry-run]
 *   pnpm --dir app kitchens pack add --kitchen <slug> --file <pack.json>
 *   pnpm --dir app kitchens pack list [--kitchen <slug>]
 *   pnpm --dir app kitchens pack remove --pack <id> [--kitchen <slug>]
 *   pnpm --dir app kitchens pack share --pack <id> --with <slug> [--kitchen <slug>]
 *   pnpm --dir app kitchens pack unshare --pack <id> --with <slug> [--kitchen <slug>]
 *   pnpm --dir app kitchens circle create --name <name>
 *   pnpm --dir app kitchens circle add --circle <id> --kitchen <slug>
 *   pnpm --dir app kitchens circle remove --kitchen <slug> [--circle <id>]
 *   pnpm --dir app kitchens circle list
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";
import { formatMicrosAsUsd } from "../src/lib/ai/prices";
import {
  KitchenAdminError,
  assertSignInModeForAdmin,
  clearKitchenCap,
  createInvite,
  createWebhookToken,
  formatClearKitchenCapSummary,
  formatKitchenCap,
  formatRemoveMemberSummary,
  formatSpendReport,
  getKitchenSpend,
  listKitchens,
  listWebhookTokens,
  removeMember,
  renameKitchen,
  revokeWebhookToken,
  setKitchenCap,
  uninviteEmail,
  type CreateInviteInput,
} from "../src/lib/kitchens/admin";
import {
  addKitchenToCircle,
  assertSignInModeForCircles,
  createCircle,
  listCircles,
  removeKitchenFromCircle,
} from "../src/lib/kitchens/circles";
import {
  exportKitchenData,
  formatExportSummary,
  formatImportSummary,
  importKitchenData,
} from "../src/lib/kitchens/export-import";
import {
  addKitchenPack,
  assertSignInModeForPackSharing,
  listKitchenPacks,
  removeKitchenPack,
  shareKitchenPack,
  unshareKitchenPack,
} from "../src/lib/kitchens/packs";

const USAGE = [
  "Usage:",
  "  pnpm --dir app kitchens invite --email <email> --new-kitchen <name> [--slug <slug>]",
  "  pnpm --dir app kitchens invite --email <email> --kitchen <slug> --role owner|cook",
  "  pnpm --dir app kitchens uninvite --email <email>",
  "  pnpm --dir app kitchens remove-member --email <email> (--revoke-tokens | --keep-tokens)",
  "  pnpm --dir app kitchens list",
  "  pnpm --dir app kitchens rename --kitchen <slug> --name <name>",
  "  pnpm --dir app kitchens token create --kitchen <slug> --label <text>",
  "  pnpm --dir app kitchens token revoke --id <id>",
  "  pnpm --dir app kitchens token list [--kitchen <slug>]",
  "  pnpm --dir app kitchens spend [--month YYYY-MM]",
  "  pnpm --dir app kitchens cap set --kitchen <slug> --usd <amount>",
  "  pnpm --dir app kitchens cap clear --kitchen <slug>",
  "  pnpm --dir app kitchens export --kitchen <slug> --out <file>",
  "  pnpm --dir app kitchens import --kitchen <slug> --file <file> [--dry-run]",
  "  pnpm --dir app kitchens pack add --kitchen <slug> --file <pack.json>",
  "  pnpm --dir app kitchens pack list [--kitchen <slug>]",
  "  pnpm --dir app kitchens pack remove --pack <id> [--kitchen <slug>]",
  "  pnpm --dir app kitchens pack share --pack <id> --with <slug> [--kitchen <slug>]",
  "  pnpm --dir app kitchens pack unshare --pack <id> --with <slug> [--kitchen <slug>]",
  "  pnpm --dir app kitchens circle create --name <name>",
  "  pnpm --dir app kitchens circle add --circle <id> --kitchen <slug>",
  "  pnpm --dir app kitchens circle remove --kitchen <slug> [--circle <id>]",
  "  pnpm --dir app kitchens circle list",
].join("\n");

interface ParsedFlags {
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseFlags(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string> = new Set(),
): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      throw new KitchenAdminError(`Unexpected argument "${arg}".\n${USAGE}`);
    }
    const name = arg.slice(2);
    if (booleanFlags.has(name)) {
      if (booleans.has(name)) {
        throw new KitchenAdminError(
          `Option "--${name}" was passed more than once.`,
        );
      }
      booleans.add(name);
      continue;
    }
    if (!valueFlags.has(name)) {
      throw new KitchenAdminError(`Unknown option "--${name}".\n${USAGE}`);
    }
    if (values.has(name)) {
      throw new KitchenAdminError(
        `Option "--${name}" was passed more than once.`,
      );
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new KitchenAdminError(`Option "--${name}" requires a value.`);
    }
    values.set(name, value);
    i += 1;
  }
  return { values, booleans };
}

function requireFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name);
  if (value === undefined || value.trim() === "") {
    throw new KitchenAdminError(
      `Missing required option "--${name}".\n${USAGE}`,
    );
  }
  return value;
}

function formatDate(value: Date | null): string {
  return value === null ? "-" : value.toISOString();
}

type ParsedCommand =
  | { kind: "invite"; input: CreateInviteInput }
  | { kind: "uninvite"; input: { email: string } }
  | {
      kind: "remove-member";
      input: { email: string; tokenAction?: "revoke" | "keep" };
    }
  | { kind: "list" }
  | { kind: "rename"; input: { kitchenSlug: string; name: string } }
  | { kind: "token-create"; input: { kitchenSlug: string; label: string } }
  | { kind: "token-revoke"; input: { id: string } }
  | { kind: "token-list"; input: { kitchenSlug?: string } }
  | { kind: "spend"; input: { month?: string } }
  | { kind: "cap-set"; input: { kitchenSlug: string; usd: string } }
  | { kind: "cap-clear"; input: { kitchenSlug: string } }
  | { kind: "export"; input: { kitchenSlug: string; out: string } }
  | {
      kind: "import";
      input: { kitchenSlug: string; file: string; dryRun: boolean };
    }
  | { kind: "pack-add"; input: { kitchenSlug: string; filePath: string } }
  | { kind: "pack-list"; input: { kitchenSlug?: string } }
  | { kind: "pack-remove"; input: { pack: string; kitchenSlug?: string } }
  | {
      kind: "pack-share";
      input: { pack: string; withKitchenSlug: string; kitchenSlug?: string };
    }
  | {
      kind: "pack-unshare";
      input: { pack: string; withKitchenSlug: string; kitchenSlug?: string };
    }
  | { kind: "circle-create"; input: { name: string } }
  | { kind: "circle-add"; input: { circleId: string; kitchenSlug: string } }
  | {
      kind: "circle-remove";
      input: { kitchenSlug: string; circleId?: string };
    }
  | { kind: "circle-list" };

export function parseCommand(args: readonly string[]): ParsedCommand {
  const [command, ...rest] = args;

  if (command === "invite") {
    const flags = parseFlags(
      rest,
      new Set(["email", "new-kitchen", "slug", "kitchen", "role"]),
    );
    const email = requireFlag(flags, "email");
    const newKitchen = flags.values.get("new-kitchen");
    const existingKitchen = flags.values.get("kitchen");

    if (newKitchen !== undefined && existingKitchen !== undefined) {
      throw new KitchenAdminError(
        `Pass either "--new-kitchen" or "--kitchen", not both.\n${USAGE}`,
      );
    }
    if (newKitchen === undefined && existingKitchen === undefined) {
      throw new KitchenAdminError(
        `Specify either "--new-kitchen <name>" or "--kitchen <slug> --role owner|cook".\n${USAGE}`,
      );
    }

    if (newKitchen !== undefined) {
      const role = flags.values.get("role");
      if (role !== undefined && role !== "owner") {
        throw new KitchenAdminError(
          `A new-kitchen invite always creates an "owner" (got "--role ${role}").`,
        );
      }
      return {
        kind: "invite",
        input: {
          email,
          newKitchenName: newKitchen,
          slug: flags.values.get("slug"),
        },
      };
    }

    if (flags.values.has("slug")) {
      throw new KitchenAdminError(
        `Option "--slug" can only be used with "--new-kitchen".\n${USAGE}`,
      );
    }
    const role = requireFlag(flags, "role");
    if (role !== "owner" && role !== "cook") {
      throw new KitchenAdminError(
        `Invalid role "${role}". Expected "owner" or "cook".`,
      );
    }
    return {
      kind: "invite",
      input: {
        email,
        kitchenSlug: existingKitchen!,
        role,
      },
    };
  }

  if (command === "uninvite") {
    const flags = parseFlags(rest, new Set(["email"]));
    return { kind: "uninvite", input: { email: requireFlag(flags, "email") } };
  }

  if (command === "remove-member") {
    const flags = parseFlags(
      rest,
      new Set(["email"]),
      new Set(["revoke-tokens", "keep-tokens"]),
    );
    const email = requireFlag(flags, "email");
    const revoke = flags.booleans.has("revoke-tokens");
    const keep = flags.booleans.has("keep-tokens");
    if (revoke && keep) {
      throw new KitchenAdminError(
        `Pass either "--revoke-tokens" or "--keep-tokens", not both.\n${USAGE}`,
      );
    }
    return {
      kind: "remove-member",
      input: {
        email,
        tokenAction: revoke ? "revoke" : keep ? "keep" : undefined,
      },
    };
  }

  if (command === "list") {
    parseFlags(rest, new Set());
    return { kind: "list" };
  }

  if (command === "rename") {
    const flags = parseFlags(rest, new Set(["kitchen", "name"]));
    return {
      kind: "rename",
      input: {
        kitchenSlug: requireFlag(flags, "kitchen"),
        name: requireFlag(flags, "name"),
      },
    };
  }

  if (command === "token") {
    const [subcommand, ...tokenRest] = rest;
    if (subcommand === "create") {
      const flags = parseFlags(tokenRest, new Set(["kitchen", "label"]));
      return {
        kind: "token-create",
        input: {
          kitchenSlug: requireFlag(flags, "kitchen"),
          label: requireFlag(flags, "label"),
        },
      };
    }
    if (subcommand === "revoke") {
      const flags = parseFlags(tokenRest, new Set(["id"]));
      return {
        kind: "token-revoke",
        input: { id: requireFlag(flags, "id") },
      };
    }
    if (subcommand === "list") {
      const flags = parseFlags(tokenRest, new Set(["kitchen"]));
      return {
        kind: "token-list",
        input: { kitchenSlug: flags.values.get("kitchen") },
      };
    }
    throw new KitchenAdminError(
      `Unknown token subcommand "${subcommand ?? ""}".\n${USAGE}`,
    );
  }

  if (command === "spend") {
    const flags = parseFlags(rest, new Set(["month"]));
    return {
      kind: "spend",
      input: { month: flags.values.get("month") },
    };
  }

  if (command === "cap") {
    const [subcommand, ...capRest] = rest;
    if (subcommand === "set") {
      const flags = parseFlags(capRest, new Set(["kitchen", "usd"]));
      return {
        kind: "cap-set",
        input: {
          kitchenSlug: requireFlag(flags, "kitchen"),
          usd: requireFlag(flags, "usd"),
        },
      };
    }
    if (subcommand === "clear") {
      const flags = parseFlags(capRest, new Set(["kitchen"]));
      return {
        kind: "cap-clear",
        input: {
          kitchenSlug: requireFlag(flags, "kitchen"),
        },
      };
    }
    throw new KitchenAdminError(
      `Unknown cap subcommand "${subcommand ?? ""}".\n${USAGE}`,
    );
  }

  if (command === "export") {
    const flags = parseFlags(rest, new Set(["kitchen", "out"]));
    return {
      kind: "export",
      input: {
        kitchenSlug: requireFlag(flags, "kitchen"),
        out: requireFlag(flags, "out"),
      },
    };
  }

  if (command === "import") {
    const flags = parseFlags(
      rest,
      new Set(["kitchen", "file"]),
      new Set(["dry-run"]),
    );
    return {
      kind: "import",
      input: {
        kitchenSlug: requireFlag(flags, "kitchen"),
        file: requireFlag(flags, "file"),
        dryRun: flags.booleans.has("dry-run"),
      },
    };
  }

  if (command === "pack") {
    const [subcommand, ...packRest] = rest;
    if (subcommand === "add") {
      const flags = parseFlags(packRest, new Set(["kitchen", "file"]));
      return {
        kind: "pack-add",
        input: {
          kitchenSlug: requireFlag(flags, "kitchen"),
          filePath: requireFlag(flags, "file"),
        },
      };
    }
    if (subcommand === "list") {
      const flags = parseFlags(packRest, new Set(["kitchen"]));
      return {
        kind: "pack-list",
        input: { kitchenSlug: flags.values.get("kitchen") },
      };
    }
    if (subcommand === "remove") {
      const flags = parseFlags(packRest, new Set(["pack", "kitchen"]));
      return {
        kind: "pack-remove",
        input: {
          pack: requireFlag(flags, "pack"),
          kitchenSlug: flags.values.get("kitchen"),
        },
      };
    }
    if (subcommand === "share") {
      const flags = parseFlags(packRest, new Set(["pack", "with", "kitchen"]));
      return {
        kind: "pack-share",
        input: {
          pack: requireFlag(flags, "pack"),
          withKitchenSlug: requireFlag(flags, "with"),
          kitchenSlug: flags.values.get("kitchen"),
        },
      };
    }
    if (subcommand === "unshare") {
      const flags = parseFlags(packRest, new Set(["pack", "with", "kitchen"]));
      return {
        kind: "pack-unshare",
        input: {
          pack: requireFlag(flags, "pack"),
          withKitchenSlug: requireFlag(flags, "with"),
          kitchenSlug: flags.values.get("kitchen"),
        },
      };
    }
    throw new KitchenAdminError(
      `Unknown pack subcommand "${subcommand ?? ""}".\n${USAGE}`,
    );
  }

  if (command === "circle") {
    const [subcommand, ...circleRest] = rest;
    if (subcommand === "create") {
      const flags = parseFlags(circleRest, new Set(["name"]));
      return {
        kind: "circle-create",
        input: { name: requireFlag(flags, "name") },
      };
    }
    if (subcommand === "add") {
      const flags = parseFlags(circleRest, new Set(["circle", "kitchen"]));
      return {
        kind: "circle-add",
        input: {
          circleId: requireFlag(flags, "circle"),
          kitchenSlug: requireFlag(flags, "kitchen"),
        },
      };
    }
    if (subcommand === "remove") {
      const flags = parseFlags(circleRest, new Set(["kitchen", "circle"]));
      return {
        kind: "circle-remove",
        input: {
          kitchenSlug: requireFlag(flags, "kitchen"),
          circleId: flags.values.get("circle"),
        },
      };
    }
    if (subcommand === "list") {
      parseFlags(circleRest, new Set());
      return { kind: "circle-list" };
    }
    throw new KitchenAdminError(
      `Unknown circle subcommand "${subcommand ?? ""}".\n${USAGE}`,
    );
  }

  throw new KitchenAdminError(
    `Unknown command "${args.join(" ")}".\n${USAGE}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const parsed = parseCommand(args);

  if (
    parsed.kind === "invite" ||
    parsed.kind === "uninvite" ||
    parsed.kind === "remove-member"
  ) {
    assertSignInModeForAdmin(parsed.kind);
  }
  if (parsed.kind === "pack-share") {
    assertSignInModeForPackSharing("pack share");
  }
  if (parsed.kind === "pack-unshare") {
    assertSignInModeForPackSharing("pack unshare");
  }
  if (parsed.kind.startsWith("circle-")) {
    assertSignInModeForCircles(parsed.kind.replace("-", " "));
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new KitchenAdminError(
      "DATABASE_URL environment variable is required.",
    );
  }

  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const db = drizzle(client, { schema });

    switch (parsed.kind) {
      case "invite": {
        const created = await createInvite(parsed.input, db);
        if (created.isNewKitchen) {
          console.log(
            `Invited ${created.email} as owner of new kitchen "${created.kitchenName}" (slug: ${created.kitchenSlug}).`,
          );
        } else {
          console.log(
            `Invited ${created.email} as ${created.role} of kitchen "${created.kitchenSlug}" ("${created.kitchenName}").`,
          );
        }
        return;
      }

      case "uninvite": {
        const result = await uninviteEmail(parsed.input, db);
        const orphanNote = result.wasAcceptedOrphan
          ? " (orphaned accepted invite)"
          : "";
        const sessionNote =
          result.sessionsDeleted > 0
            ? ` and deleted ${result.sessionsDeleted} session(s)`
            : "";
        console.log(
          `Revoked invite ${result.inviteId}${orphanNote} for ${result.email}${sessionNote}.`,
        );
        return;
      }

      case "remove-member": {
        const result = await removeMember(parsed.input, db);
        console.log(formatRemoveMemberSummary(result));
        return;
      }

      case "list": {
        const listed = await listKitchens(db);
        if (listed.kitchens.length === 0) {
          console.log("No kitchens found.");
        } else {
          for (const k of listed.kitchens) {
            console.log(
              `${k.slug}\t${k.name}\tcap=${formatKitchenCap(k.aiMonthlyCapMicros)}`,
            );
            for (const m of k.members) {
              console.log(`  member\t${m.email}\t${m.role}`);
            }
            for (const inv of k.pendingInvites) {
              console.log(
                `  invite\t${inv.email}\t${inv.role}\t${inv.invitedAt.toISOString()}`,
              );
            }
          }
        }
        if (listed.pendingNewKitchenInvites.length > 0) {
          console.log("Pending new-kitchen invites:");
          for (const inv of listed.pendingNewKitchenInvites) {
            console.log(
              `  ${inv.newKitchenSlug}\t${inv.newKitchenName}\t${inv.email}\t${inv.role}\t${inv.invitedAt.toISOString()}`,
            );
          }
        }
        return;
      }

      case "rename": {
        const renamed = await renameKitchen(parsed.input, db);
        console.log(
          `Renamed kitchen "${renamed.slug}" from "${renamed.oldName}" to "${renamed.newName}" (slug unchanged).`,
        );
        return;
      }

      case "token-create": {
        const created = await createWebhookToken(parsed.input, db);
        console.log(
          `Created webhook token ${created.id} for kitchen "${created.kitchenSlug}" (label: "${created.label}").`,
        );
        console.log("Save this token now; it will not be shown again:");
        console.log(created.token);
        return;
      }

      case "token-revoke": {
        const revoked = await revokeWebhookToken(parsed.input, db);
        console.log(
          `Revoked webhook token ${revoked.id} for kitchen "${revoked.kitchenSlug}" (label: "${revoked.label}") at ${revoked.revokedAt.toISOString()}.`,
        );
        return;
      }

      case "token-list": {
        const tokens = await listWebhookTokens(parsed.input, db);
        if (tokens.length === 0) {
          console.log("No webhook tokens found.");
          return;
        }
        console.log(
          ["id", "kitchen", "label", "created", "last_used", "revoked"].join(
            "\t",
          ),
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
        return;
      }

      case "spend": {
        const report = await getKitchenSpend(parsed.input, db);
        console.log(formatSpendReport(report));
        return;
      }

      case "cap-set": {
        const updated = await setKitchenCap(parsed.input, db);
        console.log(
          `Set monthly AI cap for kitchen "${updated.slug}" to ${formatMicrosAsUsd(updated.newCapMicros)} (was ${formatKitchenCap(updated.previousCapMicros)}).`,
        );
        return;
      }

      case "cap-clear": {
        const cleared = await clearKitchenCap(parsed.input, db);
        console.log(formatClearKitchenCapSummary(cleared));
        return;
      }

      case "export": {
        const exported = await exportKitchenData(
          { kitchenSlug: parsed.input.kitchenSlug },
          db,
        );
        const outPath = path.resolve(parsed.input.out);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, exported.json, "utf8");
        console.log(formatExportSummary(exported, outPath));
        return;
      }

      case "import": {
        const filePath = path.resolve(parsed.input.file);
        let rawText: string;
        try {
          rawText = await readFile(filePath, "utf8");
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new KitchenAdminError(
            `Could not read import file "${filePath}": ${detail}`,
          );
        }
        const imported = await importKitchenData(
          {
            kitchenSlug: parsed.input.kitchenSlug,
            data: rawText,
            dryRun: parsed.input.dryRun,
          },
          db,
        );
        console.log(formatImportSummary(imported));
        return;
      }

      case "pack-add": {
        const added = await addKitchenPack(parsed.input, db);
        console.log(
          `Added pack "${added.packId}" ("${added.title}", ${added.sizeBytes} bytes, id: ${added.id}) to kitchen "${added.kitchenSlug}".`,
        );
        return;
      }

      case "pack-list": {
        const packs = await listKitchenPacks(parsed.input, db);
        if (packs.length === 0) {
          console.log("No owned packs found.");
          return;
        }
        console.log(
          ["id", "kitchen", "pack_id", "title", "bytes", "shares"].join("\t"),
        );
        for (const p of packs) {
          const shareText =
            p.shares.length === 0
              ? "-"
              : p.shares.map((s) => s.slug).join(",");
          console.log(
            [
              p.id,
              p.kitchenSlug,
              p.packId,
              p.title,
              String(p.sizeBytes),
              shareText,
            ].join("\t"),
          );
        }
        return;
      }

      case "pack-remove": {
        const removed = await removeKitchenPack(parsed.input, db);
        console.log(
          `Removed pack "${removed.packId}" ("${removed.title}", id: ${removed.id}) from kitchen "${removed.kitchenSlug}".`,
        );
        return;
      }

      case "pack-share": {
        const shared = await shareKitchenPack(parsed.input, db);
        if (shared.alreadyShared) {
          console.log(
            `Pack "${shared.packId}" from "${shared.ownerKitchenSlug}" is already shared with "${shared.sharedWithKitchenSlug}".`,
          );
        } else {
          console.log(
            `Shared pack "${shared.packId}" ("${shared.title}") from "${shared.ownerKitchenSlug}" with "${shared.sharedWithKitchenSlug}".`,
          );
        }
        return;
      }

      case "pack-unshare": {
        const unshared = await unshareKitchenPack(parsed.input, db);
        if (unshared.removed) {
          console.log(
            `Unshared pack "${unshared.packId}" from "${unshared.sharedWithKitchenSlug}".`,
          );
        } else {
          console.log(
            `Pack "${unshared.packId}" was not shared with "${unshared.sharedWithKitchenSlug}".`,
          );
        }
        return;
      }

      case "circle-create": {
        const created = await createCircle(parsed.input, db);
        console.log(`Created circle "${created.name}" (${created.id}).`);
        return;
      }

      case "circle-add": {
        const added = await addKitchenToCircle(parsed.input, db);
        console.log(
          `Added kitchen "${added.kitchenSlug}" ("${added.kitchenName}") to circle "${added.circleName}" (${added.circleId}).`,
        );
        return;
      }

      case "circle-remove": {
        const removed = await removeKitchenFromCircle(parsed.input, db);
        console.log(
          `Removed kitchen "${removed.kitchenSlug}" from circle "${removed.circleName}" (${removed.circleId}).`,
        );
        return;
      }

      case "circle-list": {
        const listed = await listCircles(db);
        if (listed.length === 0) {
          console.log("No circles found.");
          return;
        }
        for (const circle of listed) {
          console.log(`${circle.id}\t${circle.name}`);
          for (const member of circle.members) {
            console.log(
              `  ${member.slug}\t${member.name}\t${member.joinedAt.toISOString()}`,
            );
          }
        }
        return;
      }
    }
  } finally {
    await client.end();
  }
}

function isDirectCliInvocation(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return (
      realpathSync(path.resolve(arg)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(arg) === fileURLToPath(import.meta.url);
  }
}

if (isDirectCliInvocation()) {
  main().catch((err) => {
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
