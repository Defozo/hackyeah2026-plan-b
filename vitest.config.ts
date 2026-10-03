import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@planb/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url),
      ),
      "@planb/importers": fileURLToPath(
        new URL("./packages/importers/src/index.ts", import.meta.url),
      ),
    },
  },
});
