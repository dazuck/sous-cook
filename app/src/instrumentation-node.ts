import {
  DeploymentConfigError,
  checkDeploymentEnv,
} from "@/lib/kitchens/deployment";

/**
 * Validates deployment mode, required sign-in environment variables, and hook
 * configuration once when the Node.js server starts. Exits with status 1 on
 * configuration errors so the server does not listen with an invalid
 * configuration.
 */
export function checkDeploymentOnStartup(): void {
  try {
    checkDeploymentEnv();
  } catch (err) {
    if (err instanceof DeploymentConfigError) {
      console.error(`[deployment] ${err.logMessage}`);
      process.exit(1);
      return;
    }
    throw err;
  }
}
