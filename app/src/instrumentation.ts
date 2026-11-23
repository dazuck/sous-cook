/**
 * Next.js server instrumentation entry point. Loads the Node.js startup check
 * dynamically only in the Node.js server runtime so Edge bundles never pull in
 * Node-only APIs such as `process.exit`. Skipped outside the Node.js runtime
 * and during `next build`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return;
    }
    const { checkDeploymentOnStartup } = await import("./instrumentation-node");
    checkDeploymentOnStartup();
  }
}
