import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../..");
const BACKUP_SCRIPT_SRC = path.join(REPO_ROOT, "scripts/backup.sh");
const SCRIPT_TIMEOUT_MS = 15_000;

interface BackupHarness {
  rootDir: string;
  nonGitDir: string;
  binDir: string;
  backupDir: string;
  tmpDir: string;
  deployEnvFile: string;
  callLogFile: string;
  pgDumpEnvLogFile: string;
  pgDumpArgsLogFile: string;
  pgDumpFailMarker: string;
  emptyDumpMarker: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const activeRoots: string[] = [];

afterEach(() => {
  while (activeRoots.length > 0) {
    const dir = activeRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createHarness(): BackupHarness {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "sous-backup-test-"));
  activeRoots.push(rootDir);

  const nonGitDir = path.join(rootDir, "outside-git");
  const binDir = path.join(rootDir, "bin");
  const backupDir = path.join(rootDir, "backups");
  const tmpDir = path.join(rootDir, "tmp");
  const deployEnvFile = path.join(rootDir, "deploy.env");
  const callLogFile = path.join(rootDir, "calls.log");
  const pgDumpEnvLogFile = path.join(rootDir, "pg-dump-env.log");
  const pgDumpArgsLogFile = path.join(rootDir, "pg-dump-args.log");
  const pgDumpFailMarker = path.join(rootDir, "pg-dump-fail.marker");
  const emptyDumpMarker = path.join(rootDir, "empty-dump.marker");

  mkdirSync(nonGitDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  // Stand-in pg_dump that records its exact args and PG* env vars.
  const fakePgDumpPath = path.join(binDir, "pg_dump");
  writeFileSync(
    fakePgDumpPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      `printf 'pg_dump %s\\n' "$*" >> "${callLogFile}"`,
      'pg_vars="$(env | awk -F= \'/^PG/ { print $1 "=" $2 }\' | sort | paste -sd, -)"',
      `printf '%s\\n' "\${pg_vars}" >> "${pgDumpEnvLogFile}"`,
      'arg_sep=""',
      'for arg in "$@"; do',
      `  printf '%s%s' "\${arg_sep}" "\${arg}" >> "${pgDumpArgsLogFile}"`,
      "  arg_sep=$'\\t'",
      "done",
      `printf '\\n' >> "${pgDumpArgsLogFile}"`,
      'out_file=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-f" ] && [ "$#" -ge 2 ]; then',
      '    out_file="$2"',
      "    shift 2",
      "  else",
      "    shift",
      "  fi",
      "done",
      'if [ -z "${out_file}" ]; then',
      '  printf "fake pg_dump: missing -f path\\n" >&2',
      "  exit 1",
      "fi",
      `if [ -e "${pgDumpFailMarker}" ]; then`,
      '  printf "PGDMP-partial\\n" > "${out_file}"',
      '  printf "simulated pg_dump failure\\n" >&2',
      "  exit 1",
      "fi",
      `if [ -e "${emptyDumpMarker}" ]; then`,
      '  : > "${out_file}"',
      "else",
      '  printf "PGDMP-test-backup\\n" > "${out_file}"',
      "fi",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePgDumpPath, 0o755);

  const dbUrl = new URL("postgres://db.example.com:5432/sous?sslmode=require");
  dbUrl.username = "backupuser";
  dbUrl.password = "secretpass";
  writeFileSync(deployEnvFile, `DATABASE_URL=${dbUrl.toString()}\n`, "utf8");
  chmodSync(deployEnvFile, 0o600);

  return {
    rootDir,
    nonGitDir,
    binDir,
    backupDir,
    tmpDir,
    deployEnvFile,
    callLogFile,
    pgDumpEnvLogFile,
    pgDumpArgsLogFile,
    pgDumpFailMarker,
    emptyDumpMarker,
  };
}

function runBackup(
  h: BackupHarness,
  args: readonly string[],
  envOverrides: Record<string, string | undefined> = {},
  bashFlags: readonly string[] = [],
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: `${h.binDir}:${process.env.PATH ?? ""}`,
    HOME: h.rootDir,
    TMPDIR: h.tmpDir,
    SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
    SOUS_BACKUP_DIR: h.backupDir,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("bash", [...bashFlags, BACKUP_SCRIPT_SRC, ...args], {
      cwd: h.nonGitDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function readCalls(h: BackupHarness): string[] {
  if (!existsSync(h.callLogFile)) return [];
  return readFileSync(h.callLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readPgDumpEnvMaps(h: BackupHarness): Record<string, string>[] {
  if (!existsSync(h.pgDumpEnvLogFile)) return [];
  return readFileSync(h.pgDumpEnvLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const record: Record<string, string> = {};
      for (const pair of line.split(",")) {
        if (!pair) continue;
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          record[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }
      return record;
    });
}

function readPgDumpArgs(h: BackupHarness): string[][] {
  if (!existsSync(h.pgDumpArgsLogFile)) return [];
  return readFileSync(h.pgDumpArgsLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

function setAgeDays(filePath: string, daysAgo: number): void {
  const mtime = new Date(Date.now() - daysAgo * 86_400 * 1000);
  utimesSync(filePath, mtime, mtime);
}

describe("scripts/backup.sh", () => {
  it(
    "BACKUP-1: supports --help/-h and rejects unknown flags and positional arguments without running pg_dump",
    async () => {
      const h = createHarness();

      for (const flag of ["--help", "-h"]) {
        const res = await runBackup(h, [flag], {
          SOUS_DEPLOY_ENV_FILE: undefined,
          SOUS_BACKUP_DIR: undefined,
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Usage:");
        expect(res.stdout).toContain("--dry-run");
        expect(res.stdout).toContain("SOUS_BACKUP_KEEP_DAYS");
      }

      const unknownFlag = await runBackup(h, ["--bogus"]);
      expect(unknownFlag.status).toBe(1);
      expect(unknownFlag.stderr).toContain("unknown option: --bogus");
      expect(unknownFlag.stderr).toContain("Usage:");

      const extraArg = await runBackup(h, ["unexpected-arg"]);
      expect(extraArg.status).toBe(1);
      expect(extraArg.stderr).toContain("unexpected argument: unexpected-arg");
      expect(extraArg.stderr).toContain("Usage:");

      const afterDoubleDash = await runBackup(h, ["--", "positional"]);
      expect(afterDoubleDash.status).toBe(1);
      expect(afterDoubleDash.stderr).toContain("unexpected argument: positional");
      expect(afterDoubleDash.stderr).toContain("Usage:");

      expect(readCalls(h)).toEqual([]);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-2: validates required env vars upfront and rejects invalid SOUS_BACKUP_KEEP_DAYS or non-directory SOUS_BACKUP_DIR",
    async () => {
      const h = createHarness();

      const missingBoth = await runBackup(h, ["--dry-run"], {
        SOUS_DEPLOY_ENV_FILE: undefined,
        SOUS_BACKUP_DIR: undefined,
      });
      expect(missingBoth.status).toBe(1);
      expect(missingBoth.stderr).toContain("SOUS_DEPLOY_ENV_FILE");
      expect(missingBoth.stderr).toContain("SOUS_BACKUP_DIR");

      const missingOne = await runBackup(h, [], {
        SOUS_BACKUP_DIR: undefined,
      });
      expect(missingOne.status).toBe(1);
      expect(missingOne.stderr).toContain("SOUS_BACKUP_DIR");
      expect(missingOne.stderr).not.toContain("SOUS_DEPLOY_ENV_FILE");

      for (const badDays of ["0", "-1", "1.5", "abc", "01", "14d"]) {
        const badRes = await runBackup(h, ["--dry-run"], {
          SOUS_BACKUP_KEEP_DAYS: badDays,
        });
        expect(badRes.status).toBe(1);
        expect(badRes.stderr).toContain("SOUS_BACKUP_KEEP_DAYS");
      }

      const missingEnvFile = await runBackup(h, ["--dry-run"], {
        SOUS_DEPLOY_ENV_FILE: path.join(h.rootDir, "missing.env"),
      });
      expect(missingEnvFile.status).toBe(1);
      expect(missingEnvFile.stderr).toContain("SOUS_DEPLOY_ENV_FILE");

      const fileAsDir = path.join(h.rootDir, "not-a-dir");
      writeFileSync(fileAsDir, "oops\n", "utf8");
      const badDirRes = await runBackup(h, [], {
        SOUS_BACKUP_DIR: fileAsDir,
      });
      expect(badDirRes.status).toBe(1);
      expect(badDirRes.stderr).toContain("not a directory");

      expect(readCalls(h)).toEqual([]);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-3: parses SOUS_DEPLOY_ENV_FILE as plain text without executing shell syntax and validates DATABASE_URL",
    async () => {
      const h = createHarness();
      const marker1 = path.join(h.rootDir, "pwned-comment");
      const marker2 = path.join(h.rootDir, "pwned-var");
      const marker3 = path.join(h.rootDir, "pwned-url");
      const quotedEnvFile = path.join(h.rootDir, "quoted.env");

      writeFileSync(
        quotedEnvFile,
        [
          `# $(touch ${marker1})`,
          `OTHER_VAR=\`touch ${marker2}\``,
          `DATABASE_URL="${["postgres://u%20ser", "p%23ss"].join(":")}@db.example.com:5433/sous_prod?sslmode=verify-full"`,
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(quotedEnvFile, 0o600);

      const okRes = await runBackup(h, [], {
        SOUS_DEPLOY_ENV_FILE: quotedEnvFile,
      });
      expect(okRes.status).toBe(0);
      expect(existsSync(marker1)).toBe(false);
      expect(existsSync(marker2)).toBe(false);
      expect(okRes.stdout).not.toContain("p#ss");
      expect(okRes.stderr).not.toContain("p#ss");

      const pgEnvs = readPgDumpEnvMaps(h);
      expect(pgEnvs).toHaveLength(1);
      expect(pgEnvs[0]).toEqual({
        PGDATABASE: "sous_prod",
        PGHOST: "db.example.com",
        PGPASSWORD: "p#ss",
        PGPORT: "5433",
        PGSSLMODE: "verify-full",
        PGUSER: "u ser",
      });

      // Unquoted shell substitution inside DATABASE_URL is rejected by URL parsing and never executed.
      const injectEnvFile = path.join(h.rootDir, "inject.env");
      writeFileSync(
        injectEnvFile,
        `DATABASE_URL=postgres://user:$(touch ${marker3})@db.example.com/sous\n`,
        "utf8",
      );
      const injectRes = await runBackup(h, ["--dry-run"], {
        SOUS_DEPLOY_ENV_FILE: injectEnvFile,
      });
      expect(injectRes.status).toBe(1);
      expect(existsSync(marker3)).toBe(false);

      // URL containing a # fragment is refused without leaking password or host.
      const fragEnvFile = path.join(h.rootDir, "frag.env");
      writeFileSync(
        fragEnvFile,
        `DATABASE_URL=${["postgres://backupuser", "secretfrag"].join(":")}@db.example.com:5432/sous#frag\n`,
        "utf8",
      );
      const fragRes = await runBackup(h, ["--dry-run"], {
        SOUS_DEPLOY_ENV_FILE: fragEnvFile,
      });
      expect(fragRes.status).toBe(1);
      expect(fragRes.stderr).toContain("#");
      expect(fragRes.stderr).not.toContain("secretfrag");
      expect(fragRes.stderr).not.toContain("db.example.com");
      expect(fragRes.stdout).not.toContain("secretfrag");
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-4: --dry-run validates, reports host/target/command/prunable files, and leaves disk untouched",
    async () => {
      const h1 = createHarness();
      const res1 = await runBackup(h1, ["--dry-run"]);
      expect(res1.status).toBe(0);
      expect(existsSync(h1.backupDir)).toBe(false);
      expect(readCalls(h1)).toEqual([]);
      expect(res1.stdout).toContain("Database host: db.example.com:5432");
      expect(res1.stdout).toContain("Retention days: 14");
      expect(res1.stdout).toContain(
        "pg_dump -Fc --no-owner -n public -n drizzle -f ",
      );
      expect(res1.stdout).toContain("sous-backup-");
      expect(res1.stdout).toContain("Would prune 0 old backup(s)");
      expect(res1.stdout).toContain("dry run: nothing was changed");
      expect(res1.stdout).not.toContain("secretpass");

      const h2 = createHarness();
      mkdirSync(h2.backupDir, { recursive: true });
      const oldDump = path.join(h2.backupDir, "sous-backup-20260101T000000Z.dump");
      const freshDump = path.join(h2.backupDir, "sous-backup-recent.dump");
      writeFileSync(oldDump, "old", "utf8");
      writeFileSync(freshDump, "fresh", "utf8");
      setAgeDays(oldDump, 10);
      setAgeDays(freshDump, 2);

      const res2 = await runBackup(h2, ["--dry-run"], {
        SOUS_BACKUP_KEEP_DAYS: "7",
      });
      expect(res2.status).toBe(0);
      expect(readCalls(h2)).toEqual([]);
      expect(res2.stdout).toContain("Would prune 1 old backup(s) older than 7 day(s):");
      expect(res2.stdout).toContain(oldDump);
      expect(res2.stdout).not.toContain(freshDump);
      expect(existsSync(oldDump)).toBe(true);
      expect(existsSync(freshDump)).toBe(true);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-5: real run works outside git, secures directory mode 700, passes PG* env without leaking password under xtrace, and cleans temp files",
    async () => {
      const h = createHarness();
      mkdirSync(h.backupDir, { recursive: true, mode: 0o755 });
      chmodSync(h.backupDir, 0o755);

      // Also verify tracing does not leak PGPASSWORD or env values.
      const res = await runBackup(
        h,
        [],
        { SHELLOPTS: "xtrace" },
        ["-x"],
      );
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain("secretpass");
      expect(res.stderr).not.toContain("secretpass");

      expect(statSync(h.backupDir).mode & 0o777).toBe(0o700);
      expect(readdirSync(h.tmpDir)).toEqual([]);

      const dumps = readdirSync(h.backupDir).filter(
        (f) => f.startsWith("sous-backup-") && f.endsWith(".dump"),
      );
      expect(dumps).toHaveLength(1);
      const dumpPath = path.join(h.backupDir, dumps[0]!);
      expect(statSync(dumpPath).size).toBeGreaterThan(0);

      const argsRuns = readPgDumpArgs(h);
      expect(argsRuns).toEqual([
        ["-Fc", "--no-owner", "-n", "public", "-n", "drizzle", "-f", dumpPath],
      ]);

      const envRuns = readPgDumpEnvMaps(h);
      expect(envRuns).toEqual([
        {
          PGDATABASE: "sous",
          PGHOST: "db.example.com",
          PGPASSWORD: "secretpass",
          PGPORT: "5432",
          PGSSLMODE: "require",
          PGUSER: "backupuser",
        },
      ]);

      // A second run in the same second avoids overwriting the existing dump.
      const res2 = await runBackup(h, []);
      expect(res2.status).toBe(0);
      const dumpsAfter = readdirSync(h.backupDir).filter(
        (f) => f.startsWith("sous-backup-") && f.endsWith(".dump"),
      );
      expect(dumpsAfter).toHaveLength(2);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-6: pg_dump failure or 0-byte dump removes partial file, exits 1, and preserves expired backups",
    async () => {
      const hFail = createHarness();
      mkdirSync(hFail.backupDir, { recursive: true });
      const expiredFail = path.join(hFail.backupDir, "sous-backup-old.dump");
      writeFileSync(expiredFail, "keep-me-on-failure", "utf8");
      setAgeDays(expiredFail, 30);
      writeFileSync(hFail.pgDumpFailMarker, "1\n", "utf8");

      const failRes = await runBackup(hFail, [], {
        SOUS_BACKUP_KEEP_DAYS: "7",
      });
      expect(failRes.status).toBe(1);
      expect(failRes.stderr).toContain("pg_dump failed");
      expect(failRes.stdout).not.toContain("secretpass");
      expect(failRes.stderr).not.toContain("secretpass");
      expect(readdirSync(hFail.backupDir)).toEqual(["sous-backup-old.dump"]);
      expect(readdirSync(hFail.tmpDir)).toEqual([]);

      const hEmpty = createHarness();
      mkdirSync(hEmpty.backupDir, { recursive: true });
      const expiredEmpty = path.join(hEmpty.backupDir, "sous-backup-old.dump");
      writeFileSync(expiredEmpty, "keep-me-on-empty", "utf8");
      setAgeDays(expiredEmpty, 30);
      writeFileSync(hEmpty.emptyDumpMarker, "1\n", "utf8");

      const emptyRes = await runBackup(hEmpty, [], {
        SOUS_BACKUP_KEEP_DAYS: "7",
      });
      expect(emptyRes.status).toBe(1);
      expect(emptyRes.stderr).toContain("empty");
      expect(readdirSync(hEmpty.backupDir)).toEqual(["sous-backup-old.dump"]);
      expect(readdirSync(hEmpty.tmpDir)).toEqual([]);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    "BACKUP-7: retention pruning removes only top-level regular sous-*.dump files older than SOUS_BACKUP_KEEP_DAYS",
    async () => {
      const h = createHarness();
      mkdirSync(h.backupDir, { recursive: true });

      const expired1 = path.join(h.backupDir, "sous-backup-20260101T000000Z.dump");
      const expired2 = path.join(h.backupDir, "sous-abc1234-20260102T000000Z.dump");
      const keepRecent = path.join(h.backupDir, "sous-backup-recent.dump");
      const keepBoundary = path.join(h.backupDir, "sous-backup-boundary.dump");
      const keepOtherName = path.join(h.backupDir, "manual-backup.dump");
      const keepOtherExt = path.join(h.backupDir, "sous-backup-notes.txt");
      const keepDir = path.join(h.backupDir, "sous-dir.dump");
      const nestedDir = path.join(h.backupDir, "archive");
      const keepNested = path.join(nestedDir, "sous-backup-nested.dump");
      const symlinkTarget = path.join(h.rootDir, "external-keep.dump");
      const keepSymlink = path.join(h.backupDir, "sous-symlink.dump");

      writeFileSync(expired1, "old1", "utf8");
      writeFileSync(expired2, "old2", "utf8");
      writeFileSync(keepRecent, "recent", "utf8");
      writeFileSync(keepBoundary, "boundary", "utf8");
      writeFileSync(keepOtherName, "other", "utf8");
      writeFileSync(keepOtherExt, "notes", "utf8");
      mkdirSync(keepDir);
      mkdirSync(nestedDir);
      writeFileSync(keepNested, "nested", "utf8");
      writeFileSync(symlinkTarget, "symlink-target", "utf8");
      symlinkSync(symlinkTarget, keepSymlink);

      setAgeDays(expired1, 15);
      setAgeDays(expired2, 14.05);
      setAgeDays(keepRecent, 1);
      setAgeDays(keepBoundary, 13.95);
      setAgeDays(keepOtherName, 30);
      setAgeDays(keepOtherExt, 30);
      setAgeDays(keepDir, 30);
      setAgeDays(keepNested, 30);
      setAgeDays(symlinkTarget, 30);
      const oldDate = new Date(Date.now() - 30 * 86_400 * 1000);
      lutimesSync(keepSymlink, oldDate, oldDate);

      const res = await runBackup(h, [], {
        SOUS_BACKUP_KEEP_DAYS: "14",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Pruned 2 old backup(s) older than 14 day(s)");

      expect(existsSync(expired1)).toBe(false);
      expect(existsSync(expired2)).toBe(false);

      expect(existsSync(keepRecent)).toBe(true);
      expect(existsSync(keepBoundary)).toBe(true);
      expect(existsSync(keepOtherName)).toBe(true);
      expect(existsSync(keepOtherExt)).toBe(true);
      expect(lstatSync(keepDir).isDirectory()).toBe(true);
      expect(existsSync(keepNested)).toBe(true);
      expect(lstatSync(keepSymlink).isSymbolicLink()).toBe(true);
      expect(existsSync(symlinkTarget)).toBe(true);

      const newDumps = readdirSync(h.backupDir).filter(
        (f) => f.startsWith("sous-backup-20") && f.endsWith(".dump"),
      );
      expect(newDumps).toHaveLength(1);
      expect(statSync(path.join(h.backupDir, newDumps[0]!)).size).toBeGreaterThan(0);
    },
    SCRIPT_TIMEOUT_MS,
  );
});
