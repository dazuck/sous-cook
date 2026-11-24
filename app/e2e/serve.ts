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
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
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
 * Returns true if something is accepting TCP connections on `host`:`port`.
 * A connection refused (ECONNREFUSED) means the port is free.
 */
export function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(err.code !== "ECONNREFUSED");
    });
  });
}

async function assertAppPortFree(host: string, port: number): Promise<void> {
  if (await isPortInUse(host, port)) {
    console.error(
      `Refusing to start E2E server because ${host}:${port} is already in use by another server.`,
    );
    process.exit(1);
  }
}

const HTTP_PROBE_TIMEOUT_MS = 5_000;

export function chunkEndsWithNewline(chunk: Buffer | string): boolean {
  if (chunk.length === 0) return false;
  return typeof chunk === "string"
    ? chunk.charCodeAt(chunk.length - 1) === 0x0a
    : chunk[chunk.length - 1] === 0x0a;
}

export function formatReadyLine(
  pid: number,
  port: number,
  lastByteWasNewline: boolean,
): string {
  const prefix = lastByteWasNewline ? "" : "\n";
  return `${prefix}sous-e2e-server-ready pid=${pid} port=${port}\n`;
}

export function probeLocalHttp(
  host: string,
  port: number,
  urlPath: string,
  timeoutMs: number = HTTP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (timeoutMs <= 0) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(ok);
    };

    const req = http.get(
      { host, port, path: urlPath, agent: false, timeout: timeoutMs },
      (res) => {
        res.once("error", () => {});
        res.resume();
        const status = res.statusCode ?? 0;
        finish(status >= 200 && status < 404);
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      finish(false);
    }, timeoutMs);
    timer.unref();
    req.once("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => {
      req.destroy();
      finish(false);
    });
  });
}

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

function buildBuildEnv(): NodeJS.ProcessEnv {
  const env = buildBaseEnv();
  if (process.env.SOUS_RELEASE_COMMIT !== undefined) {
    env.SOUS_RELEASE_COMMIT = process.env.SOUS_RELEASE_COMMIT;
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
      env: buildBuildEnv(),
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

  await assertAppPortFree(E2E_APP_HOST, E2E_APP_PORT);

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

  await assertAppPortFree(E2E_APP_HOST, E2E_APP_PORT);

  const nextBin = path.join(appDir, "node_modules/next/dist/bin/next");
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "-H", E2E_APP_HOST, "-p", String(E2E_APP_PORT)],
    {
      cwd: appDir,
      env: buildServerEnv(),
      stdio: ["inherit", "pipe", "inherit"],
    },
  );

  let shuttingDown = false;
  let shutdownExitCode = 0;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  const stopChild = (signal: NodeJS.Signals, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownExitCode = exitCode;
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

  const isChildRunning = (): boolean =>
    !shuttingDown &&
    child.exitCode === null &&
    child.signalCode === null &&
    child.pid !== undefined;

  let nextReadySeen = false;
  let readyPrinted = false;
  let lastStdoutByteWasNewline = true;
  let stdoutBuffer = "";

  const confirmAndAnnounceReady = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (isChildRunning()) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const probeTimeoutMs = Math.min(HTTP_PROBE_TIMEOUT_MS, remainingMs);
      if (
        await probeLocalHttp(
          E2E_APP_HOST,
          E2E_APP_PORT,
          "/kitchen",
          probeTimeoutMs,
        )
      ) {
        if (!isChildRunning()) return;
        readyPrinted = true;
        const readyLine = formatReadyLine(
          child.pid!,
          E2E_APP_PORT,
          lastStdoutByteWasNewline,
        );
        lastStdoutByteWasNewline = true;
        process.stdout.write(readyLine);
        return;
      }
      if (!isChildRunning()) return;
      const sleepMs = Math.min(100, deadline - Date.now());
      if (sleepMs <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
    if (isChildRunning()) {
      console.error(
        `Next.js server on ${E2E_APP_HOST}:${E2E_APP_PORT} did not answer /kitchen after reporting ready.`,
      );
      stopChild("SIGTERM", 1);
    }
  };

  const checkLineForReady = (line: string): void => {
    if (nextReadySeen) return;
    const plain = stripVTControlCharacters(line);
    if (/\bReady in\s+\S+/.test(plain)) {
      nextReadySeen = true;
      void confirmAndAnnounceReady();
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (chunk.length > 0) {
      lastStdoutByteWasNewline = chunkEndsWithNewline(chunk);
    }
    process.stdout.write(chunk);
    if (nextReadySeen) return;
    stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      checkLineForReady(line);
    }
  });

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
      process.exit(shutdownExitCode);
    }
    if (!readyPrinted) {
      console.error(
        `Next.js server exited before reporting ready (code=${String(code)}, signal=${String(signal)}).`,
      );
      process.exit(code !== null && code !== 0 ? code : 1);
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
