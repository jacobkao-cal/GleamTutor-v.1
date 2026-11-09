import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Real-browser end-to-end tests (system Chrome via puppeteer-core) against the
// production build. Run: npm run build && npm run e2e
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
