import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // tsconfig's "@/*" path, so modules that import through it load in tests.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    hookTimeout: 30_000,
    // Agent worktrees are full checkouts, each tested from its own root; from
    // here their "@/" imports would resolve into this checkout's src.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
