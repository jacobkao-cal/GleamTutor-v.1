import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from the app's test suite: these tests need the downloaded toolchain
// (npm run tracer:setup) and run in Node, not jsdom.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
