import { NextResponse } from "next/server";

export const dynamic = "force-static";

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;

function resolveReleaseCommit(raw: string | undefined): string | null {
  if (raw !== undefined && FULL_COMMIT_RE.test(raw)) {
    return raw;
  }
  return null;
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    commit: resolveReleaseCommit(process.env.SOUS_RELEASE_COMMIT),
  });
}
