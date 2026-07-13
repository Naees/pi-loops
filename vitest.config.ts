import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 15_000 : 10_000,
  },
});
