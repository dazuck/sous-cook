/**
 * Web server launcher for Playwright.
 *
 * Usage: tsx e2e/serve.ts [--build] --owner <pid>
 *
 * Refuses to start while any .env* file that Next.js loads exists in app/,
 * builds an isolated environment from scratch with outbound requests blocked,
 * verifies the E2E database is migrated, and exits if the owner process dies.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  E2E_APP_HOST,
  E2E_APP_PORT,
  E2E_DATABASE_URL,
  assertLocalDatabase,
} from "./env";

export const FORBIDDEN_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
] as const;

/**
 * Returns the subset of Next.js .env files present in `dir`.
 * Exported so unit tests can check it against a temporary directory.
 */
export function findForbiddenEnvFiles(dir: string): string[] {
  return FORBIDDEN_ENV_FILES.filter((name) => existsSync(path.join(dir, name)));
}

function buildBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
  if (process.env.E2E_APP_PORT !== undefined) {
    env.E2E_APP_PORT = process.env.E2E_APP_PORT;
  }
  if (process.env.E2E_PG_PORT !== undefined) {
    env.E2E_PG_PORT = process.env.E2E_PG_PORT;
  }
  if (process.env.E2E_PG_CONTAINER !== undefined) {
    env.E2E_PG_CONTAINER = process.env.E2E_PG_CONTAINER;
  }
  return env;
}

function buildServerEnv(): NodeJS.ProcessEnv {
  assertLocalDatabase(E2E_DATABASE_URL);
  return {
    ...buildBaseEnv(),
    DATABASE_URL: E2E_DATABASE_URL,
    SOUS_SIGN_IN: "off",
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

interface ServeArgs {
  build: boolean;
  ownerPid: number;
}

function parseArgs(argv: readonly string[]): ServeArgs {
  let build = false;
  let ownerRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--build") {
      build = true;
    } else if (arg === "--owner") {
      ownerRaw = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (ownerRaw === undefined || !/^\d+$/.test(ownerRaw)) {
    throw new Error("Usage: tsx e2e/serve.ts [--build] --owner <pid>");
  }
  const ownerPid = Number(ownerRaw);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error(`Invalid --owner pid: ${ownerRaw}`);
  }
  return { build, ownerPid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runNextBuild(appDir: string): Promise<void> {
  const nextBin = path.join(appDir, "node_modules/next/dist/bin/next");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build"], {
      cwd: appDir,
      env: buildBaseEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `next build failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });
  });
}

async function verifyDatabaseReady(): Promise<void> {
  assertLocalDatabase(E2E_DATABASE_URL);
  const sql = postgres(E2E_DATABASE_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM public.kitchens WHERE slug = 'home' LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error("Home kitchen row not found");
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const forbidden = findForbiddenEnvFiles(appDir);
  if (forbidden.length > 0) {
    console.error(
      `Refusing to start E2E server because Next.js would load env file(s) in app/: ${forbidden.join(", ")}. Move or remove them before running the browser suite.`,
    );
    process.exit(1);
  }

  try {
    await verifyDatabaseReady();
  } catch {
    console.error("run `pnpm --dir app e2e:db:up` first");
    process.exit(1);
  }

  if (args.build) {
    await runNextBuild(appDir);
  }

  const nextBin = path.join(appDir, "node_modules/next/dist/bin/next");
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "-H", E2E_APP_HOST, "-p", String(E2E_APP_PORT)],
    {
      cwd: appDir,
      env: buildServerEnv(),
      stdio: "inherit",
    },
  );

  let shuttingDown = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  const stopChild = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      forceKillTimer.unref();
    }
  };

  process.on("SIGINT", () => stopChild("SIGINT"));
  process.on("SIGTERM", () => stopChild("SIGTERM"));

  const ownerWatch = setInterval(() => {
    if (!isProcessAlive(args.ownerPid)) {
      stopChild("SIGTERM");
    }
  }, 1_000);

  child.on("error", (err) => {
    clearInterval(ownerWatch);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    console.error(`Failed to start next server: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    clearInterval(ownerWatch);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
    if (shuttingDown) {
      process.exit(0);
    }
    if (signal !== null) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
