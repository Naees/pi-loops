import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  test: {
    include: ["scripts/proactive-runtime.fixture.ts"],
  },
});
