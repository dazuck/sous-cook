#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP_TEXT = `Send a recipe JSON payload to a Sous kitchen queue.

Usage:
  send-recipe.mjs [options] [<file>]

Options:
  -f, --file <path>   Read recipe JSON from <path> (or "-" for stdin)
      --dry-run       Check address and recipe JSON without sending
  -h, --help          Show this help text

Environment:
  SOUS_URL            Sous app URL (https://..., or http:// for localhost)
  SOUS_TOKEN          Kitchen sending token (never pass as an argument)
`;

const TOKEN_PREFIX = "sous_";
const PACK_SHORTHAND_RE = /^(?:pack:)?([^/\s]+)\/([^/\s]+)$/;
const REQUEST_TIMEOUT_MS = 30_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeText(text, token) {
  let result = oneLine(text);
  if (token && token.length > 0) {
    result = result.split(token).join("[REDACTED]");
  }
  return result.replace(/sous_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function isTokenArg(arg) {
  if (
    arg === "--token" ||
    arg === "-t" ||
    arg === "--bearer" ||
    arg === "--auth" ||
    arg.startsWith("--token=") ||
    arg.startsWith("-t=") ||
    arg.startsWith("--bearer=") ||
    arg.startsWith("--auth=")
  ) {
    return true;
  }
  if (arg.startsWith(TOKEN_PREFIX) || /^Bearer\s+/i.test(arg)) {
    return true;
  }
  return false;
}

export function parseCliArgs(argv) {
  let dryRun = false;
  let help = false;
  let filePath = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (isTokenArg(arg)) {
      throw new Error(
        "Do not pass a token as an argument; set SOUS_TOKEN in the environment instead.",
      );
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`Option ${arg} requires a file path.`);
      }
      if (isTokenArg(next)) {
        throw new Error(
          "Do not pass a token as an argument; set SOUS_TOKEN in the environment instead.",
        );
      }
      if (filePath !== null) {
        throw new Error("Pass only one input file.");
      }
      filePath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      const val = arg.slice("--file=".length);
      if (!val) {
        throw new Error("Option --file requires a file path.");
      }
      if (filePath !== null) {
        throw new Error("Pass only one input file.");
      }
      filePath = val;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }
    if (filePath !== null) {
      throw new Error("Pass only one input file.");
    }
    filePath = arg;
  }

  return { dryRun, help, filePath };
}

export function validateSousUrl(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) {
    throw new Error("SOUS_URL is required (for example https://sous.example.com).");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`SOUS_URL is not a valid URL: ${trimmed}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("SOUS_URL must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("SOUS_URL must not contain a query string or fragment.");
  }

  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLocalhost =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    if (!isLocalhost) {
      throw new Error(
        "Plain http:// is refused except for localhost, 127.0.0.1, or [::1]; use https://.",
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`SOUS_URL must use https:// (or http:// for localhost), got ${parsed.protocol}`);
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/api/kitchen-queue")) {
    pathname = pathname.slice(0, -"/api/kitchen-queue".length);
  }
  return `${parsed.origin}${pathname}/api/kitchen-queue`;
}

export function validateToken(rawToken) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) {
    throw new Error("SOUS_TOKEN is required.");
  }
  if (/[\r\n\0]/.test(token)) {
    throw new Error("SOUS_TOKEN contains invalid control characters.");
  }
  return token;
}

function validateIngredientObject(entry, label) {
  if (!isPlainObject(entry)) {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof entry.item !== "string") {
    throw new Error(`${label}.item must be a string.`);
  }
  if (entry.amount !== undefined && typeof entry.amount !== "string") {
    throw new Error(`${label}.amount must be a string.`);
  }
  if (entry.unit !== undefined && typeof entry.unit !== "string") {
    throw new Error(`${label}.unit must be a string.`);
  }
}

function isBlankIngredient(entry) {
  return (
    entry.item.trim() === "" &&
    (entry.amount ?? "").trim() === "" &&
    (entry.unit ?? "").trim() === ""
  );
}

export function validateRecipePayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error("Recipe JSON must be an object.");
  }
  if ("targetUser" in payload) {
    throw new Error("targetUser is not accepted: the token names the kitchen.");
  }

  const hasPackFields =
    payload.pack !== undefined ||
    payload.packId !== undefined ||
    payload.recipeId !== undefined;
  const hasRecipeData = payload.recipeData !== undefined;

  if (hasPackFields && hasRecipeData) {
    throw new Error(
      'Send either { "pack": "<packId>/<recipeId>" } or { "recipeData": { ... } }, not both.',
    );
  }

  if (hasPackFields) {
    if (payload.packId !== undefined || payload.recipeId !== undefined) {
      if (!isNonEmptyString(payload.packId) || !isNonEmptyString(payload.recipeId)) {
        throw new Error("Both packId and recipeId must be non-empty strings.");
      }
      return {
        kind: "pack",
        label: `${payload.packId.trim()}/${payload.recipeId.trim()}`,
      };
    }
    if (!isNonEmptyString(payload.pack) || !PACK_SHORTHAND_RE.test(payload.pack.trim())) {
      throw new Error('pack must be formatted as "<packId>/<recipeId>".');
    }
    const cleanPack = payload.pack.trim().replace(/^pack:/, "");
    return { kind: "pack", label: cleanPack };
  }

  if (!hasRecipeData) {
    if (payload.recipeNotionId !== undefined) {
      throw new Error(
        "recipeNotionId alone queues no recipe; send recipeData or pack instead.",
      );
    }
    if (typeof payload.name === "string") {
      throw new Error(
        'Body must wrap the recipe in { "recipeData": { ... } } or specify { "pack": "<packId>/<recipeId>" }.',
      );
    }
    throw new Error(
      'Body must contain either { "recipeData": { ... } } or { "pack": "<packId>/<recipeId>" }.',
    );
  }

  const data = payload.recipeData;
  if (!isPlainObject(data)) {
    throw new Error("recipeData must be an object.");
  }
  if (!isNonEmptyString(data.name)) {
    throw new Error("recipeData.name must be a non-empty string.");
  }

  if (data.ingredients !== undefined) {
    if (!Array.isArray(data.ingredients)) {
      throw new Error("recipeData.ingredients must be an array.");
    }
    for (let i = 0; i < data.ingredients.length; i += 1) {
      validateIngredientObject(data.ingredients[i], `recipeData.ingredients[${i}]`);
    }
  }

  if (data.steps !== undefined) {
    if (!Array.isArray(data.steps)) {
      throw new Error("recipeData.steps must be an array.");
    }
    for (let i = 0; i < data.steps.length; i += 1) {
      if (typeof data.steps[i] !== "string") {
        throw new Error(`recipeData.steps[${i}] must be a string.`);
      }
    }
  }

  const hasNonBlankIngredient =
    Array.isArray(data.ingredients) &&
    data.ingredients.some((entry) => !isBlankIngredient(entry));
  const hasNonBlankStep =
    Array.isArray(data.steps) &&
    data.steps.some((step) => step.trim().length > 0);
  if (!hasNonBlankIngredient && !hasNonBlankStep) {
    throw new Error(
      "A recipe needs at least one non-blank ingredient or one non-blank step.",
    );
  }

  if (data.stepIngredients !== undefined) {
    if (!Array.isArray(data.stepIngredients)) {
      throw new Error("recipeData.stepIngredients must be an array.");
    }
    for (let i = 0; i < data.stepIngredients.length; i += 1) {
      const row = data.stepIngredients[i];
      if (!Array.isArray(row)) {
        throw new Error(`recipeData.stepIngredients[${i}] must be an array.`);
      }
      for (let j = 0; j < row.length; j += 1) {
        const entry = row[j];
        if (typeof entry === "number") {
          if (!Number.isFinite(entry)) {
            throw new Error(
              `recipeData.stepIngredients[${i}][${j}] must be a finite number.`,
            );
          }
        } else {
          validateIngredientObject(
            entry,
            `recipeData.stepIngredients[${i}][${j}]`,
          );
        }
      }
    }
  }

  if (data.estimatedTime !== undefined) {
    if (!isPlainObject(data.estimatedTime)) {
      throw new Error("recipeData.estimatedTime must be an object.");
    }
    for (const key of ["active", "passive", "total"]) {
      const val = data.estimatedTime[key];
      if (val !== undefined) {
        if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
          throw new Error(
            `recipeData.estimatedTime.${key} must be a non-negative number.`,
          );
        }
      }
    }
  }

  if (data.serves !== undefined) {
    if (
      typeof data.serves !== "number" ||
      !Number.isFinite(data.serves) ||
      data.serves <= 0
    ) {
      throw new Error("recipeData.serves must be a positive number.");
    }
  }

  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags)) {
      throw new Error("recipeData.tags must be an array.");
    }
    for (let i = 0; i < data.tags.length; i += 1) {
      if (typeof data.tags[i] !== "string") {
        throw new Error(`recipeData.tags[${i}] must be a string.`);
      }
    }
  }

  if (data.notes !== undefined && typeof data.notes !== "string") {
    throw new Error("recipeData.notes must be a string.");
  }

  if (data.source !== undefined && typeof data.source !== "string") {
    throw new Error("recipeData.source must be a string.");
  }

  return { kind: "recipe", label: data.name.trim() };
}

function readJsonInput(filePath, stdinFd = 0, isStdinTTY = Boolean(process.stdin.isTTY)) {
  let raw;
  if (filePath === null || filePath === "-") {
    if (filePath === null && isStdinTTY) {
      throw new Error("Pass a JSON file path or pipe recipe JSON to stdin.");
    }
    try {
      raw = readFileSync(stdinFd, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read stdin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(
        `Could not read "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!raw.trim()) {
    throw new Error("Input is empty; expected recipe JSON.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Input is not valid JSON.");
  }
}

export function formatServerError(status, data, rawBody, token) {
  const detailText = (parts) => sanitizeText(parts.filter(Boolean).join(" "), token);

  if (status === 401) {
    return "Unauthorized (401): token missing, unknown, or revoked.";
  }
  if (status === 404) {
    const msg = isPlainObject(data) && typeof data.error === "string"
      ? data.error
      : "Pack or recipe not found.";
    return detailText([`Not found (404): ${msg}`]);
  }
  if (status === 422) {
    const base = isPlainObject(data) && typeof data.error === "string"
      ? data.error
      : "Recipe cannot be read as a pack recipe";
    const firstIssue =
      isPlainObject(data) && Array.isArray(data.issues) && data.issues[0]
        ? `${data.issues[0].path ?? "recipe"}: ${data.issues[0].message ?? ""}`
        : isPlainObject(data) && Array.isArray(data.differences) && data.differences[0]
          ? String(data.differences[0])
          : "";
    return detailText([
      `Unreadable recipe (422): ${base}${firstIssue ? ` (${firstIssue})` : ""}.`,
    ]);
  }
  if (status === 429) {
    if (isPlainObject(data) && data.error === "rate_limit_exceeded") {
      const msg = typeof data.message === "string"
        ? data.message
        : "Too many requests; retry shortly.";
      return detailText([`Rate limit exceeded (429): ${msg}`]);
    }
    const msg = isPlainObject(data) && typeof data.message === "string"
      ? data.message
      : "Monthly AI allowance used.";
    const resets = isPlainObject(data) && typeof data.resetsAt === "string"
      ? ` Resets ${data.resetsAt}.`
      : "";
    return detailText([`Monthly AI allowance used (429): ${msg}${resets}`]);
  }
  if (status === 503) {
    const msg = isPlainObject(data) && typeof data.error === "string"
      ? data.error
      : "Service unavailable.";
    const reason = isPlainObject(data) && typeof data.reason === "string"
      ? ` (${data.reason})`
      : "";
    return detailText([`Service unavailable (503): ${msg}${reason}.`]);
  }
  if (status === 400) {
    const msg = isPlainObject(data) && typeof data.error === "string"
      ? data.error
      : "Validation error";
    return detailText([`Refused (400): ${msg}.`]);
  }
  if (status >= 500) {
    const msg = isPlainObject(data) && typeof data.error === "string"
      ? data.error
      : rawBody
        ? rawBody
        : "Server error (check server logs or database connection).";
    return detailText([`Server error (${status}): ${msg}`]);
  }
  const fallback = isPlainObject(data) && typeof data.error === "string"
    ? data.error
    : rawBody || "Request failed";
  return detailText([`Request failed (${status}): ${fallback}`]);
}

export async function runCli(
  argv = process.argv.slice(2),
  env = process.env,
  io = {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    fetchImpl: fetch,
    isStdinTTY: Boolean(process.stdin.isTTY),
  },
) {
  let tokenForSanitize = typeof env.SOUS_TOKEN === "string" ? env.SOUS_TOKEN.trim() : "";

  try {
    const { dryRun, help, filePath } = parseCliArgs(argv);
    if (help) {
      process.stdout.write(HELP_TEXT);
      return 0;
    }

    const payload = readJsonInput(filePath, 0, io.isStdinTTY);
    const summary = validateRecipePayload(payload);

    const hasSousUrl = typeof env.SOUS_URL === "string" && env.SOUS_URL.trim().length > 0;
    let endpointUrl = null;
    if (!dryRun || hasSousUrl) {
      endpointUrl = validateSousUrl(env.SOUS_URL);
    }

    if (dryRun) {
      const targetText = endpointUrl ? ` to ${endpointUrl}` : "";
      io.stdout(
        `Dry run: ${summary.kind === "pack" ? `pack recipe "${summary.label}"` : `recipe "${summary.label}"`} is valid${targetText}.`,
      );
      return 0;
    }

    const token = validateToken(env.SOUS_TOKEN);
    tokenForSanitize = token;

    let response;
    try {
      response = await io.fetchImpl(endpointUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = sanitizeText(
        err instanceof Error ? err.message : String(err),
        token,
      );
      io.stderr(`Could not reach ${endpointUrl}: ${msg}`);
      return 1;
    }

    const rawBody = await response.text();
    let data = null;
    if (rawBody.trim().length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      io.stderr(formatServerError(response.status, data, rawBody, token));
      return 1;
    }

    const queueId =
      isPlainObject(data) && Array.isArray(data.queueIds) && typeof data.queueIds[0] === "string"
        ? data.queueIds[0]
        : isPlainObject(data) && typeof data.id === "string"
          ? data.id
          : "queued";

    if (response.status === 201 && isPlainObject(data) && typeof data.name === "string") {
      const sourceText = typeof data.source === "string" ? ` (${data.source})` : "";
      io.stdout(`Queued pack recipe "${oneLine(data.name)}"${sourceText} as ${queueId}.`);
      return 0;
    }

    io.stdout(`Queued "${oneLine(summary.label)}" as ${queueId}.`);
    return 0;
  } catch (err) {
    io.stderr(
      sanitizeText(err instanceof Error ? err.message : String(err), tokenForSanitize),
    );
    return 1;
  }
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
