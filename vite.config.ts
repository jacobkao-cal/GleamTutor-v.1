/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => ({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // App tests only. The tracing engine has its own Node suite: npm run tracer:test
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
