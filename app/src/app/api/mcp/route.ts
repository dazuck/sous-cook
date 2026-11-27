import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { authUser, db, kitchenCookLog, kitchens, members } from "@/lib/db";
import { authenticateWebhookRequest } from "@/lib/kitchens/webhook-tokens";
import { checkWebhookRateLimit } from "@/lib/kitchens/webhook-rate-limit";
import { queueRecipeForKitchen } from "@/lib/kitchens/webhook-queue";
import { buildPackDigest } from "@/lib/kitchens/pack-digest";
import {
  KitchenPackError,
  MAX_KITCHEN_PACKS_PER_KITCHEN,
  RESERVED_PACK_IDS,
  listOwnedKitchenPacksForKitchen,
  upsertKitchenPackByKitchenId,
} from "@/lib/kitchens/packs";
import { formatAuthoringRulesText } from "@/lib/cookpacks/authoring";
import { PACKS_DIR, loadAppPackFiles } from "@/lib/shelf/load";
import { loadLibraries } from "@/lib/shelf/registry";

/**
 * Matches `/api/kitchen-queue` so `queue_recipe` has time for background
 * intake and cook-plan preparation after responding.
 */
export const maxDuration = 300;

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_COOK_LOG_LIMIT = 20;
const MAX_COOK_LOG_LIMIT = 100;

type JsonRpcId = string | number | null;

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "queue_recipe",
    description:
      "Queue a recipe for this kitchen. Accepts either a shelf pack recipe (packId and recipeId, or pack shorthand) or supplied recipeData.",
    inputSchema: {
      type: "object",
      properties: {
        packId: {
          type: "string",
          description: "Pack id from list_shelf.",
        },
        recipeId: {
          type: "string",
          description: "Recipe id inside the pack.",
        },
        pack: {
          type: "string",
          description: "Shorthand '<packId>/<recipeId>'.",
        },
        recipeData: {
          type: "object",
          description:
            "Supplied recipe with name and at least one ingredient or step.",
          properties: {
            name: { type: "string" },
            serves: { type: "number" },
            ingredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  amount: { type: "string" },
                  unit: { type: "string" },
                },
                required: ["item"],
              },
            },
            steps: { type: "array", items: { type: "string" } },
            stepIngredients: { type: "array" },
            estimatedTime: {
              type: "object",
              properties: {
                active: { type: "number" },
                passive: { type: "number" },
                total: { type: "number" },
              },
            },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
            source: { type: "string" },
          },
          required: ["name"],
        },
      },
    },
  },
  {
    name: "read_cook_log",
    description:
      "Read recent cook log entries for this kitchen, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COOK_LOG_LIMIT,
          description: `Maximum entries to return (1 to ${MAX_COOK_LOG_LIMIT}, default ${DEFAULT_COOK_LOG_LIMIT}).`,
        },
      },
    },
  },
  {
    name: "get_kitchen_context",
    description:
      "Read this kitchen's name and household context note ('About my kitchen').",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_shelf",
    description:
      "List the recipe packs and recipe summaries visible to this kitchen.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_pack_authoring_guide",
    description:
      "Return the exact Pack Format v0.7 specification, allowed technique/state ids, and reserved pack ids for building a collection to pass to save_pack.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "save_pack",
    description:
      "Create or update an owned recipe collection on this kitchen's shelf (validates Pack Format v0 schema, library refs, and cook-mode compatibility).",
    inputSchema: {
      type: "object",
      properties: {
        pack: {
          type: "object",
          description:
            "Complete flat Pack Format v0 JSON object (see get_pack_authoring_guide).",
        },
      },
      required: ["pack"],
    },
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidJsonRpcId(value: unknown): value is JsonRpcId {
  if (value === null || typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
): Response {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    },
    { status },
  );
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function mcpToolSuccess(id: JsonRpcId, payload: unknown): Response {
  return jsonRpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

function mcpToolError(id: JsonRpcId, payload: unknown): Response {
  return jsonRpcResult(id, {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

async function handleUnsupportedMethod(request: Request): Promise<Response> {
  const auth = await authenticateWebhookRequest(request);
  if (!auth.ok) return auth.response;

  const rateLimit = checkWebhookRateLimit(auth.kitchen.id);
  if (!rateLimit.ok) return rateLimit.response;

  return NextResponse.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/**
 * GET /api/mcp — not supported (SSE streaming is not used); checks auth and
 * rate limit first so unauthenticated callers learn nothing.
 */
export async function GET(request: Request): Promise<Response> {
  return handleUnsupportedMethod(request);
}

/**
 * DELETE /api/mcp — not supported (stateless endpoint); checks auth and rate
 * limit first so unauthenticated callers learn nothing.
 */
export async function DELETE(request: Request): Promise<Response> {
  return handleUnsupportedMethod(request);
}

/**
 * POST /api/mcp
 *
 * Stateless MCP JSON-RPC 2.0 endpoint over HTTP.
 *
 * Auth: Per-kitchen Bearer token (required in every environment), sharing the
 * per-kitchen rate limit with the webhook routes.
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
    return jsonRpcError(null, -32700, "Parse error: invalid JSON", 400);
  }

  if (!isPlainObject(body)) {
    return jsonRpcError(null, -32600, "Invalid Request", 400);
  }

  const hasId = "id" in body && body.id !== undefined;
  const rawId = hasId ? body.id : undefined;
  if (hasId && !isValidJsonRpcId(rawId)) {
    return jsonRpcError(null, -32600, "Invalid Request: invalid id", 400);
  }

  if (
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string" ||
    body.method.trim().length === 0
  ) {
    return jsonRpcError(
      hasId ? (rawId as JsonRpcId) : null,
      -32600,
      "Invalid Request",
      400,
    );
  }

  if ("params" in body && body.params !== undefined && !isPlainObject(body.params)) {
    return jsonRpcError(
      hasId ? (rawId as JsonRpcId) : null,
      -32600,
      "Invalid Request: params must be an object",
      400,
    );
  }

  // Notifications carry no `id` and expect a 202 empty acknowledgement.
  if (!hasId) {
    return new Response(null, { status: 202 });
  }

  const id = rawId as JsonRpcId;
  const method = body.method;
  const params = (body.params as Record<string, unknown> | undefined) ?? {};

  if (method === "initialize") {
    const requestedVersion = params.protocolVersion;
    const protocolVersion =
      typeof requestedVersion === "string" &&
      SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION;

    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "sous-kitchen", version: "1.0.0" },
    });
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: MCP_TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params.name;
    if (typeof toolName !== "string" || toolName.trim().length === 0) {
      return jsonRpcError(id, -32602, "Invalid params: tool name is required");
    }
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      return jsonRpcError(
        id,
        -32602,
        "Invalid params: arguments must be an object",
      );
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    return handleToolCall(id, auth.kitchen.id, toolName, args);
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

async function handleToolCall(
  id: JsonRpcId,
  kitchenId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Response> {
  switch (toolName) {
    case "queue_recipe": {
      const result = await queueRecipeForKitchen(kitchenId, args);
      if (result.status >= 400) {
        return mcpToolError(id, { status: result.status, ...result.body });
      }
      return mcpToolSuccess(id, result.body);
    }

    case "read_cook_log": {
      let limit = DEFAULT_COOK_LOG_LIMIT;
      if (args.limit !== undefined) {
        if (typeof args.limit !== "number" || !Number.isFinite(args.limit)) {
          return mcpToolError(id, {
            error: `limit must be a number between 1 and ${MAX_COOK_LOG_LIMIT}`,
          });
        }
        limit = Math.min(
          MAX_COOK_LOG_LIMIT,
          Math.max(1, Math.trunc(args.limit)),
        );
      }

      const rows = await db
        .select({
          id: kitchenCookLog.id,
          queueId: kitchenCookLog.queueId,
          packSource: kitchenCookLog.packSource,
          recipeTitle: kitchenCookLog.recipeTitle,
          cookedDay: kitchenCookLog.cookedDay,
          cookedAt: kitchenCookLog.cookedAt,
          cookedByName: authUser.name,
          rating: kitchenCookLog.rating,
          notes: kitchenCookLog.notes,
          notePrivate: kitchenCookLog.notePrivate,
          heldBack: kitchenCookLog.heldBack,
        })
        .from(kitchenCookLog)
        .leftJoin(members, eq(kitchenCookLog.cookedByMemberId, members.id))
        .leftJoin(authUser, eq(members.userId, authUser.id))
        .where(eq(kitchenCookLog.kitchenId, kitchenId))
        .orderBy(desc(kitchenCookLog.cookedAt), desc(kitchenCookLog.position))
        .limit(limit);

      return mcpToolSuccess(id, {
        entries: rows.map((row) => ({
          id: row.id,
          queueId: row.queueId,
          packSource: row.packSource,
          recipeTitle: row.recipeTitle,
          cookedDay: row.cookedDay,
          cookedAt: row.cookedAt.toISOString(),
          cookedByName: row.cookedByName ?? null,
          rating: row.rating,
          notes: row.notes,
          notePrivate: row.notePrivate,
          heldBack: row.heldBack,
        })),
      });
    }

    case "get_kitchen_context": {
      const [row] = await db
        .select({
          name: kitchens.name,
          about: kitchens.about,
        })
        .from(kitchens)
        .where(eq(kitchens.id, kitchenId))
        .limit(1);

      if (!row) {
        return mcpToolError(id, { error: "Kitchen not found" });
      }

      return mcpToolSuccess(id, {
        kitchenName: row.name,
        about: row.about,
      });
    }

    case "list_shelf": {
      const files = await loadAppPackFiles({ kitchenId });
      if (files.loadError !== undefined) {
        return mcpToolError(id, { error: files.loadError });
      }
      return mcpToolSuccess(id, {
        packs: buildPackDigest(files),
      });
    }

    case "get_pack_authoring_guide": {
      const libraries = await loadLibraries(PACKS_DIR);
      if (!libraries.ok) {
        return mcpToolError(id, {
          error: "Shared recipe libraries could not be read.",
        });
      }
      const owned = await listOwnedKitchenPacksForKitchen(kitchenId);
      const commons = libraries.libraries.commons.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      }));
      const states = libraries.libraries.states.map((s) => ({
        id: s.id,
        name: s.name,
        sensory_notes: s.sensory_notes,
      }));
      return mcpToolSuccess(id, {
        rules: formatAuthoringRulesText({ commons, states }),
        commons,
        states,
        reservedPackIds: [...RESERVED_PACK_IDS],
        ownedCollectionsCount: owned.length,
        maxCollections: MAX_KITCHEN_PACKS_PER_KITCHEN,
      });
    }

    case "save_pack": {
      if (!isPlainObject(args.pack)) {
        return mcpToolError(id, {
          error: "invalid_pack",
          message: "pack must be a JSON object matching Pack Format v0.",
        });
      }
      try {
        const saved = await upsertKitchenPackByKitchenId(kitchenId, {
          rawBytes: JSON.stringify(args.pack),
          packsDir: PACKS_DIR,
        });
        return mcpToolSuccess(id, { ok: true, ...saved });
      } catch (err) {
        if (err instanceof KitchenPackError) {
          return mcpToolError(id, {
            error: "invalid_pack",
            message: err.message,
          });
        }
        throw err;
      }
    }

    default:
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }
}
