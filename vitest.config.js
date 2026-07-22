import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["hooks/**/*.mjs"],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 85,
      },
    },
  },
});
