import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config";

export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    include: ["tests/doltlite/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
