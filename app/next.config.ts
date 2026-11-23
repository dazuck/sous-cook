import { randomBytes } from "node:crypto";
import path from "node:path";
import type { NextConfig } from "next";

// The app builds from inside a monorepo: the shared pack schema lives at the
// repo root (`../pack`, slice B3), so Turbopack's resolution boundary and the
// server file tracer both start at the repo root, not at `app/`. Without this,
// a workspace import of `@sous/pack` fails with "Can't resolve".
const repoRoot = path.resolve(__dirname, "..");

// The build a cook report names (B2 decision 5): Next's build id, chosen here
// so the client can carry it, as the app router doesn't hand it over. The
// build evaluates this file in more than one process; the first one's id goes
// into the environment its workers inherit, so every bundle bakes in the one
// `.next/BUILD_ID` holds. The diary maps it to the commit.
process.env.SOUS_BUILD_ID ??= `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;
const buildId = process.env.SOUS_BUILD_ID;

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // The shelf reads pack files from ../packs at request time (slice S,
  // lib/shelf/load.ts), which the tracer can't see from an fs read, so the
  // tRPC function carries them explicitly. A pack missing from the deployed
  // function is left off the shelf and logged; the staged check looks for
  // both packs before promote. The packs' reviewed cook plans
  // (`pack-plans/`, slice P) are read the same way, by a queue add.
  outputFileTracingIncludes: {
    "/api/trpc/[trpc]": ["../packs/**/*.json", "./pack-plans/**/*.json"],
    "/api/packs": ["../packs/**/*.json"],
    "/api/kitchen-queue": ["../packs/**/*.json", "./pack-plans/**/*.json"],
  },
  generateBuildId: () => buildId,
  env: { SOUS_BUILD_ID: buildId },
  async redirects() {
    return [
      { source: "/", destination: "/kitchen", permanent: false },
      // The library became the Cookpacks shelf (slice S, S-D15): an old
      // ?browse=true link lands there. Next passes the query through, so the
      // shelf drops it from the URL; a ?browse=true&import=true link's import
      // isn't opened (decided).
      {
        source: "/kitchen",
        has: [{ type: "query", key: "browse", value: "true" }],
        destination: "/kitchen/cookpacks",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
