import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../..");
const DEPLOY_SCRIPT_SRC = path.join(REPO_ROOT, "scripts/deploy.sh");
const RELEASE_CHECK_SCRIPT_SRC = path.join(
  REPO_ROOT,
  "scripts/release-check.sh",
);
const DB_UP_SCRIPT_SRC = path.join(REPO_ROOT, "app/e2e/db-up.sh");
const REAL_RUN_TIMEOUT_MS = 30_000;

interface VersionServer {
  url: string;
  port: number;
  commitFile: string;
  receivedHeaders: http.IncomingHttpHeaders[];
  setCommit: (commit: string | null) => void;
  close: () => Promise<void>;
}

function writeCommitFile(filePath: string, commit: string | null): void {
  writeFileSync(filePath, commit === null ? "NULL\n" : `${commit}\n`, "utf8");
}

function readCommitFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw || raw === "NULL") {
    return null;
  }
  return raw;
}

async function startVersionServer(
  commitFile: string,
  initialCommit: string | null,
): Promise<VersionServer> {
  writeCommitFile(commitFile, initialCommit);
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/api/version") {
      receivedHeaders.push({ ...req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commit: readCommitFile(commitFile) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    commitFile,
    receivedHeaders,
    setCommit(commit: string | null) {
      writeCommitFile(commitFile, commit);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function generateSelfSignedCert(certDir: string): {
  certPath: string;
  keyPath: string;
} {
  mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, "staged.key.pem");
  const certPath = path.join(certDir, "staged.cert.pem");
  const cnfPath = path.join(certDir, "openssl.cnf");
  writeFileSync(
    cnfPath,
    [
      "[req]",
      "distinguished_name = req_distinguished_name",
      "x509_extensions = v3_req",
      "prompt = no",
      "[req_distinguished_name]",
      "CN = staged.example.com",
      "[v3_req]",
      "subjectAltName = DNS:staged.example.com",
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-config",
      cnfPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return { certPath, keyPath };
}

async function startStagedHttpsServer(
  harness: TestHarness,
  initialCommit: string | null,
): Promise<VersionServer> {
  const { certPath, keyPath } = generateSelfSignedCert(
    path.join(harness.rootDir, "certs"),
  );
  writeCommitFile(harness.stagedVersionFile, initialCommit);
  const receivedHeaders: http.IncomingHttpHeaders[] = [];

  const server = https.createServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    (req, res) => {
      if (req.url === "/api/version") {
        receivedHeaders.push({ ...req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ commit: readCommitFile(harness.stagedVersionFile) }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  // curl reads $HOME/.curlrc; runDeploy sets HOME to harness.rootDir.
  writeFileSync(
    path.join(harness.rootDir, ".curlrc"),
    [
      `cacert = ${certPath}`,
      `connect-to = staged.example.com:443:127.0.0.1:${addr.port}`,
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    url: "https://staged.example.com",
    port: addr.port,
    commitFile: harness.stagedVersionFile,
    receivedHeaders,
    setCommit(commit: string | null) {
      writeCommitFile(harness.stagedVersionFile, commit);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test Operator",
      "-c",
      "user.email=operator@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

interface HostMetaEntry {
  subcmd: string;
  pwd: string;
  head: string;
}

interface TestHarness {
  rootDir: string;
  repoDir: string;
  originDir: string;
  stateDir: string;
  binDir: string;
  backupDir: string;
  tmpDir: string;
  callLogFile: string;
  hostMetaLogFile: string;
  pgDumpEnvLogFile: string;
  pgDumpArgsLogFile: string;
  liveVersionFile: string;
  stagedVersionFile: string;
  emptyDumpMarker: string;
  pgDumpFailMarker: string;
  migrateFailMarker: string;
  smokeFailUrlMarker: string;
  hostNoUrlMarker: string;
  hostStdoutFile: string;
  keepStagedCommitMarker: string;
  promoteFailMarker: string;
  promoteNoSwitchMarker: string;
  hostLinkFile: string;
  deployEnvFile: string;
  passLogFile: string;
  releasesLogFile: string;
  lockDir: string;
  commit1: string;
  commit2: string;
}

function createHarness(): TestHarness {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "sous-deploy-test-"));
  const repoDir = path.join(rootDir, "repo");
  const originDir = path.join(rootDir, "origin.git");
  const stateDir = path.join(rootDir, "state");
  const binDir = path.join(rootDir, "bin");
  const backupDir = path.join(rootDir, "backups");
  const tmpDir = path.join(rootDir, "tmp");
  const callLogFile = path.join(rootDir, "calls.log");
  const hostMetaLogFile = path.join(rootDir, "host-meta.log");
  const pgDumpEnvLogFile = path.join(rootDir, "pg-dump-env.log");
  const pgDumpArgsLogFile = path.join(rootDir, "pg-dump-args.log");
  const liveVersionFile = path.join(rootDir, "live-version.txt");
  const stagedVersionFile = path.join(rootDir, "staged-version.txt");
  const emptyDumpMarker = path.join(rootDir, "empty-dump.marker");
  const pgDumpFailMarker = path.join(rootDir, "pg-dump-fail.marker");
  const migrateFailMarker = path.join(rootDir, "migrate-fail.marker");
  const smokeFailUrlMarker = path.join(rootDir, "smoke-fail-url.marker");
  const hostNoUrlMarker = path.join(rootDir, "host-no-url.marker");
  const hostStdoutFile = path.join(rootDir, "host-stdout.txt");
  const keepStagedCommitMarker = path.join(rootDir, "keep-staged.marker");
  const promoteFailMarker = path.join(rootDir, "promote-fail.marker");
  const promoteNoSwitchMarker = path.join(rootDir, "promote-no-switch.marker");
  const hostLinkFile = path.join(rootDir, "project.json");
  const deployEnvFile = path.join(rootDir, "deploy.env");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(originDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  mkdirSync(path.join(repoDir, "app/drizzle/migrations/meta"), {
    recursive: true,
  });

  copyFileSync(DEPLOY_SCRIPT_SRC, path.join(repoDir, "scripts/deploy.sh"));
  chmodSync(path.join(repoDir, "scripts/deploy.sh"), 0o755);
  copyFileSync(
    RELEASE_CHECK_SCRIPT_SRC,
    path.join(repoDir, "scripts/release-check.sh"),
  );
  chmodSync(path.join(repoDir, "scripts/release-check.sh"), 0o755);

  // Stand-in host CLI that logs calls, records PWD and HEAD, updates staged and
  // live version files, and honours test failure markers.
  const fakeHostPath = path.join(binDir, "fake-host");
  writeFileSync(
    fakeHostPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      `printf 'fake-host %s\\n' "$*" >> "${callLogFile}"`,
      'subcmd="${1:-}"',
      'cur_pwd="$(pwd -P)"',
      'cur_head="$(git rev-parse HEAD 2>/dev/null || printf none)"',
      `printf '%s\\t%s\\t%s\\n' "\${subcmd}" "\${cur_pwd}" "\${cur_head}" >> "${hostMetaLogFile}"`,
      'if [ "${subcmd}" = "deploy" ]; then',
      '  build_commit=""',
      '  prev=""',
      '  for arg in "$@"; do',
      '    if [ "${prev}" = "--build-env" ]; then',
      '      case "${arg}" in',
      '        SOUS_RELEASE_COMMIT=*) build_commit="${arg#SOUS_RELEASE_COMMIT=}" ;;',
      "      esac",
      '      prev=""',
      '    elif [ "${arg}" = "--build-env" ]; then',
      '      prev="--build-env"',
      "    fi",
      "  done",
      `  if [ ! -e "${keepStagedCommitMarker}" ] && [ -n "\${build_commit}" ]; then`,
      `    printf '%s\\n' "\${build_commit}" > "${stagedVersionFile}"`,
      "  fi",
      `  if [ -e "${hostNoUrlMarker}" ]; then`,
      '    printf "Build finished with no deployment URL\\n"',
      `  elif [ -f "${hostStdoutFile}" ]; then`,
      `    cat "${hostStdoutFile}"`,
      "  else",
      '    printf "%s\\n" "https://staged.example.com"',
      "  fi",
      'elif [ "${subcmd}" = "promote" ]; then',
      `  if [ -e "${promoteFailMarker}" ]; then`,
      '    printf "simulated host promote failure\\n" >&2',
      "    exit 1",
      "  fi",
      `  if [ ! -e "${promoteNoSwitchMarker}" ] && [ -f "${stagedVersionFile}" ]; then`,
      `    cp "${stagedVersionFile}" "${liveVersionFile}"`,
      "  fi",
      "fi",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeHostPath, 0o755);

  // Stand-in pnpm using perl so the inherited environment is recorded without
  // extra shell-injected variables.
  const fakePnpmPath = path.join(binDir, "pnpm");
  writeFileSync(
    fakePnpmPath,
    [
      "#!/usr/bin/env perl",
      "use strict;",
      "use warnings;",
      `my $log_file = ${JSON.stringify(callLogFile)};`,
      `my $migrate_fail = ${JSON.stringify(migrateFailMarker)};`,
      `my $smoke_fail = ${JSON.stringify(smokeFailUrlMarker)};`,
      'my @env_names = sort grep { $_ ne "PATH" && $_ ne "HOME" } keys %ENV;',
      'my $smoke_url = defined $ENV{SMOKE_BASE_URL} ? $ENV{SMOKE_BASE_URL} : "";',
      'my $smoke_commit = defined $ENV{SMOKE_EXPECT_COMMIT} ? $ENV{SMOKE_EXPECT_COMMIT} : "";',
      'my $smoke_sign_in = defined $ENV{SMOKE_EXPECT_SIGN_IN} ? $ENV{SMOKE_EXPECT_SIGN_IN} : "";',
      'open(my $fh, ">>", $log_file) or die "cannot open call log: $!";',
      'print $fh "pnpm " . join(" ", @ARGV) . " | env=" . join(",", @env_names) . " | SMOKE_BASE_URL=" . $smoke_url . " | SMOKE_EXPECT_COMMIT=" . $smoke_commit . " | SMOKE_EXPECT_SIGN_IN=" . $smoke_sign_in . "\\n";',
      "close($fh);",
      'my $cmd = "";',
      "for (my $i = 0; $i < scalar(@ARGV); $i++) {",
      '  if ($ARGV[$i] eq "--dir") { $i++; next; }',
      "  $cmd = $ARGV[$i];",
      "  last;",
      "}",
      'if ($cmd eq "install") { exit 0; }',
      'if ($cmd eq "db:migrate") {',
      "  if (-e $migrate_fail) {",
      '    print STDERR "simulated db:migrate failure\\n";',
      "    exit 1;",
      "  }",
      "  exit 0;",
      "}",
      'if ($cmd eq "e2e:smoke") {',
      "  if (-e $smoke_fail) {",
      '    open(my $sfh, "<", $smoke_fail) or die "cannot read smoke marker: $!";',
      "    my $fail_url = <$sfh>;",
      "    close($sfh);",
      '    $fail_url = "" unless defined $fail_url;',
      "    $fail_url =~ s/\\r?\\n\\z//;",
      "    if ($smoke_url eq $fail_url) {",
      '      print STDERR "simulated e2e:smoke failure for $smoke_url\\n";',
      "      exit 1;",
      "    }",
      "  }",
      "  exit 0;",
      "}",
      'print STDERR "fake pnpm: unexpected command: " . join(" ", @ARGV) . "\\n";',
      "exit 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePnpmPath, 0o755);

  // Stand-in pg_dump that records its full argument list and PG* env names.
  const fakePgDumpPath = path.join(binDir, "pg_dump");
  writeFileSync(
    fakePgDumpPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      `printf 'pg_dump %s\\n' "$*" >> "${callLogFile}"`,
      'pg_vars="$(env | awk -F= \'/^PG/ { print $1 }\' | sort | paste -sd, -)"',
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

  writeFileSync(
    hostLinkFile,
    JSON.stringify({ projectId: "prj_test", orgId: "org_test" }),
    "utf8",
  );
  const deployDbUrl = new URL(
    "postgres://db.example.com:5432/sous?sslmode=require",
  );
  deployDbUrl.username = "deployuser";
  deployDbUrl.password = "secretpass";
  writeFileSync(
    deployEnvFile,
    `DATABASE_URL=${deployDbUrl.toString()}\n`,
    "utf8",
  );

  git(originDir, ["init", "--bare", "-b", "main"]);
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["remote", "add", "origin", originDir]);

  writeFileSync(path.join(repoDir, "README.md"), "release test repo\n", "utf8");
  writeFileSync(
    path.join(repoDir, "app/drizzle/migrations/0000_init.sql"),
    "CREATE TABLE items (id text PRIMARY KEY);\n",
    "utf8",
  );
  writeFileSync(
    path.join(repoDir, "app/drizzle/migrations/meta/_journal.json"),
    JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1700000000000,
            tag: "0000_init",
            breakpoints: true,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial commit"]);
  const commit1 = git(repoDir, ["rev-parse", "HEAD"]);

  writeFileSync(path.join(repoDir, "README.md"), "second commit\n", "utf8");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "second commit"]);
  const commit2 = git(repoDir, ["rev-parse", "HEAD"]);

  git(repoDir, ["push", "-u", "origin", "main"]);

  return {
    rootDir,
    repoDir,
    originDir,
    stateDir,
    binDir,
    backupDir,
    tmpDir,
    callLogFile,
    hostMetaLogFile,
    pgDumpEnvLogFile,
    pgDumpArgsLogFile,
    liveVersionFile,
    stagedVersionFile,
    emptyDumpMarker,
    pgDumpFailMarker,
    migrateFailMarker,
    smokeFailUrlMarker,
    hostNoUrlMarker,
    hostStdoutFile,
    keepStagedCommitMarker,
    promoteFailMarker,
    promoteNoSwitchMarker,
    hostLinkFile,
    deployEnvFile,
    passLogFile: path.join(stateDir, "release-passes.log"),
    releasesLogFile: path.join(stateDir, "releases.log"),
    lockDir: path.join(stateDir, "deploy.lock"),
    commit1,
    commit2,
  };
}

function readCallLog(harness: TestHarness): string[] {
  if (!existsSync(harness.callLogFile)) {
    return [];
  }
  return readFileSync(harness.callLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readHostMeta(harness: TestHarness): HostMetaEntry[] {
  if (!existsSync(harness.hostMetaLogFile)) {
    return [];
  }
  return readFileSync(harness.hostMetaLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [subcmd = "", pwd = "", head = ""] = line.split("\t");
      return { subcmd, pwd, head };
    });
}

function readPgDumpEnvLog(harness: TestHarness): string[][] {
  if (!existsSync(harness.pgDumpEnvLogFile)) {
    return [];
  }
  return readFileSync(harness.pgDumpEnvLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(",").filter((name) => name.length > 0));
}

function readPgDumpArgsLog(harness: TestHarness): string[][] {
  if (!existsSync(harness.pgDumpArgsLogFile)) {
    return [];
  }
  return readFileSync(harness.pgDumpArgsLogFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

function hostCalls(harness: TestHarness): string[] {
  return readCallLog(harness).filter((line) => line.startsWith("fake-host "));
}

function recordPass(harness: TestHarness, sha: string): void {
  writeFileSync(
    harness.passLogFile,
    `${sha} 2026-03-10T11:00:00Z e2e=36/0 visual=10/0\n`,
    { flag: "a", encoding: "utf8" },
  );
}

function recordRelease(
  harness: TestHarness,
  num: number,
  sha: string,
  stagedUrl = "https://prev.example.com",
): void {
  writeFileSync(
    harness.releasesLogFile,
    `${num} ${sha} ${stagedUrl} 2026-03-10T10:00:00Z\n`,
    { flag: "a", encoding: "utf8" },
  );
}

function commitAndPushNewMigration(harness: TestHarness): string {
  writeFileSync(
    path.join(harness.repoDir, "app/drizzle/migrations/0001_add_notes.sql"),
    "ALTER TABLE items ADD COLUMN notes text;\n",
    "utf8",
  );
  writeFileSync(
    path.join(harness.repoDir, "app/drizzle/migrations/meta/_journal.json"),
    JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1700000000000,
            tag: "0000_init",
            breakpoints: true,
          },
          {
            idx: 1,
            version: "7",
            when: 1700000001000,
            tag: "0001_add_notes",
            breakpoints: true,
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  git(harness.repoDir, [
    "add",
    "app/drizzle/migrations/0001_add_notes.sql",
    "app/drizzle/migrations/meta/_journal.json",
  ]);
  git(harness.repoDir, ["commit", "-m", "add new migration"]);
  const sha = git(harness.repoDir, ["rev-parse", "HEAD"]);
  git(harness.repoDir, ["push", "origin", "main"]);
  return sha;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runDeploy(
  harness: TestHarness,
  args: readonly string[],
  envOverrides: Record<string, string | undefined>,
  bashFlags: readonly string[] = [],
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
    HOME: harness.rootDir,
    TMPDIR: harness.tmpDir,
    SOUS_RELEASE_STATE_DIR: harness.stateDir,
    SOUS_HOST_CLI: "fake-host",
    SOUS_HOST_LINK_FILE: harness.hostLinkFile,
    SOUS_EXPECT_SIGN_IN: "on",
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("bash", [...bashFlags, "scripts/deploy.sh", ...args], {
      cwd: harness.repoDir,
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

interface ReleaseCheckHarness {
  rootDir: string;
  repoDir: string;
  stateDir: string;
  binDir: string;
  tmpDir: string;
  realNodePath: string;
  callLogFile: string;
  pnpmOwnerLogFile: string;
  dockerEnvLogFile: string;
  failStepMarker: string;
  visualUnexpectedMarker: string;
  dockerExistsMarker: string;
  dockerOwnerFile: string;
  createDockerOnStepMarker: string;
  dockerOwnerOnStepMarker: string;
  passLogFile: string;
  commit1: string;
}

function createReleaseCheckHarness(): ReleaseCheckHarness {
  const realNodePath = process.execPath;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "sous-rcheck-test-"));
  const repoDir = path.join(rootDir, "repo");
  const stateDir = path.join(rootDir, "state");
  const binDir = path.join(rootDir, "bin");
  const tmpDir = path.join(rootDir, "tmp");
  const callLogFile = path.join(rootDir, "calls.log");
  const pnpmOwnerLogFile = path.join(rootDir, "pnpm-owner.log");
  const dockerEnvLogFile = path.join(rootDir, "docker-env.log");
  const failStepMarker = path.join(rootDir, "fail-step.marker");
  const visualUnexpectedMarker = path.join(rootDir, "visual-unexpected.marker");
  const dockerExistsMarker = path.join(rootDir, "docker-exists.marker");
  const dockerOwnerFile = path.join(rootDir, "docker-owner.txt");
  const createDockerOnStepMarker = path.join(
    rootDir,
    "create-docker-on-step.marker",
  );
  const dockerOwnerOnStepMarker = path.join(
    rootDir,
    "docker-owner-on-step.marker",
  );

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  mkdirSync(path.join(repoDir, "app/drizzle"), { recursive: true });
  mkdirSync(path.join(repoDir, "pack"), { recursive: true });

  copyFileSync(
    RELEASE_CHECK_SCRIPT_SRC,
    path.join(repoDir, "scripts/release-check.sh"),
  );
  chmodSync(path.join(repoDir, "scripts/release-check.sh"), 0o755);

  const fakePnpmPath = path.join(binDir, "pnpm");
  writeFileSync(
    fakePnpmPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      `printf 'pnpm %s | CI=%s\\n' "$*" "\${CI:-}" >> "${callLogFile}"`,
      `printf 'pnpm %s | E2E_PG_OWNER=%s\\n' "$*" "\${E2E_PG_OWNER-<unset>}" >> "${pnpmOwnerLogFile}"`,
      'dir_arg=""',
      'cmd=""',
      'next_is_dir=0',
      'for arg in "$@"; do',
      '  if [ "${next_is_dir}" -eq 1 ]; then',
      '    dir_arg="${arg}"',
      "    next_is_dir=0",
      '  elif [ "${arg}" = "--dir" ]; then',
      "    next_is_dir=1",
      '  elif [ -z "${cmd}" ]; then',
      '    cmd="${arg}"',
      "  fi",
      "done",
      `if [ -f "${createDockerOnStepMarker}" ]; then`,
      `  appear_cmd="$(cat "${createDockerOnStepMarker}")"`,
      '  if [ "${cmd}" = "${appear_cmd}" ]; then',
      `    printf "1\\n" > "${dockerExistsMarker}"`,
      `    if [ -f "${dockerOwnerOnStepMarker}" ]; then`,
      `      cp "${dockerOwnerOnStepMarker}" "${dockerOwnerFile}"`,
      "    fi",
      "  fi",
      "fi",
      'if [ "${cmd}" = "e2e:db:up" ]; then',
      `  if [ ! -e "${dockerExistsMarker}" ]; then`,
      `    printf "1\\n" > "${dockerExistsMarker}"`,
      '    if [ -n "${E2E_PG_OWNER:-}" ]; then',
      `      printf '%s\\n' "\${E2E_PG_OWNER}" > "${dockerOwnerFile}"`,
      "    fi",
      "  fi",
      "fi",
      'if [ "${cmd}" = "e2e:db:down" ]; then',
      `  rm -f "${dockerExistsMarker}" "${dockerOwnerFile}"`,
      "fi",
      `if [ -f "${failStepMarker}" ]; then`,
      `  fail_cmd="$(cat "${failStepMarker}")"`,
      '  if [ "${cmd}" = "${fail_cmd}" ]; then',
      '    printf "simulated failure in %s\\n" "${cmd}" >&2',
      "    exit 1",
      "  fi",
      "fi",
      'if [ "${cmd}" = "e2e" ] && [ -n "${PLAYWRIGHT_JSON_OUTPUT_NAME:-}" ]; then',
      '  printf \'{"stats":{"expected":3,"unexpected":0,"flaky":0},"errors":[]}\\n\' > "${PLAYWRIGHT_JSON_OUTPUT_NAME}"',
      "fi",
      'if [ "${cmd}" = "e2e:visual" ] && [ -n "${PLAYWRIGHT_JSON_OUTPUT_NAME:-}" ]; then',
      `  if [ -e "${visualUnexpectedMarker}" ]; then`,
      '    printf \'{"stats":{"expected":2,"unexpected":1,"flaky":0},"errors":[]}\\n\' > "${PLAYWRIGHT_JSON_OUTPUT_NAME}"',
      "  else",
      '    printf \'{"stats":{"expected":2,"unexpected":0,"flaky":0},"errors":[]}\\n\' > "${PLAYWRIGHT_JSON_OUTPUT_NAME}"',
      "  fi",
      "fi",
      'if [ -n "${dir_arg}" ]; then :; fi',
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakePnpmPath, 0o755);

  const fakeDockerPath = path.join(binDir, "docker");
  writeFileSync(
    fakeDockerPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      `printf 'docker %s\\n' "$*" >> "${callLogFile}"`,
      `printf 'DOCKER_HOST=%s | DOCKER_CONTEXT=%s\\n' "\${DOCKER_HOST-<unset>}" "\${DOCKER_CONTEXT-<unset>}" >> "${dockerEnvLogFile}"`,
      'subcmd="${1:-}"',
      'if [ "${subcmd}" = "container" ] && [ "${2:-}" = "inspect" ]; then',
      "  shift 2",
      '  fmt=""',
      '  target=""',
      '  while [ "$#" -gt 0 ]; do',
      '    case "$1" in',
      "      --format|-f)",
      '        fmt="${2:-}"',
      "        shift 2",
      "        ;;",
      "      --format=*)",
      '        fmt="${1#--format=}"',
      "        shift",
      "        ;;",
      "      *)",
      '        target="$1"',
      "        shift",
      "        ;;",
      "    esac",
      "  done",
      `  if [ -e "${dockerExistsMarker}" ]; then`,
      '    if [ -n "${fmt}" ]; then',
      `      if [ -f "${dockerOwnerFile}" ]; then`,
      `        cat "${dockerOwnerFile}"`,
      "      else",
      '        printf "\\n"',
      "      fi",
      "    else",
      '      printf \'[{"Name":"/%s"}]\\n\' "${target}"',
      "    fi",
      "    exit 0",
      "  fi",
      '  printf \'Error: No such container: %s\\n\' "${target}" >&2',
      "  exit 1",
      "fi",
      'if [ "${subcmd}" = "inspect" ]; then',
      `  if [ -e "${dockerExistsMarker}" ]; then`,
      '    printf \'[{"Name":"/%s"}]\\n\' "${2:-}"',
      "    exit 0",
      "  fi",
      '  printf \'Error: No such object: %s\\n\' "${2:-}" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeDockerPath, 0o755);

  git(repoDir, ["init", "-b", "main"]);
  writeFileSync(path.join(repoDir, "README.md"), "release check repo\n", "utf8");
  writeFileSync(
    path.join(repoDir, "app/drizzle/schema.ts"),
    "export const version = 1;\n",
    "utf8",
  );
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial commit"]);
  const commit1 = git(repoDir, ["rev-parse", "HEAD"]);

  return {
    rootDir,
    repoDir,
    stateDir,
    binDir,
    tmpDir,
    realNodePath,
    callLogFile,
    pnpmOwnerLogFile,
    dockerEnvLogFile,
    failStepMarker,
    visualUnexpectedMarker,
    dockerExistsMarker,
    dockerOwnerFile,
    createDockerOnStepMarker,
    dockerOwnerOnStepMarker,
    passLogFile: path.join(stateDir, "release-passes.log"),
    commit1,
  };
}

// No release-check test may depend on the machine's real ports (such as the
// default app port 4131), because another release check or browser suite run
// may be holding them while unit tests execute. Every release-check test that
// runs past the commit check either picks its own free ephemeral E2E_APP_PORT
// or, for the all-unset case of RCHECK-4, shims the port-4131 probe.
async function pickFreePort(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => (err ? reject(err) : resolve()));
  });
  return String(port);
}

function installDefaultPortProbeShim(harness: ReleaseCheckHarness): void {
  const nodeShimPath = path.join(harness.binDir, "node");
  writeFileSync(
    nodeShimPath,
    [
      "#!/usr/bin/env bash",
      "{ set +x; } 2>/dev/null",
      "set -euo pipefail",
      'if [ "$#" -eq 3 ] && [ "$1" = "-e" ] && [ "$3" = "4131" ] && [[ "$2" == *"net.createConnection({ host, port })"* ]] && [[ "$2" == *"function checkBind()"* ]]; then',
      `  printf 'node-port-probe-shim port=%s\\n' "$3" >> ${JSON.stringify(harness.callLogFile)}`,
      "  exit 0",
      "fi",
      `exec ${JSON.stringify(harness.realNodePath)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(nodeShimPath, 0o755);
}

function runReleaseCheck(
  harness: ReleaseCheckHarness,
  commitArg: string,
  envOverrides: Record<string, string | undefined>,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
    HOME: harness.rootDir,
    TMPDIR: harness.tmpDir,
    SOUS_RELEASE_STATE_DIR: harness.stateDir,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn("bash", ["scripts/release-check.sh", commitArg], {
      cwd: harness.repoDir,
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

describe("release scripts", () => {
  const cleanupDirs: string[] = [];
  const servers: VersionServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const srv = servers.pop()!;
      await srv.close();
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHarness(): TestHarness {
    const h = createHarness();
    cleanupDirs.push(h.rootDir);
    return h;
  }

  function makeReleaseCheckHarness(): ReleaseCheckHarness {
    const h = createReleaseCheckHarness();
    cleanupDirs.push(h.rootDir);
    return h;
  }

  async function makeLiveServer(
    harness: TestHarness,
    commit: string | null,
  ): Promise<VersionServer> {
    const srv = await startVersionServer(harness.liveVersionFile, commit);
    servers.push(srv);
    return srv;
  }

  async function makeStagedServer(
    harness: TestHarness,
    initialCommit: string | null = null,
  ): Promise<VersionServer> {
    const srv = await startStagedHttpsServer(harness, initialCommit);
    servers.push(srv);
    return srv;
  }

  it("DEPLOY-1: refuses commit without a recorded release-check pass (even when another commit passed) and never calls host CLI", async () => {
    const h = makeHarness();
    const srv = await makeLiveServer(h, h.commit1);
    recordRelease(h, 1, h.commit1);
    // Write a pass line for a different commit to verify exact commit matching.
    recordPass(h, h.commit1);

    const res = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("release-check.sh");
    expect(res.stderr).toContain(h.commit2);
    expect(hostCalls(h)).toEqual([]);
  });

  it("DEPLOY-2: refuses when live commit is missing from local repository or not an ancestor of target commit", async () => {
    const h = makeHarness();

    // Create a diverged branch commit that is not an ancestor of commit2.
    git(h.repoDir, ["checkout", "-b", "side", h.commit1]);
    writeFileSync(path.join(h.repoDir, "side.txt"), "diverged\n", "utf8");
    git(h.repoDir, ["add", "side.txt"]);
    git(h.repoDir, ["commit", "-m", "diverged branch commit"]);
    const divergedCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["checkout", "main"]);

    recordPass(h, h.commit2);
    recordRelease(h, 1, divergedCommit);
    const srv = await makeLiveServer(h, divergedCommit);

    const res = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("does not contain the live commit");
    expect(res.stderr).toContain(divergedCommit);
    expect(hostCalls(h)).toEqual([]);

    // When the live commit does not exist in this repository at all, say so
    // before the ancestry check.
    const missingCommit = "0123456789abcdef0123456789abcdef01234567";
    srv.setCommit(missingCommit);
    const missingRes = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });

    expect(missingRes.status).not.toBe(0);
    expect(missingRes.stderr).toContain(
      `the live commit ${missingCommit} is not in this repository; fetch it first`,
    );
    expect(missingRes.stderr).not.toContain("does not contain the live commit");
    expect(hostCalls(h)).toEqual([]);
  });

  it("DEPLOY-3: refuses unreachable or null live commit without suggesting --first-release, allows --first-release 7 on empty log, and refuses --first-release on non-empty log", async () => {
    const h = makeHarness();
    recordPass(h, h.commit2);
    const srv = await makeLiveServer(h, null);

    // Live site answering null: refused without suggesting --first-release.
    const refusedNull = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(refusedNull.status).not.toBe(0);
    expect(refusedNull.stderr).toContain("null");
    expect(refusedNull.stderr).not.toContain("--first-release");
    expect(hostCalls(h)).toEqual([]);

    // Live site unreachable: refused without suggesting --first-release.
    const refusedUnreachable = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: "http://127.0.0.1:1",
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(refusedUnreachable.status).not.toBe(0);
    expect(refusedUnreachable.stderr).toContain("failed to read");
    expect(refusedUnreachable.stderr).not.toContain("--first-release");
    expect(hostCalls(h)).toEqual([]);

    // --first-release 7 with empty log is allowed in dry run.
    const allowed = await runDeploy(
      h,
      ["--dry-run", "--first-release", "7", h.commit2],
      {
        SOUS_LIVE_URL: srv.url,
        SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
        SOUS_BACKUP_DIR: h.backupDir,
      },
    );
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("release 7");
    expect(allowed.stdout).toContain("dry run: nothing was changed");
    expect(hostCalls(h)).toEqual([]);
    expect(existsSync(h.releasesLogFile)).toBe(false);

    // --first-release with non-empty releases.log is refused.
    recordRelease(h, 1, h.commit1, "https://r1.example.com");
    const nonEmptyRefused = await runDeploy(
      h,
      ["--dry-run", "--first-release", "7", h.commit2],
      {
        SOUS_LIVE_URL: srv.url,
        SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
        SOUS_BACKUP_DIR: h.backupDir,
      },
    );
    expect(nonEmptyRefused.status).not.toBe(0);
    expect(nonEmptyRefused.stderr).toContain("--first-release");
    expect(nonEmptyRefused.stderr).toContain("not empty");
    expect(hostCalls(h)).toEqual([]);
  });

  it("DEPLOY-4: refuses modified migration or out-of-order journal timestamp, and dry-run prints backup/migrate for valid new migration", async () => {
    const h = makeHarness();
    const srv = await makeLiveServer(h, h.commit1);
    recordRelease(h, 1, h.commit1);

    // Case A: target modifies an existing migration file.
    git(h.repoDir, ["checkout", "-b", "bad-migration", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/0000_init.sql"),
      "CREATE TABLE items (id text PRIMARY KEY, name text);\n",
      "utf8",
    );
    git(h.repoDir, ["add", "app/drizzle/migrations/0000_init.sql"]);
    git(h.repoDir, ["commit", "-m", "modify existing migration"]);
    const badMigCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    recordPass(h, badMigCommit);

    const badRes = await runDeploy(h, ["--dry-run", badMigCommit], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(badRes.status).not.toBe(0);
    expect(badRes.stderr).toContain("append-only");
    expect(hostCalls(h)).toEqual([]);

    // Case B: target alters an existing entry in meta/_journal.json.
    git(h.repoDir, ["checkout", "-b", "bad-journal", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/meta/_journal.json"),
      JSON.stringify(
        {
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1700000000000,
              tag: "0000_renamed",
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    git(h.repoDir, ["add", "app/drizzle/migrations/meta/_journal.json"]);
    git(h.repoDir, ["commit", "-m", "alter existing journal entry"]);
    const badJournalCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    recordPass(h, badJournalCommit);

    const badJournalRes = await runDeploy(h, ["--dry-run", badJournalCommit], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(badJournalRes.status).not.toBe(0);
    expect(badJournalRes.stderr).toContain("append-only");
    expect(hostCalls(h)).toEqual([]);

    // Case C: target appends an entry whose timestamp is earlier than the last live entry.
    git(h.repoDir, ["checkout", "-b", "bad-journal-when", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/0001_old_ts.sql"),
      "ALTER TABLE items ADD COLUMN old_ts text;\n",
      "utf8",
    );
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/meta/_journal.json"),
      JSON.stringify(
        {
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1700000000000,
              tag: "0000_init",
              breakpoints: true,
            },
            {
              idx: 1,
              version: "7",
              when: 1699999999000,
              tag: "0001_old_ts",
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    git(h.repoDir, [
      "add",
      "app/drizzle/migrations/0001_old_ts.sql",
      "app/drizzle/migrations/meta/_journal.json",
    ]);
    git(h.repoDir, ["commit", "-m", "append migration with earlier timestamp"]);
    const badWhenCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    recordPass(h, badWhenCommit);

    const badWhenRes = await runDeploy(h, ["--dry-run", badWhenCommit], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(badWhenRes.status).not.toBe(0);
    expect(badWhenRes.stderr).toContain(
      "migration 0001_old_ts has a timestamp earlier than one already live; regenerate it",
    );
    expect(hostCalls(h)).toEqual([]);

    // Case D: target appends a new migration file and appends to _journal.json with increasing timestamp.
    git(h.repoDir, ["checkout", "-b", "good-migration", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/0001_add_notes.sql"),
      "ALTER TABLE items ADD COLUMN notes text;\n",
      "utf8",
    );
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/meta/_journal.json"),
      JSON.stringify(
        {
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1700000000000,
              tag: "0000_init",
              breakpoints: true,
            },
            {
              idx: 1,
              version: "7",
              when: 1700000001000,
              tag: "0001_add_notes",
              breakpoints: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    git(h.repoDir, [
      "add",
      "app/drizzle/migrations/0001_add_notes.sql",
      "app/drizzle/migrations/meta/_journal.json",
    ]);
    git(h.repoDir, ["commit", "-m", "add new migration"]);
    const goodMigCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    recordPass(h, goodMigCommit);

    const goodRes = await runDeploy(h, ["--dry-run", goodMigCommit], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });
    expect(goodRes.status).toBe(0);
    expect(goodRes.stdout).toContain("app/drizzle/migrations/0001_add_notes.sql");
    expect(goodRes.stdout).toContain("db.example.com:5432");
    expect(goodRes.stdout).not.toContain("secretpass");
    expect(goodRes.stdout).toContain(h.backupDir);
    expect(goodRes.stdout).toContain("pnpm --dir app db:migrate");
    expect(goodRes.stdout).toContain("dry run: nothing was changed");
    expect(readCallLog(h)).toEqual([]);
    if (existsSync(h.backupDir)) {
      expect(readdirSync(h.backupDir)).toEqual([]);
    }
  }, REAL_RUN_TIMEOUT_MS);

  it("DEPLOY-5: rollback line picks the most recent releases.log entry matching the live commit, or warns when none matches", async () => {
    const h = makeHarness();
    recordPass(h, h.commit2);
    // Release 4 was commit1 (currently live), release 5 was another commit (rolled back).
    recordRelease(h, 4, h.commit1, "https://r4.example.com");
    recordRelease(
      h,
      5,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "https://r5.example.com",
    );
    const beforeLog = readFileSync(h.releasesLogFile, "utf8");
    const srv = await makeLiveServer(h, h.commit1);

    const res = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("New migrations: none");
    expect(res.stdout).toContain("dry run: nothing was changed");
    expect(res.stdout).toContain("fake-host rollback https://r4.example.com --yes");
    expect(res.stdout).not.toContain("r5.example.com");
    expect(readCallLog(h)).toEqual([]);
    expect(readFileSync(h.releasesLogFile, "utf8")).toBe(beforeLog);

    // When no recorded release matches the live commit, say so and point to the host deployment list.
    const h2 = makeHarness();
    recordPass(h2, h2.commit2);
    recordRelease(
      h2,
      5,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "https://r5.example.com",
    );
    const srv2 = await makeLiveServer(h2, h2.commit1);

    const noMatchRes = await runDeploy(h2, ["--dry-run", h2.commit2], {
      SOUS_LIVE_URL: srv2.url,
    });
    expect(noMatchRes.status).toBe(0);
    expect(noMatchRes.stdout).toContain("no recorded release matches the live commit");
    expect(noMatchRes.stdout).toContain("host's own deployment list");
    expect(noMatchRes.stdout).not.toContain("r5.example.com");
  });

  it("DEPLOY-6: refuses when required variables are missing or SOUS_HOST_ARGS has a newline or DATABASE_URL has a fragment", async () => {
    const h = makeHarness();
    // Deliberately omit pass log and server to verify missing env vars fail first.
    const res = await runDeploy(h, ["--dry-run", "not-even-resolved"], {
      SOUS_LIVE_URL: undefined,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("SOUS_LIVE_URL");
    expect(res.stderr).not.toContain("release-check.sh");
    expect(hostCalls(h)).toEqual([]);

    // When multiple required variables are missing, all are reported together.
    const bothMissing = await runDeploy(h, ["--dry-run", "not-even-resolved"], {
      SOUS_LIVE_URL: undefined,
      SOUS_HOST_LINK_FILE: undefined,
    });
    expect(bothMissing.status).not.toBe(0);
    expect(bothMissing.stderr).toContain("SOUS_LIVE_URL");
    expect(bothMissing.stderr).toContain("SOUS_HOST_LINK_FILE");
    expect(hostCalls(h)).toEqual([]);

    // A newline in SOUS_HOST_ARGS is refused with a plain message.
    const newlineArgs = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: "http://127.0.0.1:1",
      SOUS_HOST_ARGS: "--scope example-team\n--extra-flag",
    });
    expect(newlineArgs.status).not.toBe(0);
    expect(newlineArgs.stderr).toContain("SOUS_HOST_ARGS");
    expect(newlineArgs.stderr).toContain("newline");
    expect(hostCalls(h)).toEqual([]);

    // A DATABASE_URL containing a # fragment is refused without printing any part of the URL.
    const h2 = makeHarness();
    const migCommit = commitAndPushNewMigration(h2);
    recordPass(h2, migCommit);
    recordRelease(h2, 1, h2.commit1);
    const srv2 = await makeLiveServer(h2, h2.commit1);
    const badEnvFile = path.join(h2.rootDir, "bad-deploy.env");
    const badDbUrl = new URL("postgres://db.example.com:5432/sous");
    badDbUrl.username = "deployuser";
    badDbUrl.password = "secretfrag";
    badDbUrl.hash = "frag";
    writeFileSync(badEnvFile, `DATABASE_URL=${badDbUrl.toString()}\n`, "utf8");
    const badUrlRes = await runDeploy(h2, ["--dry-run", migCommit], {
      SOUS_LIVE_URL: srv2.url,
      SOUS_DEPLOY_ENV_FILE: badEnvFile,
      SOUS_BACKUP_DIR: h2.backupDir,
    });
    expect(badUrlRes.status).not.toBe(0);
    expect(badUrlRes.stderr).toContain("#");
    expect(badUrlRes.stderr).not.toContain("secretfrag");
    expect(badUrlRes.stderr).not.toContain("db.example.com");
    expect(badUrlRes.stdout).not.toContain("secretfrag");
    expect(hostCalls(h2)).toEqual([]);
  });

  it("DEPLOY-7: refuses when deploy lock folder already exists and names it", async () => {
    const h = makeHarness();
    recordPass(h, h.commit2);
    recordRelease(h, 1, h.commit1);
    mkdirSync(h.lockDir);
    const srv = await makeLiveServer(h, h.commit1);

    const res = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(h.lockDir);
    expect(existsSync(h.lockDir)).toBe(true);
    expect(hostCalls(h)).toEqual([]);
  });

  it("DEPLOY-8: refuses an unpushed commit in both dry run and real run without calling host", async () => {
    const h = makeHarness();
    writeFileSync(path.join(h.repoDir, "README.md"), "local only commit\n", "utf8");
    git(h.repoDir, ["add", "README.md"]);
    git(h.repoDir, ["commit", "-m", "unpushed local commit"]);
    const unpushedCommit = git(h.repoDir, ["rev-parse", "HEAD"]);

    recordPass(h, unpushedCommit);
    recordRelease(h, 1, h.commit1);
    const srv = await makeLiveServer(h, h.commit1);

    const dryRes = await runDeploy(h, ["--dry-run", unpushedCommit], {
      SOUS_LIVE_URL: srv.url,
    });
    expect(dryRes.status).not.toBe(0);
    expect(dryRes.stderr).toContain(
      `${unpushedCommit} is not on origin/main; push it first`,
    );
    expect(hostCalls(h)).toEqual([]);

    const realRes = await runDeploy(h, [unpushedCommit], {
      SOUS_LIVE_URL: srv.url,
    });
    expect(realRes.status).not.toBe(0);
    expect(realRes.stderr).toContain(
      `${unpushedCommit} is not on origin/main; push it first`,
    );
    expect(readCallLog(h)).toEqual([]);
    expect(existsSync(h.lockDir)).toBe(false);

    // Fetch failure produces a plain error message without calling host.
    recordPass(h, h.commit2);
    const badRemoteRes = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
      SOUS_RELEASE_REMOTE: "missing-remote",
    });
    expect(badRemoteRes.status).not.toBe(0);
    expect(badRemoteRes.stderr).toContain("failed to fetch missing-remote/main");
    expect(hostCalls(h)).toEqual([]);
  }, REAL_RUN_TIMEOUT_MS);

  it("DEPLOY-9: refuses a modified tracked file before other steps, while allowing an untracked file alone", async () => {
    const h = makeHarness();
    writeFileSync(path.join(h.repoDir, "README.md"), "dirty tracked edit\n", "utf8");

    // Deliberately omit pass log and use an unresolvable commit to verify
    // the clean-tree check runs before reading repository history.
    const realDirty = await runDeploy(h, ["not-even-resolved"], {
      SOUS_LIVE_URL: "http://127.0.0.1:1",
    });
    expect(realDirty.status).not.toBe(0);
    expect(realDirty.stderr).toContain(
      "the working tree has uncommitted changes to tracked files; commit or stash them first",
    );
    expect(realDirty.stderr).not.toContain("unknown commit");
    expect(realDirty.stderr).not.toContain("release-check.sh");
    expect(readCallLog(h)).toEqual([]);

    const dryDirty = await runDeploy(h, ["--dry-run", "not-even-resolved"], {
      SOUS_LIVE_URL: "http://127.0.0.1:1",
    });
    expect(dryDirty.status).not.toBe(0);
    expect(dryDirty.stderr).toContain(
      "the working tree has uncommitted changes to tracked files; commit or stash them first",
    );
    expect(readCallLog(h)).toEqual([]);

    // Restore the tracked file and add only an untracked file: dry run succeeds.
    git(h.repoDir, ["checkout", "--", "README.md"]);
    writeFileSync(path.join(h.repoDir, "scratch-notes.txt"), "untracked\n", "utf8");

    recordPass(h, h.commit2);
    recordRelease(h, 1, h.commit1);
    const srv = await makeLiveServer(h, h.commit1);

    const untrackedRes = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
    });
    expect(untrackedRes.status).toBe(0);
    expect(untrackedRes.stdout).toContain("dry run: nothing was changed");
    expect(readCallLog(h)).toEqual([]);
  }, REAL_RUN_TIMEOUT_MS);

  it(
    "DEPLOY-10: real run stages in detached worktree, checks staged and live versions, smokes both with SMOKE_EXPECT_COMMIT, records release, and cleans up",
    async () => {
      const h = makeHarness();
      // Keep the main repo checkout on commit1 so worktree HEAD === commit2 is proven.
      git(h.repoDir, ["checkout", h.commit1]);
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const liveSrv = await makeLiveServer(h, h.commit1);
      const stagedSrv = await makeStagedServer(h, h.commit1);

      const res = await runDeploy(h, [h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
        SMOKE_BYPASS_HEADER: "x-test-bypass",
        SMOKE_BYPASS_VALUE: "bypass-secret-val",
      });

      expect(res.status).toBe(0);

      const calls = readCallLog(h);
      expect(calls).toHaveLength(5);
      expect(calls[0]).toContain("pnpm --dir app install");
      expect(calls[1]).toBe(
        `fake-host deploy --prod --skip-domain --yes --build-env SOUS_RELEASE_COMMIT=${h.commit2}`,
      );
      expect(calls[2]).toContain("pnpm --dir app e2e:smoke");
      expect(calls[2]).toContain("SMOKE_BASE_URL=https://staged.example.com");
      expect(calls[2]).toContain(`SMOKE_EXPECT_COMMIT=${h.commit2}`);
      expect(calls[2]).toContain("SMOKE_EXPECT_SIGN_IN=on");
      expect(calls[3]).toBe("fake-host promote https://staged.example.com --yes");
      expect(calls[4]).toContain("pnpm --dir app e2e:smoke");
      expect(calls[4]).toContain(`SMOKE_BASE_URL=${liveSrv.url}`);
      expect(calls[4]).toContain(`SMOKE_EXPECT_COMMIT=${h.commit2}`);
      expect(calls[4]).toContain("SMOKE_EXPECT_SIGN_IN=on");

      // Both deploy and promote ran inside the detached worktree at the target sha.
      const repoRealPath = realpathSync(h.repoDir);
      const meta = readHostMeta(h);
      expect(meta).toHaveLength(2);
      expect(meta[0]?.subcmd).toBe("deploy");
      expect(meta[0]?.pwd).not.toBe(repoRealPath);
      expect(meta[0]?.head).toBe(h.commit2);
      expect(meta[1]?.subcmd).toBe("promote");
      expect(meta[1]?.pwd).not.toBe(repoRealPath);
      expect(meta[1]?.head).toBe(h.commit2);

      // Version requests sent the bypass header and no temp files were left behind.
      expect(stagedSrv.receivedHeaders.length).toBeGreaterThanOrEqual(1);
      expect(stagedSrv.receivedHeaders[0]?.["x-test-bypass"]).toBe(
        "bypass-secret-val",
      );
      expect(liveSrv.receivedHeaders.length).toBeGreaterThanOrEqual(2);
      expect(liveSrv.receivedHeaders[0]?.["x-test-bypass"]).toBe(
        "bypass-secret-val",
      );
      expect(readdirSync(h.tmpDir)).toEqual([]);

      const releaseLines = readFileSync(h.releasesLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(releaseLines).toHaveLength(2);
      expect(releaseLines[1]).toMatch(
        new RegExp(
          `^5 ${h.commit2} https://staged\\.example\\.com \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
        ),
      );

      const tail = res.stdout.slice(res.stdout.lastIndexOf("Rollback command:"));
      expect(tail).toContain("fake-host rollback https://previous.example.com --yes");

      expect(existsSync(h.lockDir)).toBe(false);
      const worktrees = git(h.repoDir, ["worktree", "list"])
        .split("\n")
        .filter((line) => line.length > 0);
      expect(worktrees).toHaveLength(1);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-11: staged version mismatch, missing staged URL, or staged smoke failure stops before promotion and leaves releases.log unchanged",
    async () => {
      // Case A: staged copy answers the old commit.
      const h1 = makeHarness();
      recordPass(h1, h1.commit2);
      recordRelease(h1, 4, h1.commit1, "https://previous.example.com");
      const beforeLog1 = readFileSync(h1.releasesLogFile, "utf8");
      const liveSrv1 = await makeLiveServer(h1, h1.commit1);
      await makeStagedServer(h1, h1.commit1);
      writeFileSync(h1.keepStagedCommitMarker, "1\n", "utf8");

      const mismatchRes = await runDeploy(h1, [h1.commit2], {
        SOUS_LIVE_URL: liveSrv1.url,
        SOUS_LIVE_WAIT_SECONDS: "1",
      });
      expect(mismatchRes.status).not.toBe(0);
      expect(mismatchRes.stderr).toContain(
        `the staged copy answers ${h1.commit1}, expected ${h1.commit2}; nothing was promoted`,
      );
      expect(readCallLog(h1).some((line) => line.includes("promote"))).toBe(false);
      expect(readFileSync(h1.releasesLogFile, "utf8")).toBe(beforeLog1);
      expect(existsSync(h1.lockDir)).toBe(false);

      // Case B: host deploy prints no https:// URL.
      const h2 = makeHarness();
      recordPass(h2, h2.commit2);
      recordRelease(h2, 4, h2.commit1, "https://previous.example.com");
      const beforeLog2 = readFileSync(h2.releasesLogFile, "utf8");
      const liveSrv2 = await makeLiveServer(h2, h2.commit1);
      await makeStagedServer(h2, h2.commit1);
      writeFileSync(h2.hostNoUrlMarker, "1\n", "utf8");

      const noUrlRes = await runDeploy(h2, [h2.commit2], {
        SOUS_LIVE_URL: liveSrv2.url,
      });
      expect(noUrlRes.status).not.toBe(0);
      expect(noUrlRes.stderr).toContain("https://");
      expect(readCallLog(h2).some((line) => line.includes("promote"))).toBe(false);
      expect(readFileSync(h2.releasesLogFile, "utf8")).toBe(beforeLog2);
      expect(existsSync(h2.lockDir)).toBe(false);

      // Case C: staged smoke check fails.
      const h3 = makeHarness();
      recordPass(h3, h3.commit2);
      recordRelease(h3, 4, h3.commit1, "https://previous.example.com");
      const beforeLog3 = readFileSync(h3.releasesLogFile, "utf8");
      const liveSrv3 = await makeLiveServer(h3, h3.commit1);
      await makeStagedServer(h3, h3.commit1);
      writeFileSync(h3.smokeFailUrlMarker, "https://staged.example.com\n", "utf8");

      const smokeRes = await runDeploy(h3, [h3.commit2], {
        SOUS_LIVE_URL: liveSrv3.url,
      });
      expect(smokeRes.status).not.toBe(0);
      expect(smokeRes.stderr).toContain("nothing was promoted");
      expect(readCallLog(h3).some((line) => line.includes("promote"))).toBe(false);
      expect(readFileSync(h3.releasesLogFile, "utf8")).toBe(beforeLog3);
      expect(existsSync(h3.lockDir)).toBe(false);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-12: failed promote, stale live version after promote, or live smoke failure exits 1, prints rollback line, and leaves releases.log unchanged",
    async () => {
      // Case A: live smoke fails after promote switches live version.
      const h1 = makeHarness();
      recordPass(h1, h1.commit2);
      recordRelease(h1, 4, h1.commit1, "https://previous.example.com");
      const beforeLog1 = readFileSync(h1.releasesLogFile, "utf8");
      const liveSrv1 = await makeLiveServer(h1, h1.commit1);
      await makeStagedServer(h1, h1.commit1);
      writeFileSync(h1.smokeFailUrlMarker, `${liveSrv1.url}\n`, "utf8");

      const smokeFailRes = await runDeploy(h1, [h1.commit2], {
        SOUS_LIVE_URL: liveSrv1.url,
      });
      expect(smokeFailRes.status).toBe(1);
      expect(smokeFailRes.stderr).toContain(
        "fake-host rollback https://previous.example.com --yes",
      );
      expect(readFileSync(h1.releasesLogFile, "utf8")).toBe(beforeLog1);
      expect(
        readCallLog(h1).some((line) =>
          line.includes("fake-host promote https://staged.example.com --yes"),
        ),
      ).toBe(true);
      expect(existsSync(h1.lockDir)).toBe(false);

      // Case B: stand-in smoke passes but live copy keeps answering the old commit.
      const h2 = makeHarness();
      recordPass(h2, h2.commit2);
      recordRelease(h2, 4, h2.commit1, "https://previous.example.com");
      const beforeLog2 = readFileSync(h2.releasesLogFile, "utf8");
      const liveSrv2 = await makeLiveServer(h2, h2.commit1);
      await makeStagedServer(h2, h2.commit1);
      writeFileSync(h2.promoteNoSwitchMarker, "1\n", "utf8");

      const staleLiveRes = await runDeploy(h2, [h2.commit2], {
        SOUS_LIVE_URL: liveSrv2.url,
        SOUS_LIVE_WAIT_SECONDS: "1",
      });
      expect(staleLiveRes.status).toBe(1);
      expect(staleLiveRes.stderr).toContain("does not answer the new commit");
      expect(staleLiveRes.stderr).toContain(
        "fake-host rollback https://previous.example.com --yes",
      );
      expect(readFileSync(h2.releasesLogFile, "utf8")).toBe(beforeLog2);
      expect(existsSync(h2.lockDir)).toBe(false);

      // Case C: host promote command itself fails (after migrating the database).
      const h3 = makeHarness();
      const migCommit3 = commitAndPushNewMigration(h3);
      recordPass(h3, migCommit3);
      recordRelease(h3, 4, h3.commit1, "https://previous.example.com");
      const beforeLog3 = readFileSync(h3.releasesLogFile, "utf8");
      const liveSrv3 = await makeLiveServer(h3, h3.commit1);
      await makeStagedServer(h3, h3.commit1);
      writeFileSync(h3.promoteFailMarker, "1\n", "utf8");

      const failPromoteRes = await runDeploy(h3, [migCommit3], {
        SOUS_LIVE_URL: liveSrv3.url,
        SOUS_DEPLOY_ENV_FILE: h3.deployEnvFile,
        SOUS_BACKUP_DIR: h3.backupDir,
      });
      expect(failPromoteRes.status).toBe(1);
      expect(failPromoteRes.stderr).toContain(
        "promote failed; its outcome is unknown, check what the live address answers",
      );
      expect(failPromoteRes.stderr).toContain("migrated the database");
      expect(failPromoteRes.stderr).toContain(
        "fake-host rollback https://previous.example.com --yes",
      );
      expect(readFileSync(h3.releasesLogFile, "utf8")).toBe(beforeLog3);
      expect(existsSync(h3.lockDir)).toBe(false);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-13: real run with migration passes PG* env (never password in args), isolates db:migrate env, and stops on failed/empty dump or failed migrate",
    async () => {
      // Happy path: pg_dump via PG* env before db:migrate, non-empty dump, clean env, no password in args or output.
      const h1 = makeHarness();
      const migCommit1 = commitAndPushNewMigration(h1);
      recordPass(h1, migCommit1);
      recordRelease(h1, 1, h1.commit1, "https://previous.example.com");
      const srv1 = await makeLiveServer(h1, h1.commit1);
      await makeStagedServer(h1, h1.commit1);

      const okRes = await runDeploy(h1, [migCommit1], {
        SOUS_LIVE_URL: srv1.url,
        SOUS_DEPLOY_ENV_FILE: h1.deployEnvFile,
        SOUS_BACKUP_DIR: h1.backupDir,
      });

      expect(okRes.status).toBe(0);
      expect(okRes.stdout).not.toContain("secretpass");
      expect(okRes.stderr).not.toContain("secretpass");

      const calls1 = readCallLog(h1);
      const dumpIdx = calls1.findIndex((line) => line.startsWith("pg_dump "));
      const migrateIdx = calls1.findIndex((line) =>
        line.includes("pnpm --dir app db:migrate"),
      );
      const deployIdx = calls1.findIndex((line) =>
        line.startsWith("fake-host deploy "),
      );
      expect(dumpIdx).toBeGreaterThan(-1);
      expect(migrateIdx).toBeGreaterThan(dumpIdx);
      expect(deployIdx).toBeGreaterThan(migrateIdx);

      // Password never appears in pg_dump or pnpm arguments.
      expect(calls1[dumpIdx]).not.toContain("secretpass");
      expect(calls1[migrateIdx]).not.toContain("secretpass");

      // pg_dump received PG* connection variables including PGPASSWORD and PGSSLMODE.
      const pgEnvRuns = readPgDumpEnvLog(h1);
      expect(pgEnvRuns).toHaveLength(1);
      expect(pgEnvRuns[0]).toContain("PGPASSWORD");
      expect(pgEnvRuns[0]).toContain("PGHOST");
      expect(pgEnvRuns[0]).toContain("PGPORT");
      expect(pgEnvRuns[0]).toContain("PGUSER");
      expect(pgEnvRuns[0]).toContain("PGDATABASE");
      expect(pgEnvRuns[0]).toContain("PGSSLMODE");

      // db:migrate received only DATABASE_URL (plus PATH, HOME, and bash's PWD, SHLVL, _).
      const envMatch = / \| env=([^|]*) \| /.exec(calls1[migrateIdx] ?? "");
      expect(envMatch).not.toBeNull();
      const migrateEnvVars = (envMatch?.[1] ?? "")
        .split(",")
        .filter((name) => name.length > 0);
      expect(migrateEnvVars).toContain("DATABASE_URL");
      const allowedMigrateEnv = new Set(["DATABASE_URL", "PWD", "SHLVL", "_"]);
      for (const name of migrateEnvVars) {
        expect(allowedMigrateEnv.has(name)).toBe(true);
      }

      const dumps1 = readdirSync(h1.backupDir).filter((f) => f.endsWith(".dump"));
      expect(dumps1).toHaveLength(1);
      const dumpPath1 = path.join(h1.backupDir, dumps1[0]!);
      expect(statSync(dumpPath1).size).toBeGreaterThan(0);

      // pg_dump received exactly -Fc, --no-owner, -n public, -n drizzle, and -f <backup path>
      // with no other schema/table selection, exclusion, or --strict-names.
      const pgArgsRuns = readPgDumpArgsLog(h1);
      expect(pgArgsRuns).toHaveLength(1);
      expect(pgArgsRuns[0]).toEqual([
        "-Fc",
        "--no-owner",
        "-n",
        "public",
        "-n",
        "drizzle",
        "-f",
        dumpPath1,
      ]);

      expect(readdirSync(h1.tmpDir)).toEqual([]);

      // Failing pg_dump (non-zero exit even when a partial file was written): stops before db:migrate and host.
      const hFailDump = makeHarness();
      const migCommitFailDump = commitAndPushNewMigration(hFailDump);
      recordPass(hFailDump, migCommitFailDump);
      recordRelease(hFailDump, 1, hFailDump.commit1, "https://previous.example.com");
      const srvFailDump = await makeLiveServer(hFailDump, hFailDump.commit1);
      await makeStagedServer(hFailDump, hFailDump.commit1);
      writeFileSync(hFailDump.pgDumpFailMarker, "1\n", "utf8");

      const failDumpRes = await runDeploy(hFailDump, [migCommitFailDump], {
        SOUS_LIVE_URL: srvFailDump.url,
        SOUS_DEPLOY_ENV_FILE: hFailDump.deployEnvFile,
        SOUS_BACKUP_DIR: hFailDump.backupDir,
      });
      expect(failDumpRes.status).not.toBe(0);
      expect(failDumpRes.stderr).toContain("pg_dump failed");
      const callsFailDump = readCallLog(hFailDump);
      expect(callsFailDump.some((line) => line.startsWith("pg_dump "))).toBe(true);
      expect(callsFailDump.some((line) => line.includes("db:migrate"))).toBe(false);
      expect(hostCalls(hFailDump)).toEqual([]);

      // Empty-dump marker: refused before db:migrate and host CLI.
      const h2 = makeHarness();
      const migCommit2 = commitAndPushNewMigration(h2);
      recordPass(h2, migCommit2);
      recordRelease(h2, 1, h2.commit1, "https://previous.example.com");
      const srv2 = await makeLiveServer(h2, h2.commit1);
      await makeStagedServer(h2, h2.commit1);
      writeFileSync(h2.emptyDumpMarker, "1\n", "utf8");

      const emptyRes = await runDeploy(h2, [migCommit2], {
        SOUS_LIVE_URL: srv2.url,
        SOUS_DEPLOY_ENV_FILE: h2.deployEnvFile,
        SOUS_BACKUP_DIR: h2.backupDir,
      });

      expect(emptyRes.status).not.toBe(0);
      expect(emptyRes.stderr).toContain("empty");
      expect(emptyRes.stdout).not.toContain("secretpass");
      expect(emptyRes.stderr).not.toContain("secretpass");
      const calls2 = readCallLog(h2);
      expect(calls2.some((line) => line.startsWith("pg_dump "))).toBe(true);
      expect(calls2.some((line) => line.includes("db:migrate"))).toBe(false);
      expect(hostCalls(h2)).toEqual([]);

      // Migrate-fails marker: exit 1, output names dump path and scratch-restore note, host never called.
      const h3 = makeHarness();
      const migCommit3 = commitAndPushNewMigration(h3);
      recordPass(h3, migCommit3);
      recordRelease(h3, 1, h3.commit1, "https://previous.example.com");
      const srv3 = await makeLiveServer(h3, h3.commit1);
      await makeStagedServer(h3, h3.commit1);
      writeFileSync(h3.migrateFailMarker, "1\n", "utf8");

      const failMigRes = await runDeploy(h3, [migCommit3], {
        SOUS_LIVE_URL: srv3.url,
        SOUS_DEPLOY_ENV_FILE: h3.deployEnvFile,
        SOUS_BACKUP_DIR: h3.backupDir,
      });

      expect(failMigRes.status).toBe(1);
      const dumps3 = readdirSync(h3.backupDir).filter((f) => f.endsWith(".dump"));
      expect(dumps3).toHaveLength(1);
      const dumpPath3 = path.join(h3.backupDir, dumps3[0]!);
      expect(statSync(dumpPath3).size).toBeGreaterThan(0);
      expect(failMigRes.stderr).toContain(dumpPath3);
      expect(failMigRes.stderr).toContain(
        "restore it into a scratch database first (docs/deploy.md, Backup and restore)",
      );
      expect(failMigRes.stdout).not.toContain("secretpass");
      expect(failMigRes.stderr).not.toContain("secretpass");
      expect(hostCalls(h3)).toEqual([]);
      expect(readdirSync(h3.tmpDir)).toEqual([]);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it("DEPLOY-14: dry run redacts host tokens in printed deploy, promote, and rollback commands", async () => {
    const h = makeHarness();
    recordPass(h, h.commit2);
    recordRelease(h, 4, h.commit1, "https://previous.example.com");
    const srv = await makeLiveServer(h, h.commit1);

    const resToken = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
      SOUS_HOST_ARGS: "--scope example-team --token abc123",
    });
    expect(resToken.status).toBe(0);
    expect(resToken.stdout).toContain("--scope example-team --token <redacted>");
    expect(resToken.stdout).not.toContain("abc123");
    expect(resToken.stderr).not.toContain("abc123");

    const resShort = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
      SOUS_HOST_ARGS: "--scope example-team -t def456",
    });
    expect(resShort.status).toBe(0);
    expect(resShort.stdout).toContain("--scope example-team -t <redacted>");
    expect(resShort.stdout).not.toContain("def456");
    expect(resShort.stderr).not.toContain("def456");

    const resEquals = await runDeploy(h, ["--dry-run", h.commit2], {
      SOUS_LIVE_URL: srv.url,
      SOUS_HOST_ARGS: "--scope example-team --token=ghi789",
    });
    expect(resEquals.status).toBe(0);
    expect(resEquals.stdout).toContain("--scope example-team --token=<redacted>");
    expect(resEquals.stdout).not.toContain("ghi789");
    expect(resEquals.stderr).not.toContain("ghi789");
  });

  it(
    "DEPLOY-15: tracing is disabled under bash -x and SHELLOPTS=xtrace so no password, token, or bypass value leaks",
    async () => {
      const hostToken = "hosttok-98765";
      const bypassVal = "bypass-secret-54321";

      // Run 1: bash -x scripts/deploy.sh ...
      const h1 = makeHarness();
      const migCommit1 = commitAndPushNewMigration(h1);
      recordPass(h1, migCommit1);
      recordRelease(h1, 1, h1.commit1, "https://previous.example.com");
      const liveSrv1 = await makeLiveServer(h1, h1.commit1);
      await makeStagedServer(h1, h1.commit1);

      const resDashX = await runDeploy(
        h1,
        [migCommit1],
        {
          SOUS_LIVE_URL: liveSrv1.url,
          SOUS_DEPLOY_ENV_FILE: h1.deployEnvFile,
          SOUS_BACKUP_DIR: h1.backupDir,
          SOUS_HOST_ARGS: `--scope example-team --token ${hostToken}`,
          SMOKE_BYPASS_HEADER: "x-test-bypass",
          SMOKE_BYPASS_VALUE: bypassVal,
        },
        ["-x"],
      );
      expect(resDashX.status).toBe(0);
      for (const secret of ["secretpass", hostToken, bypassVal]) {
        expect(resDashX.stdout).not.toContain(secret);
        expect(resDashX.stderr).not.toContain(secret);
      }

      // Run 2: SHELLOPTS=xtrace in environment.
      const h2 = makeHarness();
      const migCommit2 = commitAndPushNewMigration(h2);
      recordPass(h2, migCommit2);
      recordRelease(h2, 1, h2.commit1, "https://previous.example.com");
      const liveSrv2 = await makeLiveServer(h2, h2.commit1);
      await makeStagedServer(h2, h2.commit1);

      const resShellOpts = await runDeploy(h2, [migCommit2], {
        SHELLOPTS: "xtrace",
        SOUS_LIVE_URL: liveSrv2.url,
        SOUS_DEPLOY_ENV_FILE: h2.deployEnvFile,
        SOUS_BACKUP_DIR: h2.backupDir,
        SOUS_HOST_ARGS: `--scope example-team --token ${hostToken}`,
        SMOKE_BYPASS_HEADER: "x-test-bypass",
        SMOKE_BYPASS_VALUE: bypassVal,
      });
      expect(resShellOpts.status).toBe(0);
      for (const secret of ["secretpass", hostToken, bypassVal]) {
        expect(resShellOpts.stdout).not.toContain(secret);
        expect(resShellOpts.stderr).not.toContain(secret);
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it("DEPLOY-16: failing git migration listing stops the run instead of reporting no new migrations", async () => {
    const h = makeHarness();
    // Create a migration commit on a separate branch, push to origin/main,
    // then return the working tree to commit1 so checkout stays readable.
    git(h.repoDir, ["checkout", "-b", "mig-branch", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/0001_corrupt_test.sql"),
      "ALTER TABLE items ADD COLUMN note text;\n",
      "utf8",
    );
    git(h.repoDir, ["add", "app/drizzle/migrations/0001_corrupt_test.sql"]);
    git(h.repoDir, ["commit", "-m", "branch migration commit"]);
    const targetCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    git(h.repoDir, ["checkout", h.commit1]);

    // Delete the loose tree object for the target commit's app/drizzle/migrations.
    const migTreeHash = git(h.repoDir, [
      "rev-parse",
      `${targetCommit}:app/drizzle/migrations`,
    ]);
    const looseObjPath = path.join(
      h.repoDir,
      ".git/objects",
      migTreeHash.slice(0, 2),
      migTreeHash.slice(2),
    );
    expect(existsSync(looseObjPath)).toBe(true);
    rmSync(looseObjPath);

    recordPass(h, targetCommit);
    recordRelease(h, 1, h.commit1, "https://previous.example.com");
    const srv = await makeLiveServer(h, h.commit1);

    const res = await runDeploy(h, ["--dry-run", targetCommit], {
      SOUS_LIVE_URL: srv.url,
      SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
      SOUS_BACKUP_DIR: h.backupDir,
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(res.stdout).not.toContain("New migrations: none");
    expect(hostCalls(h)).toEqual([]);
  });

  it(
    "DEPLOY-17: real first release with --first-release 7 and empty log records the exact release line",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      const liveSrv = await makeLiveServer(h, null);
      await makeStagedServer(h, null);

      const res = await runDeploy(h, ["--first-release", "7", h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
        SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
        SOUS_BACKUP_DIR: h.backupDir,
      });

      expect(res.status).toBe(0);
      expect(existsSync(h.releasesLogFile)).toBe(true);
      const lines = readFileSync(h.releasesLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        new RegExp(
          `^7 ${h.commit2} https://staged\\.example\\.com \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
        ),
      );
      expect(res.stdout).toContain("no recorded release matches the live commit");
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it("RCHECK-1: release-check.sh refuses an unknown commit quickly without installing", () => {
    const h = makeHarness();

    const res = spawnSync("bash", ["scripts/release-check.sh", "not-a-commit"], {
      cwd: h.repoDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: h.rootDir,
        SOUS_RELEASE_STATE_DIR: h.stateDir,
      },
      encoding: "utf8",
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("not-a-commit");
    expect(existsSync(h.passLogFile)).toBe(false);
  }, REAL_RUN_TIMEOUT_MS);

  it.skipIf(process.platform !== "darwin")(
    "RCHECK-2: release-check.sh sets CI=1 for every step and records a pass only when all steps and reports succeed (skipped outside macOS because screenshot checks only run on macOS)",
    async () => {
      // Case A: every step succeeds -> one pass line for sha, CI=1 on every step.
      const hOk = makeReleaseCheckHarness();
      const okRes = await runReleaseCheck(hOk, hOk.commit1, {
        E2E_APP_PORT: await pickFreePort(),
      });
      expect(okRes.status).toBe(0);
      expect(existsSync(hOk.passLogFile)).toBe(true);
      const passLines = readFileSync(hOk.passLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(passLines).toHaveLength(1);
      expect(passLines[0]).toMatch(
        new RegExp(
          `^${hOk.commit1} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z e2e=3/0 visual=2/0$`,
        ),
      );
      const okCalls = readFileSync(hOk.callLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      const stepCalls = okCalls.filter(
        (line) => line.startsWith("pnpm ") && !line.includes("e2e:db:down"),
      );
      expect(stepCalls.length).toBeGreaterThanOrEqual(12);
      for (const line of stepCalls) {
        expect(line).toContain("| CI=1");
      }

      // Case B: middle step (test:run) fails -> no pass line and no later step called.
      const hMid = makeReleaseCheckHarness();
      writeFileSync(hMid.failStepMarker, "test:run", "utf8");
      const midRes = await runReleaseCheck(hMid, hMid.commit1, {
        E2E_APP_PORT: await pickFreePort(),
      });
      expect(midRes.status).not.toBe(0);
      expect(existsSync(hMid.passLogFile)).toBe(false);
      const midCalls = readFileSync(hMid.callLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(midCalls.some((line) => line.includes("test:run"))).toBe(true);
      expect(midCalls.some((line) => line.includes(" build"))).toBe(false);
      expect(midCalls.some((line) => line.includes("e2e:db:up"))).toBe(false);
      expect(midCalls.some((line) => line.includes(" e2e "))).toBe(false);
      expect(midCalls.some((line) => line.includes("e2e:visual"))).toBe(false);

      // Case C: visual screenshot report shows one unexpected failure -> no pass line.
      const hVis = makeReleaseCheckHarness();
      writeFileSync(hVis.visualUnexpectedMarker, "1\n", "utf8");
      const visRes = await runReleaseCheck(hVis, hVis.commit1, {
        E2E_APP_PORT: await pickFreePort(),
      });
      expect(visRes.status).not.toBe(0);
      expect(existsSync(hVis.passLogFile)).toBe(false);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-18: waits for live /api/version to answer the new commit after promote before recording the release",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      await makeStagedServer(h, h.commit1);
      // Leave the stand-in promote from switching the live version file so the
      // live server controls when the new commit appears.
      writeFileSync(h.promoteNoSwitchMarker, "1\n", "utf8");

      let postPromoteRequests = 0;
      const delayedLiveServer = http.createServer((req, res) => {
        if (req.url !== "/api/version") {
          res.writeHead(404);
          res.end();
          return;
        }
        const promoted = readCallLog(h).some((line) =>
          line.startsWith("fake-host promote "),
        );
        let commit = h.commit1;
        if (promoted) {
          postPromoteRequests += 1;
          if (postPromoteRequests >= 2) {
            commit = h.commit2;
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ commit }));
      });

      await new Promise<void>((resolve, reject) => {
        delayedLiveServer.once("error", reject);
        delayedLiveServer.listen(0, "127.0.0.1", () => resolve());
      });

      try {
        const addr = delayedLiveServer.address() as AddressInfo;
        const liveUrl = `http://127.0.0.1:${addr.port}`;

        const res = await runDeploy(h, [h.commit2], {
          SOUS_LIVE_URL: liveUrl,
          SOUS_LIVE_WAIT_SECONDS: "12",
        });

        expect(res.status).toBe(0);
        expect(postPromoteRequests).toBeGreaterThanOrEqual(2);

        const releaseLines = readFileSync(h.releasesLogFile, "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
        expect(releaseLines).toHaveLength(2);
        expect(releaseLines[1]).toMatch(
          new RegExp(
            `^5 ${h.commit2} https://staged\\.example\\.com \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
          ),
        );
      } finally {
        await new Promise<void>((resolve, reject) => {
          delayedLiveServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-19: bypass header value reaches staged and live servers without ever appearing on curl's command line",
    async () => {
      const realCurl = execFileSync("bash", ["-c", "command -v curl"], {
        encoding: "utf8",
      }).trim();
      expect(realCurl.length).toBeGreaterThan(0);

      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const liveSrv = await makeLiveServer(h, h.commit1);
      const stagedSrv = await makeStagedServer(h, h.commit1);

      const curlArgLog = path.join(h.rootDir, "curl-args.log");
      const recordingCurlPath = path.join(h.binDir, "curl");
      writeFileSync(
        recordingCurlPath,
        [
          "#!/usr/bin/env bash",
          "{ set +x; } 2>/dev/null",
          "set -euo pipefail",
          'for arg in "$@"; do',
          `  printf '%s\\n' "\${arg}" >> ${JSON.stringify(curlArgLog)}`,
          "done",
          `exec ${JSON.stringify(realCurl)} "$@"`,
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(recordingCurlPath, 0o755);

      const bypassVal = "bypass-argv-secret-7711";
      const res = await runDeploy(h, [h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
        SMOKE_BYPASS_HEADER: "x-test-bypass",
        SMOKE_BYPASS_VALUE: bypassVal,
      });

      expect(res.status).toBe(0);

      const loggedArgs = readFileSync(curlArgLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(loggedArgs).toContain(`${liveSrv.url}/api/version`);
      expect(loggedArgs).toContain("https://staged.example.com/api/version");
      for (const arg of loggedArgs) {
        expect(arg).not.toContain(bypassVal);
      }

      expect(stagedSrv.receivedHeaders.length).toBeGreaterThanOrEqual(1);
      for (const headers of stagedSrv.receivedHeaders) {
        expect(headers["x-test-bypass"]).toBe(bypassVal);
      }
      expect(liveSrv.receivedHeaders.length).toBeGreaterThanOrEqual(2);
      for (const headers of liveSrv.receivedHeaders) {
        expect(headers["x-test-bypass"]).toBe(bypassVal);
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it("DEPLOY-20: first release stops when git cannot list target migrations instead of reporting none", async () => {
    const h = makeHarness();
    git(h.repoDir, ["checkout", "-b", "mig-branch", h.commit1]);
    writeFileSync(
      path.join(h.repoDir, "app/drizzle/migrations/0001_corrupt_first.sql"),
      "ALTER TABLE items ADD COLUMN note text;\n",
      "utf8",
    );
    git(h.repoDir, ["add", "app/drizzle/migrations/0001_corrupt_first.sql"]);
    git(h.repoDir, ["commit", "-m", "branch migration commit"]);
    const targetCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
    git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
    git(h.repoDir, ["checkout", h.commit1]);

    const migTreeHash = git(h.repoDir, [
      "rev-parse",
      `${targetCommit}:app/drizzle/migrations`,
    ]);
    const looseObjPath = path.join(
      h.repoDir,
      ".git/objects",
      migTreeHash.slice(0, 2),
      migTreeHash.slice(2),
    );
    expect(existsSync(looseObjPath)).toBe(true);
    rmSync(looseObjPath);

    recordPass(h, targetCommit);
    const srv = await makeLiveServer(h, null);

    const res = await runDeploy(
      h,
      ["--dry-run", "--first-release", "1", targetCommit],
      {
        SOUS_LIVE_URL: srv.url,
        SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
        SOUS_BACKUP_DIR: h.backupDir,
      },
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("failed to list migrations");
    expect(res.stdout).not.toContain("New migrations: none");
    expect(hostCalls(h)).toEqual([]);
  });

  it("DEPLOY-21: refuses new migrations whose timestamps do not increase among themselves", async () => {
    const h = makeHarness();
    const srv = await makeLiveServer(h, h.commit1);
    recordRelease(h, 1, h.commit1);

    const cases = [
      { branch: "equal-when", secondWhen: 1700000002000 },
      { branch: "decreasing-when", secondWhen: 1700000001500 },
    ] as const;

    for (const tc of cases) {
      git(h.repoDir, ["checkout", "-b", tc.branch, h.commit1]);
      writeFileSync(
        path.join(h.repoDir, "app/drizzle/migrations/0001_first.sql"),
        "ALTER TABLE items ADD COLUMN first_col text;\n",
        "utf8",
      );
      writeFileSync(
        path.join(h.repoDir, "app/drizzle/migrations/0002_second.sql"),
        "ALTER TABLE items ADD COLUMN second_col text;\n",
        "utf8",
      );
      writeFileSync(
        path.join(h.repoDir, "app/drizzle/migrations/meta/_journal.json"),
        JSON.stringify(
          {
            version: "7",
            dialect: "postgresql",
            entries: [
              {
                idx: 0,
                version: "7",
                when: 1700000000000,
                tag: "0000_init",
                breakpoints: true,
              },
              {
                idx: 1,
                version: "7",
                when: 1700000002000,
                tag: "0001_first",
                breakpoints: true,
              },
              {
                idx: 2,
                version: "7",
                when: tc.secondWhen,
                tag: "0002_second",
                breakpoints: true,
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      git(h.repoDir, [
        "add",
        "app/drizzle/migrations/0001_first.sql",
        "app/drizzle/migrations/0002_second.sql",
        "app/drizzle/migrations/meta/_journal.json",
      ]);
      git(h.repoDir, ["commit", "-m", `append two migrations (${tc.branch})`]);
      const badCommit = git(h.repoDir, ["rev-parse", "HEAD"]);
      git(h.repoDir, ["push", "--force", "origin", "HEAD:main"]);
      recordPass(h, badCommit);

      const res = await runDeploy(h, ["--dry-run", badCommit], {
        SOUS_LIVE_URL: srv.url,
        SOUS_DEPLOY_ENV_FILE: h.deployEnvFile,
        SOUS_BACKUP_DIR: h.backupDir,
      });

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("does not increase");
      expect(res.stderr).toContain("0002_second");
      expect(hostCalls(h)).toEqual([]);
    }
  });

  it(
    "DEPLOY-22: refuses missing or invalid SOUS_EXPECT_SIGN_IN in dry run and real run before any git, network, or host call, and dry run prints expected mode",
    async () => {
      // Use a harness with no recorded pass and an unresolvable commit name
      // so any step after env validation would fail differently or hit network/host.
      // Put git and curl shims first on PATH so any git or network call is logged
      // and fails immediately, and remove stateDir so lock creation is observable.
      const hRefuse = makeHarness();
      const refuseLiveSrv = await makeLiveServer(hRefuse, hRefuse.commit1);
      for (const tool of ["git", "curl"] as const) {
        const shimPath = path.join(hRefuse.binDir, tool);
        writeFileSync(
          shimPath,
          [
            "#!/usr/bin/env bash",
            "{ set +x; } 2>/dev/null",
            "set -euo pipefail",
            `printf '%s %s\\n' ${JSON.stringify(tool)} "$*" >> ${JSON.stringify(hRefuse.callLogFile)}`,
            "exit 99",
            "",
          ].join("\n"),
          "utf8",
        );
        chmodSync(shimPath, 0o755);
      }
      rmSync(hRefuse.stateDir, { recursive: true, force: true });

      function assertRefusedEarly(res: RunResult): void {
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("SOUS_EXPECT_SIGN_IN");
        expect(res.stderr).not.toContain("release-check");
        expect(res.stderr).not.toContain("unknown commit");
        expect(res.stderr).not.toContain("failed to fetch");
        expect(res.stderr).not.toContain("api/version");
        expect(res.stderr).not.toContain("failed to read");
        expect(refuseLiveSrv.receivedHeaders).toEqual([]);
        expect(hostCalls(hRefuse)).toEqual([]);
        expect(readCallLog(hRefuse)).toEqual([]);
        expect(existsSync(hRefuse.lockDir)).toBe(false);
        expect(existsSync(hRefuse.stateDir)).toBe(false);
      }

      // Missing SOUS_EXPECT_SIGN_IN is reported together with other missing required variables.
      for (const args of [
        ["--dry-run", "not-even-resolved"],
        ["not-even-resolved"],
      ] as const) {
        const missingTogether = await runDeploy(hRefuse, args, {
          SOUS_LIVE_URL: undefined,
          SOUS_EXPECT_SIGN_IN: undefined,
        });
        assertRefusedEarly(missingTogether);
        expect(missingTogether.stderr).toContain("SOUS_LIVE_URL");

        const missingAlone = await runDeploy(hRefuse, args, {
          SOUS_LIVE_URL: refuseLiveSrv.url,
          SOUS_EXPECT_SIGN_IN: undefined,
        });
        assertRefusedEarly(missingAlone);
      }

      // Invalid values are refused in both dry run and real run before git, network, or host.
      const invalidValues = ["", "ON", "Off", "true", "1", "yes", "on "];
      for (const badVal of invalidValues) {
        for (const args of [
          ["--dry-run", "not-even-resolved"],
          ["not-even-resolved"],
        ] as const) {
          const res = await runDeploy(hRefuse, args, {
            SOUS_LIVE_URL: refuseLiveSrv.url,
            SOUS_EXPECT_SIGN_IN: badVal,
          });
          assertRefusedEarly(res);
          expect(res.stderr).toContain('"on"');
          expect(res.stderr).toContain('"off"');
        }
      }

      // Dry run prints expected sign-in mode and includes SMOKE_EXPECT_SIGN_IN on both smoke lines.
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 1, h.commit1, "https://previous.example.com");
      const liveSrv = await makeLiveServer(h, h.commit1);
      for (const mode of ["on", "off"] as const) {
        const dryRes = await runDeploy(h, ["--dry-run", h.commit2], {
          SOUS_LIVE_URL: liveSrv.url,
          SOUS_EXPECT_SIGN_IN: mode,
        });
        expect(dryRes.status).toBe(0);
        expect(dryRes.stdout).toContain(`Expected sign-in mode: ${mode}`);
        expect(dryRes.stdout).toContain(
          `Would smoke staged URL: SMOKE_BASE_URL=<staged-url> SMOKE_EXPECT_COMMIT=${h.commit2} SMOKE_EXPECT_SIGN_IN=${mode} pnpm --dir app e2e:smoke`,
        );
        expect(dryRes.stdout).toContain(
          `Would smoke live URL: SMOKE_BASE_URL=${liveSrv.url} SMOKE_EXPECT_COMMIT=${h.commit2} SMOKE_EXPECT_SIGN_IN=${mode} pnpm --dir app e2e:smoke`,
        );
        expect(hostCalls(h)).toEqual([]);
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-23: accepts JSON staging stdout in compact, pretty-printed, https-prefixed, and top-level forms",
    async () => {
      const jsonPayloads = [
        // Compact one-line JSON with bare hostname under deployment.url.
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-compact",
            url: "staged.example.com",
            readyState: "READY",
          },
          outcome: "created",
        })}\n`,
        // Pretty-printed JSON with bare hostname under deployment.url.
        `${JSON.stringify(
          {
            deployment: {
              id: "test-deployment-pretty",
              url: "staged.example.com",
              readyState: "READY",
            },
            outcome: "created",
          },
          null,
          2,
        )}\n`,
        // JSON with deployment.url already prefixed with https://.
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-https",
            url: "https://staged.example.com",
            readyState: "READY",
          },
          outcome: "created",
        })}\n`,
        // Top-level url and readyState when there is no deployment object.
        `${JSON.stringify({
          url: "staged.example.com",
          readyState: "READY",
        })}\n`,
      ];

      for (const payload of jsonPayloads) {
        const h = makeHarness();
        recordPass(h, h.commit2);
        recordRelease(h, 4, h.commit1, "https://previous.example.com");
        const liveSrv = await makeLiveServer(h, h.commit1);
        const stagedSrv = await makeStagedServer(h, h.commit1);
        writeFileSync(h.hostStdoutFile, payload, "utf8");

        const res = await runDeploy(h, [h.commit2], {
          SOUS_LIVE_URL: liveSrv.url,
        });

        expect(res.status).toBe(0);
        expect(stagedSrv.receivedHeaders.length).toBeGreaterThanOrEqual(1);

        const calls = readCallLog(h);
        expect(calls).toHaveLength(5);
        expect(calls[2]).toContain("pnpm --dir app e2e:smoke");
        expect(calls[2]).toContain("SMOKE_BASE_URL=https://staged.example.com");
        expect(calls[2]).toContain("SMOKE_EXPECT_SIGN_IN=on");
        expect(calls[3]).toBe("fake-host promote https://staged.example.com --yes");
        expect(calls[4]).toContain("pnpm --dir app e2e:smoke");
        expect(calls[4]).toContain(`SMOKE_BASE_URL=${liveSrv.url}`);
        expect(calls[4]).toContain("SMOKE_EXPECT_SIGN_IN=on");

        const releaseLines = readFileSync(h.releasesLogFile, "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
        expect(releaseLines).toHaveLength(2);
        expect(releaseLines[1]).toMatch(
          new RegExp(
            `^5 ${h.commit2} https://staged\\.example\\.com \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
          ),
        );
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-24: refuses JSON staging stdout with non-READY readyState, missing url, or invalid url before version check, smoke, or promote",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const beforeLog = readFileSync(h.releasesLogFile, "utf8");
      const liveSrv = await makeLiveServer(h, h.commit1);
      const stagedSrv = await makeStagedServer(h, h.commit1);

      async function expectJsonRefused(
        payload: string,
        expectedStderrSnippets: readonly string[],
      ): Promise<RunResult> {
        writeFileSync(h.hostStdoutFile, payload, "utf8");
        rmSync(h.callLogFile, { force: true });
        stagedSrv.receivedHeaders.length = 0;

        const res = await runDeploy(h, [h.commit2], {
          SOUS_LIVE_URL: liveSrv.url,
        });
        expect(res.status).not.toBe(0);
        for (const snippet of expectedStderrSnippets) {
          expect(res.stderr).toContain(snippet);
        }
        expect(stagedSrv.receivedHeaders).toEqual([]);
        expect(readCallLog(h).some((line) => line.includes("e2e:smoke"))).toBe(
          false,
        );
        expect(readCallLog(h).some((line) => line.includes("promote"))).toBe(
          false,
        );
        expect(readFileSync(h.releasesLogFile, "utf8")).toBe(beforeLog);
        expect(existsSync(h.lockDir)).toBe(false);
        return res;
      }

      // Non-READY readyState values: BUILDING (including when the JSON text
      // contains an https:// URL), null, and ERROR.
      await expectJsonRefused(
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-building",
            url: "staged.example.com",
            readyState: "BUILDING",
          },
          outcome: "created",
        })}\n`,
        ["BUILDING", "nothing was promoted"],
      );

      await expectJsonRefused(
        `${JSON.stringify(
          {
            deployment: {
              id: "test-deployment-building-https",
              url: "https://staged.example.com",
              inspectorUrl: "https://inspect.example.com",
              readyState: "BUILDING",
            },
            outcome: "created",
          },
          null,
          2,
        )}\n`,
        ["BUILDING", "nothing was promoted"],
      );

      await expectJsonRefused(
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-null-state",
            url: "staged.example.com",
            readyState: null,
          },
          outcome: "created",
        })}\n`,
        ["readyState", "null", "nothing was promoted"],
      );

      await expectJsonRefused(
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-error-state",
            url: "staged.example.com",
            readyState: "ERROR",
          },
          outcome: "created",
        })}\n`,
        ["ERROR", "nothing was promoted"],
      );

      // JSON document with no deployment url stops with the no-URL message.
      await expectJsonRefused(
        `${JSON.stringify({
          deployment: {
            id: "test-deployment-nourl",
            readyState: "READY",
          },
          outcome: "created",
        })}\n`,
        ["host staging output contained no https:// URL", "nothing was promoted"],
      );

      // Invalid URLs in JSON: non-https, port, query, fragment, dot-segment paths,
      // path, non-DNS or percent-encoded hostnames, user@host without password,
      // and user plus password (built at run time).
      const userOnlyUrl = ["https://", "deployuser", "@", "staged.example.com"].join(
        "",
      );
      const bareUserOnly = ["deployuser", "@", "staged.example.com"].join("");
      const credUrl = new URL("https://staged.example.com");
      credUrl.username = "deployuser";
      credUrl.password = "credsecret";

      const badUrls = [
        "http://staged.example.com",
        "https://staged.example.com:8443",
        "staged.example.com:8443",
        "https://staged.example.com?foo=bar",
        "https://staged.example.com#section",
        "https://staged.example.com/.",
        "staged.example.com/.",
        "https://staged.example.com/a/..",
        "staged.example.com/a/..",
        "https://staged.example.com/extra",
        ".",
        "..",
        "a..b.example.com",
        "staged.example.com.",
        "staged%2eexample.com",
        "staged.example.com)",
        userOnlyUrl,
        bareUserOnly,
        credUrl.toString(),
      ];

      for (const badUrl of badUrls) {
        const res = await expectJsonRefused(
          `${JSON.stringify({
            deployment: {
              id: "test-deployment-badurl",
              url: badUrl,
              readyState: "READY",
            },
            outcome: "created",
          })}\n`,
          ["invalid deployment URL", "nothing was promoted"],
        );
        expect(res.stderr).not.toContain("credsecret");
      }
    },
    REAL_RUN_TIMEOUT_MS * 2,
  );

  it(
    "DEPLOY-26: validates bare staging URL lines with the shared rules and normalizes a single trailing slash",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const beforeLog = readFileSync(h.releasesLogFile, "utf8");
      const liveSrv = await makeLiveServer(h, h.commit1);
      const stagedSrv = await makeStagedServer(h, h.commit1);

      const credUrl = new URL("https://staged.example.com");
      credUrl.username = "deployuser";
      credUrl.password = "baresecret";

      const refusedPayloads: Array<{ stdout: string; expectedSnippet: string }> = [
        {
          stdout: "https://staged.example.com/extra\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com:8443\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com?foo=bar\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: `${credUrl.toString()}\n`,
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com (production)\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com,\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com)\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://staged.example.com;\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://%2e\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "https://$(id)\n",
          expectedSnippet: "invalid deployment URL",
        },
        {
          stdout: "http://staged.example.com\n",
          expectedSnippet: "host staging output contained no https:// URL",
        },
      ];

      for (const tc of refusedPayloads) {
        writeFileSync(h.hostStdoutFile, tc.stdout, "utf8");
        rmSync(h.callLogFile, { force: true });
        stagedSrv.receivedHeaders.length = 0;

        const res = await runDeploy(h, [h.commit2], {
          SOUS_LIVE_URL: liveSrv.url,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(tc.expectedSnippet);
        expect(res.stderr).toContain("nothing was promoted");
        expect(res.stderr).not.toContain("baresecret");
        expect(stagedSrv.receivedHeaders).toEqual([]);
        expect(readCallLog(h).some((line) => line.includes("e2e:smoke"))).toBe(
          false,
        );
        expect(readCallLog(h).some((line) => line.includes("promote"))).toBe(
          false,
        );
        expect(readFileSync(h.releasesLogFile, "utf8")).toBe(beforeLog);
      }

      // A bare line with a single trailing slash (and trailing CR) is accepted
      // and normalized to https://<hostname> without the slash everywhere.
      writeFileSync(
        h.hostStdoutFile,
        "Deploying project\nhttps://staged.example.com/\r\n",
        "utf8",
      );
      rmSync(h.callLogFile, { force: true });
      stagedSrv.receivedHeaders.length = 0;

      const okRes = await runDeploy(h, [h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
      });
      expect(okRes.status).toBe(0);
      expect(stagedSrv.receivedHeaders.length).toBeGreaterThanOrEqual(1);

      const calls = readCallLog(h);
      expect(calls).toHaveLength(5);
      expect(calls[2]).toContain("SMOKE_BASE_URL=https://staged.example.com |");
      expect(calls[3]).toBe("fake-host promote https://staged.example.com --yes");
      expect(calls[4]).toContain(`SMOKE_BASE_URL=${liveSrv.url} |`);

      const releaseLines = readFileSync(h.releasesLogFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(releaseLines).toHaveLength(2);
      expect(releaseLines[1]).toMatch(
        new RegExp(
          `^5 ${h.commit2} https://staged\\.example\\.com \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$`,
        ),
      );
    },
    REAL_RUN_TIMEOUT_MS * 2,
  );

  it(
    "DEPLOY-27: prints a newline after host staging output with no trailing newline so Staged URL starts its own line",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const liveSrv = await makeLiveServer(h, h.commit1);
      await makeStagedServer(h, h.commit1);

      writeFileSync(h.hostStdoutFile, "https://staged.example.com", "utf8");

      const noNewlineRes = await runDeploy(h, [h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
      });
      expect(noNewlineRes.status).toBe(0);
      expect(noNewlineRes.stdout).not.toContain(
        "https://staged.example.comStaged URL:",
      );
      const noNewlineLines = noNewlineRes.stdout.split("\n");
      const urlLineIdx = noNewlineLines.indexOf("https://staged.example.com");
      expect(urlLineIdx).toBeGreaterThan(-1);
      expect(noNewlineLines[urlLineIdx + 1]).toBe(
        "Staged URL: https://staged.example.com",
      );

      // When host output already ends with a newline, no extra blank line is added.
      const hWithNewline = makeHarness();
      recordPass(hWithNewline, hWithNewline.commit2);
      recordRelease(
        hWithNewline,
        4,
        hWithNewline.commit1,
        "https://previous.example.com",
      );
      const liveSrv2 = await makeLiveServer(hWithNewline, hWithNewline.commit1);
      await makeStagedServer(hWithNewline, hWithNewline.commit1);
      writeFileSync(
        hWithNewline.hostStdoutFile,
        "https://staged.example.com\n",
        "utf8",
      );

      const withNewlineRes = await runDeploy(hWithNewline, [hWithNewline.commit2], {
        SOUS_LIVE_URL: liveSrv2.url,
      });
      expect(withNewlineRes.status).toBe(0);
      expect(withNewlineRes.stdout).toContain(
        "https://staged.example.com\nStaged URL: https://staged.example.com\n",
      );
      expect(withNewlineRes.stdout).not.toContain(
        "https://staged.example.com\n\nStaged URL:",
      );
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DEPLOY-25: real run with SOUS_EXPECT_SIGN_IN=off passes SMOKE_EXPECT_SIGN_IN=off to both smoke calls",
    async () => {
      const h = makeHarness();
      recordPass(h, h.commit2);
      recordRelease(h, 4, h.commit1, "https://previous.example.com");
      const liveSrv = await makeLiveServer(h, h.commit1);
      await makeStagedServer(h, h.commit1);

      const res = await runDeploy(h, [h.commit2], {
        SOUS_LIVE_URL: liveSrv.url,
        SOUS_EXPECT_SIGN_IN: "off",
      });

      expect(res.status).toBe(0);
      const calls = readCallLog(h);
      expect(calls).toHaveLength(5);
      expect(calls[2]).toContain("pnpm --dir app e2e:smoke");
      expect(calls[2]).toContain("SMOKE_BASE_URL=https://staged.example.com");
      expect(calls[2]).toContain("SMOKE_EXPECT_SIGN_IN=off");
      expect(calls[4]).toContain("pnpm --dir app e2e:smoke");
      expect(calls[4]).toContain(`SMOKE_BASE_URL=${liveSrv.url}`);
      expect(calls[4]).toContain("SMOKE_EXPECT_SIGN_IN=off");
    },
    REAL_RUN_TIMEOUT_MS,
  );

  function wrapReleaseCheckPnpmEnvLog(harness: ReleaseCheckHarness): string {
    const envLogFile = path.join(harness.rootDir, "pnpm-e2e-env.log");
    const pnpmPath = path.join(harness.binDir, "pnpm");
    const origPnpmPath = path.join(harness.binDir, "pnpm.orig");
    copyFileSync(pnpmPath, origPnpmPath);
    chmodSync(origPnpmPath, 0o755);
    writeFileSync(
      pnpmPath,
      [
        "#!/usr/bin/env bash",
        "{ set +x; } 2>/dev/null",
        "set -euo pipefail",
        `printf '%s | E2E_APP_PORT=%s | E2E_PG_PORT=%s | E2E_PG_CONTAINER=%s\\n' "$*" "\${E2E_APP_PORT-<unset>}" "\${E2E_PG_PORT-<unset>}" "\${E2E_PG_CONTAINER-<unset>}" >> ${JSON.stringify(envLogFile)}`,
        `exec ${JSON.stringify(origPnpmPath)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(pnpmPath, 0o755);
    return envLogFile;
  }

  it(
    "RCHECK-3: release-check.sh rejects invalid E2E_APP_PORT, E2E_PG_PORT, or E2E_PG_CONTAINER before running any step",
    async () => {
      const invalidCases: Array<{
        varName: "E2E_APP_PORT" | "E2E_PG_PORT" | "E2E_PG_CONTAINER";
        badValue: string;
      }> = [
        { varName: "E2E_APP_PORT", badValue: "80" },
        { varName: "E2E_APP_PORT", badValue: "65536" },
        { varName: "E2E_APP_PORT", badValue: "04131" },
        { varName: "E2E_APP_PORT", badValue: "abc" },
        { varName: "E2E_PG_PORT", badValue: "1023" },
        { varName: "E2E_PG_PORT", badValue: "not-a-port" },
        { varName: "E2E_PG_CONTAINER", badValue: "-leading-dash" },
        { varName: "E2E_PG_CONTAINER", badValue: "bad name" },
      ];

      for (const tc of invalidCases) {
        const h = makeReleaseCheckHarness();
        const res = await runReleaseCheck(h, h.commit1, {
          E2E_APP_PORT: await pickFreePort(),
          [tc.varName]: tc.badValue,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(tc.varName);
        expect(existsSync(h.callLogFile)).toBe(false);
        expect(existsSync(h.passLogFile)).toBe(false);
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "darwin")(
    "RCHECK-4: release-check.sh passes E2E_APP_PORT, E2E_PG_PORT, and E2E_PG_CONTAINER to every step (including cleanup) when set and omits them when unset",
    async () => {
      // Case A: all three unset -> absent from every step and cleanup.
      // Shim the port-4131 probe so this case does not depend on what holds 4131.
      const hUnset = makeReleaseCheckHarness();
      installDefaultPortProbeShim(hUnset);
      const unsetEnvLog = wrapReleaseCheckPnpmEnvLog(hUnset);
      const unsetRes = await runReleaseCheck(hUnset, hUnset.commit1, {
        E2E_APP_PORT: undefined,
        E2E_PG_PORT: undefined,
        E2E_PG_CONTAINER: undefined,
      });
      expect(unsetRes.status).toBe(0);
      const probeShimLines = readFileSync(hUnset.callLogFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("node-port-probe-shim "));
      expect(probeShimLines).toEqual(["node-port-probe-shim port=4131"]);
      const unsetLines = readFileSync(unsetEnvLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(unsetLines.length).toBeGreaterThanOrEqual(13);
      expect(unsetLines.some((line) => line.includes("e2e:db:down"))).toBe(true);
      for (const line of unsetLines) {
        expect(line).toContain("E2E_APP_PORT=<unset>");
        expect(line).toContain("E2E_PG_PORT=<unset>");
        expect(line).toContain("E2E_PG_CONTAINER=<unset>");
      }

      // Case B: all three set -> present with exact values in every step and cleanup.
      const freeAppPort = await pickFreePort();
      const hSet = makeReleaseCheckHarness();
      const setEnvLog = wrapReleaseCheckPnpmEnvLog(hSet);
      const setRes = await runReleaseCheck(hSet, hSet.commit1, {
        E2E_APP_PORT: freeAppPort,
        E2E_PG_PORT: "55741",
        E2E_PG_CONTAINER: "override-pg",
      });
      expect(setRes.status).toBe(0);
      const setLines = readFileSync(setEnvLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(setLines.length).toBeGreaterThanOrEqual(13);
      expect(setLines.some((line) => line.includes("e2e:db:down"))).toBe(true);
      for (const line of setLines) {
        expect(line).toContain(`E2E_APP_PORT=${freeAppPort}`);
        expect(line).toContain("E2E_PG_PORT=55741");
        expect(line).toContain("E2E_PG_CONTAINER=override-pg");
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "darwin")(
    "RCHECK-5: release-check.sh refuses when the override E2E_APP_PORT is busy, and succeeds with an override when default port 4131 is busy",
    async () => {
      // Case A: listener on override port -> refused naming that port before any step runs.
      const busyOverrideServer = net.createServer();
      await new Promise<void>((resolve, reject) => {
        busyOverrideServer.once("error", reject);
        busyOverrideServer.listen(0, "127.0.0.1", () => resolve());
      });
      const busyOverridePort = (busyOverrideServer.address() as AddressInfo).port;

      try {
        const hBusy = makeReleaseCheckHarness();
        const busyRes = await runReleaseCheck(hBusy, hBusy.commit1, {
          E2E_APP_PORT: String(busyOverridePort),
        });
        expect(busyRes.status).not.toBe(0);
        expect(busyRes.stderr).toContain(String(busyOverridePort));
        expect(existsSync(hBusy.callLogFile)).toBe(false);
        expect(existsSync(hBusy.passLogFile)).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) => {
          busyOverrideServer.close((err) => (err ? reject(err) : resolve()));
        });
      }

      // Case B: default port 4131 is busy, but E2E_APP_PORT points to a free port -> succeeds.
      const defaultPortBlocker = net.createServer();
      let boundDefaultPort = false;
      await new Promise<void>((resolve, reject) => {
        defaultPortBlocker.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            resolve();
          } else {
            reject(err);
          }
        });
        defaultPortBlocker.listen(4131, "127.0.0.1", () => {
          boundDefaultPort = true;
          resolve();
        });
      });

      const freeOverridePort = await pickFreePort();

      try {
        const hOverride = makeReleaseCheckHarness();
        const overrideRes = await runReleaseCheck(
          hOverride,
          hOverride.commit1,
          {
            E2E_APP_PORT: freeOverridePort,
            E2E_PG_PORT: "55742",
            E2E_PG_CONTAINER: "port-override-pg",
          },
        );
        expect(overrideRes.status).toBe(0);
        expect(existsSync(hOverride.passLogFile)).toBe(true);
      } finally {
        if (boundDefaultPort) {
          await new Promise<void>((resolve, reject) => {
            defaultPortBlocker.close((err) => (err ? reject(err) : resolve()));
          });
        }
      }
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it.skipIf(process.platform !== "darwin")(
    "RCHECK-6: release-check.sh refuses an existing database container at start or before e2e:db:up and removes only a container it created",
    async () => {
      const readLines = (filePath: string): string[] =>
        existsSync(filePath)
          ? readFileSync(filePath, "utf8")
              .split("\n")
              .filter((line) => line.length > 0)
          : [];

      // Case A: container exists at start -> refuses before any pnpm step and never calls e2e:db:down or docker rm.
      const hStart = makeReleaseCheckHarness();
      writeFileSync(hStart.dockerExistsMarker, "1\n", "utf8");
      const startRes = await runReleaseCheck(hStart, hStart.commit1, {
        E2E_APP_PORT: await pickFreePort(),
        E2E_PG_CONTAINER: "existing-pg",
        E2E_PG_PORT: "55743",
      });
      expect(startRes.status).not.toBe(0);
      expect(startRes.stderr).toContain("existing-pg");
      expect(startRes.stderr).toContain("already exists");
      expect(startRes.stderr).toContain("e2e:db:down");
      expect(startRes.stderr).toContain("E2E_PG_CONTAINER");
      expect(startRes.stderr).toContain("E2E_PG_PORT");
      expect(existsSync(hStart.passLogFile)).toBe(false);
      const startCalls = readLines(hStart.callLogFile);
      expect(startCalls).toEqual(["docker container inspect existing-pg"]);
      expect(startCalls.some((line) => line.startsWith("pnpm "))).toBe(false);
      expect(startCalls.some((line) => line.includes("e2e:db:down"))).toBe(false);
      expect(startCalls.some((line) => line.includes("docker rm"))).toBe(false);

      // Case B: container appears between start and the db step -> refuses before e2e:db:up and never calls e2e:db:down.
      const hAppear = makeReleaseCheckHarness();
      writeFileSync(hAppear.createDockerOnStepMarker, "build", "utf8");
      const appearRes = await runReleaseCheck(hAppear, hAppear.commit1, {
        E2E_APP_PORT: await pickFreePort(),
        E2E_PG_CONTAINER: "appeared-pg",
        E2E_PG_PORT: "55744",
      });
      expect(appearRes.status).not.toBe(0);
      expect(appearRes.stderr).toContain("appeared-pg");
      expect(appearRes.stderr).toContain("already exists");
      expect(appearRes.stderr).toContain("e2e:db:down");
      expect(existsSync(hAppear.passLogFile)).toBe(false);
      const appearCalls = readLines(hAppear.callLogFile);
      expect(
        appearCalls.filter(
          (line) => line === "docker container inspect appeared-pg",
        ),
      ).toHaveLength(2);
      expect(appearCalls.some((line) => line.includes(" build "))).toBe(true);
      expect(appearCalls.some((line) => line.includes("e2e:db:up"))).toBe(false);
      expect(appearCalls.some((line) => line.includes("e2e:db:down"))).toBe(false);
      expect(appearCalls.some((line) => line.includes("docker rm"))).toBe(false);

      // Case C: normal run checks twice, passes E2E_PG_OWNER only to e2e:db:up,
      // runs every docker call with a clean environment, and removes the
      // container in cleanup because its owner label matches.
      const hOk = makeReleaseCheckHarness();
      const okRes = await runReleaseCheck(hOk, hOk.commit1, {
        E2E_APP_PORT: await pickFreePort(),
        E2E_PG_CONTAINER: "clean-pg",
        E2E_PG_PORT: "55745",
        DOCKER_HOST: "tcp://127.0.0.1:23750",
        DOCKER_CONTEXT: "leaked-context",
      });
      expect(okRes.status).toBe(0);
      expect(existsSync(hOk.passLogFile)).toBe(true);
      const okCalls = readLines(hOk.callLogFile);
      expect(
        okCalls.filter((line) => line === "docker container inspect clean-pg"),
      ).toHaveLength(2);
      expect(
        okCalls.some(
          (line) =>
            line.startsWith("docker container inspect --format ") &&
            line.includes("sous.e2e.owner") &&
            line.endsWith(" clean-pg"),
        ),
      ).toBe(true);
      expect(okCalls.some((line) => line.includes("e2e:db:up"))).toBe(true);
      expect(okCalls.some((line) => line.includes("e2e:db:down"))).toBe(true);
      expect(existsSync(hOk.dockerExistsMarker)).toBe(false);

      const ownerLines = readLines(hOk.pnpmOwnerLogFile);
      const dbUpOwnerLines = ownerLines.filter((line) =>
        line.includes("e2e:db:up"),
      );
      expect(dbUpOwnerLines).toHaveLength(1);
      expect(dbUpOwnerLines[0]).toMatch(
        /\| E2E_PG_OWNER=[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
      );
      const nonDbUpOwnerLines = ownerLines.filter(
        (line) => !line.includes("e2e:db:up"),
      );
      expect(nonDbUpOwnerLines.length).toBeGreaterThanOrEqual(12);
      for (const line of nonDbUpOwnerLines) {
        expect(line).toContain("| E2E_PG_OWNER=<unset>");
      }

      const dockerEnvLines = readLines(hOk.dockerEnvLogFile);
      expect(dockerEnvLines).toHaveLength(3);
      for (const line of dockerEnvLines) {
        expect(line).toBe("DOCKER_HOST=<unset> | DOCKER_CONTEXT=<unset>");
      }

      // Case D1: when e2e:db:up fails and the container carries another
      // owner's label, cleanup must not call e2e:db:down.
      const hOtherOwner = makeReleaseCheckHarness();
      writeFileSync(hOtherOwner.createDockerOnStepMarker, "e2e:db:up", "utf8");
      writeFileSync(
        hOtherOwner.dockerOwnerOnStepMarker,
        "other-run-owner-99\n",
        "utf8",
      );
      writeFileSync(hOtherOwner.failStepMarker, "e2e:db:up", "utf8");
      const otherOwnerRes = await runReleaseCheck(
        hOtherOwner,
        hOtherOwner.commit1,
        {
          E2E_APP_PORT: await pickFreePort(),
          E2E_PG_CONTAINER: "raced-pg",
          E2E_PG_PORT: "55746",
        },
      );
      expect(otherOwnerRes.status).not.toBe(0);
      expect(existsSync(hOtherOwner.passLogFile)).toBe(false);
      const otherOwnerCalls = readLines(hOtherOwner.callLogFile);
      expect(otherOwnerCalls.some((line) => line.includes("e2e:db:up"))).toBe(
        true,
      );
      expect(
        otherOwnerCalls.some(
          (line) =>
            line.startsWith("docker container inspect --format ") &&
            line.includes("sous.e2e.owner") &&
            line.endsWith(" raced-pg"),
        ),
      ).toBe(true);
      expect(otherOwnerCalls.some((line) => line.includes("e2e:db:down"))).toBe(
        false,
      );
      expect(existsSync(hOtherOwner.dockerExistsMarker)).toBe(true);

      // Case D2: when e2e:db:up fails after creating the container with this
      // run's label, and when a later step (e2e) fails, cleanup calls e2e:db:down.
      for (const failCmd of ["e2e:db:up", "e2e"] as const) {
        const hAfter = makeReleaseCheckHarness();
        writeFileSync(hAfter.failStepMarker, failCmd, "utf8");
        const afterRes = await runReleaseCheck(hAfter, hAfter.commit1, {
          E2E_APP_PORT: await pickFreePort(),
          E2E_PG_CONTAINER: "cleanup-pg",
          E2E_PG_PORT: "55746",
        });
        expect(afterRes.status).not.toBe(0);
        expect(existsSync(hAfter.passLogFile)).toBe(false);
        const afterCalls = readLines(hAfter.callLogFile);
        expect(afterCalls.some((line) => line.includes("e2e:db:up"))).toBe(true);
        expect(afterCalls.some((line) => line.includes("e2e:db:down"))).toBe(true);
        expect(existsSync(hAfter.dockerExistsMarker)).toBe(false);
      }

      // Case E: a step failing before the db step never calls e2e:db:down.
      const hBefore = makeReleaseCheckHarness();
      writeFileSync(hBefore.failStepMarker, "build", "utf8");
      const beforeRes = await runReleaseCheck(hBefore, hBefore.commit1, {
        E2E_APP_PORT: await pickFreePort(),
        E2E_PG_CONTAINER: "before-db-pg",
        E2E_PG_PORT: "55747",
      });
      expect(beforeRes.status).not.toBe(0);
      expect(existsSync(hBefore.passLogFile)).toBe(false);
      const beforeCalls = readLines(hBefore.callLogFile);
      expect(beforeCalls.some((line) => line.includes(" build "))).toBe(true);
      expect(beforeCalls.some((line) => line.includes("e2e:db:up"))).toBe(false);
      expect(beforeCalls.some((line) => line.includes("e2e:db:down"))).toBe(false);
    },
    REAL_RUN_TIMEOUT_MS,
  );

  it(
    "DBUP-1: app/e2e/db-up.sh enforces E2E_PG_OWNER validation, labels new containers, refuses existing containers when set, and preserves existing behaviour when unset",
    async () => {
      interface DbUpHarness {
        rootDir: string;
        binDir: string;
        callLogFile: string;
        pnpmLogFile: string;
        existsMarker: string;
        stateFile: string;
        runFailMarker: string;
      }

      function makeDbUpHarness(): DbUpHarness {
        const rootDir = mkdtempSync(path.join(os.tmpdir(), "sous-dbup-test-"));
        cleanupDirs.push(rootDir);
        const binDir = path.join(rootDir, "bin");
        const callLogFile = path.join(rootDir, "docker-calls.log");
        const pnpmLogFile = path.join(rootDir, "pnpm-calls.log");
        const existsMarker = path.join(rootDir, "container-exists.marker");
        const stateFile = path.join(rootDir, "container-state.txt");
        const runFailMarker = path.join(rootDir, "docker-run-fail.marker");
        mkdirSync(binDir, { recursive: true });

        const fakeDocker = path.join(binDir, "docker");
        writeFileSync(
          fakeDocker,
          [
            "#!/usr/bin/env bash",
            "{ set +x; } 2>/dev/null",
            "set -euo pipefail",
            `printf 'docker %s\\n' "$*" >> "${callLogFile}"`,
            'subcmd="${1:-}"',
            'case "${subcmd}" in',
            "  info)",
            "    exit 0",
            "    ;;",
            "  inspect)",
            "    shift",
            '    has_format=0',
            '    while [ "$#" -gt 0 ]; do',
            '      case "$1" in',
            "        --format|-f) has_format=1; shift 2 ;;",
            "        --format=*) has_format=1; shift ;;",
            "        *) shift ;;",
            "      esac",
            "    done",
            `    if [ ! -e "${existsMarker}" ]; then`,
            '      printf "Error: No such object\\n" >&2',
            "      exit 1",
            "    fi",
            '    if [ "${has_format}" -eq 1 ]; then',
            `      if [ -f "${stateFile}" ]; then`,
            `        cat "${stateFile}"`,
            "      else",
            '        printf "false||\\n"',
            "      fi",
            "    else",
            '      printf "[{}]\\n"',
            "    fi",
            "    exit 0",
            "    ;;",
            "  rm)",
            `    rm -f "${existsMarker}" "${stateFile}"`,
            "    exit 0",
            "    ;;",
            "  run)",
            `    if [ -e "${runFailMarker}" ]; then`,
            '      printf "docker: Error response from daemon: Conflict. Container name already in use.\\n" >&2',
            "      exit 1",
            "    fi",
            `    printf "1\\n" > "${existsMarker}"`,
            '    printf "fake-container-id\\n"',
            "    exit 0",
            "    ;;",
            "  exec)",
            "    exit 0",
            "    ;;",
            "  *)",
            '    printf "fake docker: unexpected command %s\\n" "$*" >&2',
            "    exit 1",
            "    ;;",
            "esac",
            "",
          ].join("\n"),
          "utf8",
        );
        chmodSync(fakeDocker, 0o755);

        const fakePnpm = path.join(binDir, "pnpm");
        writeFileSync(
          fakePnpm,
          [
            "#!/usr/bin/env bash",
            "{ set +x; } 2>/dev/null",
            "set -euo pipefail",
            `printf 'pnpm %s | DATABASE_URL=%s\\n' "$*" "\${DATABASE_URL-<unset>}" >> "${pnpmLogFile}"`,
            "exit 0",
            "",
          ].join("\n"),
          "utf8",
        );
        chmodSync(fakePnpm, 0o755);

        return {
          rootDir,
          binDir,
          callLogFile,
          pnpmLogFile,
          existsMarker,
          stateFile,
          runFailMarker,
        };
      }

      function runDbUp(
        harness: DbUpHarness,
        envOverrides: Record<string, string | undefined>,
      ): RunResult {
        const env: NodeJS.ProcessEnv = {
          PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
          HOME: harness.rootDir,
          E2E_APP_PORT: "4145",
          E2E_PG_PORT: "55745",
          E2E_PG_CONTAINER: "dbup-test-pg",
        };
        for (const [k, v] of Object.entries(envOverrides)) {
          if (v === undefined) {
            delete env[k];
          } else {
            env[k] = v;
          }
        }
        const res = spawnSync("sh", [DB_UP_SCRIPT_SRC], {
          cwd: REPO_ROOT,
          env,
          encoding: "utf8",
        });
        return {
          status: res.status,
          stdout: res.stdout,
          stderr: res.stderr,
        };
      }

      const readLines = (filePath: string): string[] =>
        existsSync(filePath)
          ? readFileSync(filePath, "utf8")
              .split("\n")
              .filter((line) => line.length > 0)
          : [];

      // Case 1: invalid E2E_PG_OWNER is refused before any docker call.
      const invalidOwners = [
        "-leading-dash",
        ".leading-dot",
        "_leading-underscore",
        "has space",
        "has/slash",
        "has:colon",
        "has=equals",
        "a".repeat(129),
      ];
      for (const badOwner of invalidOwners) {
        const h = makeDbUpHarness();
        const res = runDbUp(h, { E2E_PG_OWNER: badOwner });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("E2E_PG_OWNER");
        expect(existsSync(h.callLogFile)).toBe(false);
        expect(existsSync(h.pnpmLogFile)).toBe(false);
      }

      // Case 2: E2E_PG_OWNER set and container already exists (matching or
      // mismatched) -> exits 1 and never calls docker rm, docker run, docker
      // exec, or pnpm.
      for (const existingState of [
        "true|127.0.0.1:55745|trust\n",
        "false|127.0.0.1:55799|\n",
      ]) {
        const h = makeDbUpHarness();
        writeFileSync(h.existsMarker, "1\n", "utf8");
        writeFileSync(h.stateFile, existingState, "utf8");
        const res = runDbUp(h, { E2E_PG_OWNER: "run-owner.1_abc" });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("dbup-test-pg");
        expect(res.stderr).toContain("already exists");
        const dockerCalls = readLines(h.callLogFile);
        expect(dockerCalls.some((line) => line.startsWith("docker rm"))).toBe(
          false,
        );
        expect(dockerCalls.some((line) => line.startsWith("docker run"))).toBe(
          false,
        );
        expect(dockerCalls.some((line) => line.startsWith("docker exec"))).toBe(
          false,
        );
        expect(existsSync(h.pnpmLogFile)).toBe(false);
      }

      // Case 3: E2E_PG_OWNER set and no container -> calls docker run with
      // --label sous.e2e.owner=<value> (including 128-char boundary).
      for (const validOwner of ["run-owner.1_abc", "a".repeat(128)]) {
        const h = makeDbUpHarness();
        const res = runDbUp(h, { E2E_PG_OWNER: validOwner });
        expect(res.status).toBe(0);
        const dockerCalls = readLines(h.callLogFile);
        const runCall = dockerCalls.find((line) =>
          line.startsWith("docker run "),
        );
        expect(runCall).toBeDefined();
        expect(runCall).toContain(`--label sous.e2e.owner=${validOwner}`);
        expect(runCall).toContain("--name dbup-test-pg");
        expect(dockerCalls.some((line) => line.startsWith("docker rm"))).toBe(
          false,
        );
        expect(readLines(h.pnpmLogFile)).toEqual([
          "pnpm db:migrate | DATABASE_URL=postgres://postgres@127.0.0.1:55745/sous_e2e",
        ]);
      }

      // Case 3b: E2E_PG_OWNER set and docker run fails on a name conflict race
      // -> exits 1 without calling docker rm, docker exec, or pnpm.
      const hRace = makeDbUpHarness();
      writeFileSync(hRace.runFailMarker, "1\n", "utf8");
      const raceRes = runDbUp(hRace, { E2E_PG_OWNER: "run-owner-race" });
      expect(raceRes.status).toBe(1);
      const raceCalls = readLines(hRace.callLogFile);
      expect(
        raceCalls.some(
          (line) =>
            line.startsWith("docker run ") &&
            line.includes("--label sous.e2e.owner=run-owner-race"),
        ),
      ).toBe(true);
      expect(raceCalls.some((line) => line.startsWith("docker rm"))).toBe(false);
      expect(raceCalls.some((line) => line.startsWith("docker exec"))).toBe(
        false,
      );
      expect(existsSync(hRace.pnpmLogFile)).toBe(false);

      // Case 4a: without E2E_PG_OWNER and no container -> creates without label.
      const hCreate = makeDbUpHarness();
      const createRes = runDbUp(hCreate, { E2E_PG_OWNER: undefined });
      expect(createRes.status).toBe(0);
      const createCalls = readLines(hCreate.callLogFile);
      const createRun = createCalls.find((line) =>
        line.startsWith("docker run "),
      );
      expect(createRun).toBeDefined();
      expect(createRun).not.toContain("--label");
      expect(createCalls.some((line) => line.startsWith("docker rm"))).toBe(
        false,
      );
      expect(readLines(hCreate.pnpmLogFile)).toHaveLength(1);

      // Case 4b: without E2E_PG_OWNER and existing matching container -> reuses
      // without docker rm or docker run.
      const hReuse = makeDbUpHarness();
      writeFileSync(hReuse.existsMarker, "1\n", "utf8");
      writeFileSync(hReuse.stateFile, "true|127.0.0.1:55745|trust\n", "utf8");
      const reuseRes = runDbUp(hReuse, { E2E_PG_OWNER: undefined });
      expect(reuseRes.status).toBe(0);
      const reuseCalls = readLines(hReuse.callLogFile);
      expect(reuseCalls.some((line) => line.startsWith("docker rm"))).toBe(
        false,
      );
      expect(reuseCalls.some((line) => line.startsWith("docker run"))).toBe(
        false,
      );
      expect(reuseCalls.some((line) => line.startsWith("docker exec"))).toBe(
        true,
      );
      expect(readLines(hReuse.pnpmLogFile)).toHaveLength(1);

      // Case 4c: without E2E_PG_OWNER and existing mismatched container ->
      // removes and recreates without label.
      const hReplace = makeDbUpHarness();
      writeFileSync(hReplace.existsMarker, "1\n", "utf8");
      writeFileSync(hReplace.stateFile, "false|127.0.0.1:55799|\n", "utf8");
      const replaceRes = runDbUp(hReplace, { E2E_PG_OWNER: undefined });
      expect(replaceRes.status).toBe(0);
      const replaceCalls = readLines(hReplace.callLogFile);
      expect(replaceCalls).toContain("docker rm -f dbup-test-pg");
      const replaceRun = replaceCalls.find((line) =>
        line.startsWith("docker run "),
      );
      expect(replaceRun).toBeDefined();
      expect(replaceRun).not.toContain("--label");
      expect(readLines(hReplace.pnpmLogFile)).toHaveLength(1);
    },
    REAL_RUN_TIMEOUT_MS,
  );
});
