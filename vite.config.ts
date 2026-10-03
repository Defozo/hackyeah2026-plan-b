import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localPwa } from "./scripts/pwa-plugin.ts";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: "apps/web",
  plugins: [react(), localPwa()],
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
  server: {
    watch: {
      ignored: [
        "**/docs/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/*.test.ts",
      ],
    },
    proxy: {
      "/api": "http://127.0.0.1:8791",
      "/health": "http://127.0.0.1:8791",
    },
  },
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:8791",
      "/health": "http://127.0.0.1:8791",
    },
  },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  worker: { format: "es" },
});
